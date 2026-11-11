import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLoopHost } from '../src/host.mjs'
import { createPolicyStore } from '../src/store.mjs'
import { createRoutingJournal } from '../src/routing-journal.mjs'
import { createStarterExecutionPlan } from '../src/plan.mjs'

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const selection = value => ({ provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) })
class Scope {
  listeners = new Map()
  on(name, fn, options) {
    const list = this.listeners.get(name) ?? []
    if (options?.prepend) list.unshift(fn); else list.push(fn)
    this.listeners.set(name, list)
    return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1) }
  }
  emit(name, ...args) { for (const fn of this.listeners.get(name)?.slice() ?? []) fn(...args) }
  async waterfall(name, args, initial) {
    const list = [...this.listeners.get(name) ?? []]
    const next = async index => index < list.length ? list[index](...args, () => next(index + 1)) : initial
    return next(0)
  }
}
class ReactLoopAgent {
  constructor(root, id) {
    this.id = id; this.ctx = new Scope(); this.status = 'idle'
    this.options = { provider: 'fixture', model: 'baseline', maxTokens: 512 }
    this.records = []; this.pending = null; this.lastUsed = null
    this.preparedRequest = false
    this.session = { id, header: { id, agentPreset: 'standard' }, snapshotEvents: () => this.records,
      requestHeader: () => this.header, append: (type, data) => {
        if (this.publishing) throw new Error('session append cannot reenter')
        const event = { type, data: structuredClone(data), seq: this.records.length, time: Date.now() }
        this.records.push(event)
        if (type === 'model/selection') this.pending = selection(data)
        if (type === 'request/header') {
          this.header = structuredClone(data.header); this.lastUsed = selection(data.header.config)
          if (equal(this.pending, this.lastUsed)) this.pending = null
        }
        this.publishing = true
        try { root.emit('session/event', this.session, event); this.ctx.emit('session/event', this.session, event) }
        finally { this.publishing = false }
        return event
      } }
    this.model = { current: () => structuredClone(this.pending ?? this.lastUsed ?? selection(this.options)),
      select: value => { if (!equal(this.pending ?? this.lastUsed, selection(value))) this.session.append('model/selection', selection(value)) } }
  }
}
const first = { provider: 'fixture', model: 'first', maxTokens: 111 }
const continuation = { provider: 'fixture', model: 'continuation', maxTokens: 222 }
async function fixture(t, options = {}) {
  const ctx = new Scope(), home = await mkdtemp(join(tmpdir(), 'loop-rc1-unit-'))
  const agents = new Map(['one', 'two'].map(id => [id, new ReactLoopAgent(ctx, id)]))
  if (options.defaultCap) for (const agent of agents.values()) {
    delete agent.options.maxTokens
    agent.session.append('request/header', { reason: 'change', header: { config: { provider: 'fixture', model: 'baseline', maxTokens: 256 }, tools: [] } })
  }
  ctx.agents = { list: () => [...agents.values()], get: id => agents.get(id) }
  ctx.connection = { browserPeer: { principal: { kind: 'owner' } } }
  ctx.llm = { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'first', name: 'First' }], resolveModelInfo: async () => ({}) }
  const services = { agentLoop: {}, agentPresets: { inspectCompositions: () => [{ id: 'standard' }], compositionInventory: async () => [{ id: 'standard', isDefault: true, rows: [] }] } }
  ctx.get = name => services[name]
  ctx.typertGateway = { stream: async request => (async function* () {
    assert.equal(request.peer, ctx.connection.browserPeer)
    const agent = agents.get(request.args.request.address.sessionId)
    yield { type: 'snapshot', header: agent.session.header, records: agent.records.map(event => ({ type: 'event', event })), cursor: agent.records.length - 1, hasMore: false }
  })() }
  const store = await createPolicyStore({ home }), journal = options.journal ?? createRoutingJournal({ home })
  const host = await createLoopHost(ctx, { store, journal, structures: options.structures })
  t.after(async () => { await host.close(); await rm(home, { recursive: true, force: true }) })
  let revision = 0
  const save = async (routes, enabled = true, extra = {}) => {
    const value = await host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: revision, policy: { enabled, routes }, ...extra })
    revision = value.revision
  }
  return { ctx, agents, host, home, journal, save }
}
async function prepare(agent, turn, step, { claimed = true } = {}) {
  if (step === 1) agent.session.append('turn/start', { turn })
  if (claimed) agent.ctx.emit('agent/inbox/claimed', { agent, turn, message: { id: 'fixture' } })
  const fixed = agent.model.current(), signal = new AbortController().signal
  await agent.ctx.waterfall('system-prompt/assemble', [{}, { agent, signal, modelSelection: fixed }], { variables: { ...fixed }, sections: [] })
  await agent.ctx.waterfall('agent/pre-step', [{ agent, turn, step, signal, modelSelection: fixed }], { kind: 'enter', messages: [{}] })
  agent.session.append('step/start', { turn, step })
  return async () => {
    const controls = agent.preparedRequest ? agent.header?.config : agent.options
    const config = await agent.ctx.waterfall('agent/request', [{ agent, turn, step, signal }], { ...controls, ...fixed })
    assert.deepEqual(selection(config), fixed)
    const header = agent.adapterDefaultCap && config.maxTokens === undefined
      ? { config: { ...config, maxTokens: agent.adapterDefaultCap }, tools: [], adapterDefaults: { maxTokens: true } }
      : { config, tools: [] }
    agent.session.append('request/header', { reason: 'change', header })
    agent.preparedRequest = true
    return config
  }
}
test('rc.1 first and empty-inbox continuation use durable selection without affecting other agents', async t => {
  const { host, agents, save } = await fixture(t), agent = agents.get('one')
  await save({ 'host.first': first, 'host.continuation': continuation })
  assert.deepEqual(await (await prepare(agent, 1, 1))(), first)
  agent.ctx.emit('tools/result', {})
  agent.session.append('step/end', { turn: 1, step: 1 })
  assert.deepEqual(await (await prepare(agent, 1, 2, { claimed: false }))(), continuation)
  assert.equal(agents.get('two').model.current().model, 'baseline')
  assert.equal((await host.inspect('one')).routingCapability, 'supported')
})
test('same-step retry keeps its identity and cap after a policy edit', async t => {
  const { agents, save } = await fixture(t), agent = agents.get('one')
  await save({ 'host.first': first, 'host.continuation': continuation })
  const request = await prepare(agent, 1, 1)
  await save({ 'host.first': { ...first, model: 'edited', maxTokens: 333 }, 'host.continuation': continuation })
  assert.deepEqual(await request(), first)
  assert.deepEqual(await request(), first)
})
test('session disable restores the original user selection', async t => {
  const { agents, save } = await fixture(t), agent = agents.get('one')
  await save({ 'host.first': first, 'host.continuation': continuation })
  await (await prepare(agent, 1, 1))()
  await save({}, false)
  assert.equal(agent.model.current().model, 'baseline')
})
test('active unload preserves the captured request and restores future model and cap', async t => {
  const { agents, save, host } = await fixture(t), agent = agents.get('one')
  await save({ 'host.first': first, 'host.continuation': continuation })
  const request = await prepare(agent, 1, 1)
  await host.close()
  assert.equal(agent.model.current().model, 'baseline')
  assert.deepEqual(await request(), first)
  agent.session.append('step/end', { turn: 1, step: 1 })
  assert.deepEqual(await (await prepare(agent, 1, 2))(), { provider: 'fixture', model: 'baseline', maxTokens: 512 })
})
test('an external pending selection survives unload', async t => {
  const { agents, save, host } = await fixture(t), agent = agents.get('one')
  await save({ 'host.first': first })
  agent.model.select({ provider: 'fixture', model: 'user-choice' })
  await host.close()
  assert.equal(agent.model.current().model, 'user-choice')
})
test('adapter-default cleanup header releases the final request listener after unload', async t => {
  const { agents, save, host } = await fixture(t, { defaultCap: true }), agent = agents.get('one')
  agent.adapterDefaultCap = 1024
  await save({ 'host.first': { provider: 'fixture', model: 'baseline', maxTokens: 111 } })
  const request = await prepare(agent, 1, 1)
  await host.close(); await request()
  agent.session.append('step/end', { turn: 1, step: 1 })
  await (await prepare(agent, 1, 2))()
  assert.equal(agent.ctx.listeners.get('agent/request').length, 0)
})
test('cold cap-only routing restores adapter default after policy disable', async t => {
  const { agents, save } = await fixture(t, { defaultCap: true }), agent = agents.get('one')
  const cap = { provider: 'fixture', model: 'baseline', maxTokens: 111 }
  await save({ 'host.first': cap, 'host.continuation': cap })
  assert.equal((await (await prepare(agent, 1, 1))()).maxTokens, 111)
  agent.session.append('step/end', { turn: 1, step: 1 })
  await save({}, false)
  assert.equal((await (await prepare(agent, 1, 2))()).maxTokens, undefined)
})
test('journal I/O failure rejects policy refresh and the next step', async t => {
  const { agents, save } = await fixture(t, { journal: { read: () => null, write() { throw new Error('journal fixture failure') }, clear() {} } })
  await assert.rejects(save({ 'host.first': first }), /journal fixture failure/)
  await assert.rejects(prepare(agents.get('one'), 1, 1), /journal fixture failure/)
})
test('unknown Model drivers remain observe-only', async t => {
  const { ctx, agents, host } = await fixture(t)
  const agent = agents.get('one'); ctx.emit('agent/disposed', { agent }); agent.model = undefined; ctx.emit('agent/created', { agent })
  assert.equal((await host.inspect('one')).routingCapability, 'unknown-driver')
  await assert.rejects(host.savePolicy({ sessionId: 'one', scope: 'session', expectedRevision: 0, policy: { enabled: true, routes: { 'host.first': first } } }), { code: 'unsupported-node' })
})
test('participant routes are namespaced and raw bodies never enter trace metadata', async t => {
  const { host } = await fixture(t)
  const dispose = host.registerParticipant({ id: 'writer', nodes: [{ id: 'render', label: 'Writer', kind: 'model', control: 'route' }] })
  host.recordTrace({ sessionId: 'one', nodeId: 'writer.render', provider: 'fixture', model: 'writer', text: 'PRIVATE_BODY' })
  const detail = await host.inspect('one')
  assert.equal(detail.graph.nodes.find(node => node.id === 'writer.render').control, 'route')
  assert.ok(!JSON.stringify(detail.trace).includes('PRIVATE_BODY'))
  dispose()
})

test('structure operations authorize the current session before reaching the editor', async t => {
  let calls = 0
  const { ctx, host } = await fixture(t, { structures: { listStructures() { calls++; return { drafts: [] } } } })
  assert.deepEqual(await host.listStructures({ sessionId: 'one' }), { drafts: [] })
  ctx.typertGateway.stream = async () => { throw Object.assign(new Error('denied'), { code: 'gateway/forbidden' }) }
  await assert.rejects(host.listStructures({ sessionId: 'two' }), { code: 'gateway/forbidden' })
  assert.equal(calls, 1)
})

test('a bound publication changes live graph and trace IDs without taking over independent participant routes', async t => {
  const { ctx, agents, host, save } = await fixture(t)
  const agent = agents.get('one'), presetId = 'loop-studio.fixture'
  const execution = createStarterExecutionPlan()
  execution.nodes[0].route = { provider: 'fixture', model: 'published' }
  execution.nodes[0].instruction = 'PRIVATE_PLAN_INSTRUCTION'
  const marker = { publication: { presetId, version: 1 }, execution }
  ctx.get('agentPresets').serviceFor = candidate => candidate === agent ? marker : undefined
  ctx.get('agentPresets').compositionInventory = async () => [{ id: presetId, rows: [] }]
  const dispose = host.registerParticipant({ id: 'writer', nodes: [{ id: 'render', label: 'Writer', kind: 'model', control: 'route' }] })
  agent.session.append('agent-preset/selected', { agentPreset: presetId })
  await Promise.resolve()
  const route = { provider: 'fixture', model: 'writer' }
  await save({ 'host.first': first, 'writer.render': route })
  assert.equal(agent.model.current().model, 'baseline')
  assert.deepEqual(host.resolveRoute({ sessionId: 'one', nodeId: 'writer.render' }), route)
  agent.session.append('turn/start', { turn: 1 })
  const detail = await host.inspect('one')
  assert.deepEqual(detail.executionPublication, { presetId, version: 1, mode: 'graph' })
  assert.equal(detail.graph.entryNodeId, 'host.execution.model')
  assert.equal(detail.graph.nodes.find(node => node.id === 'writer.render').control, 'route')
  assert.deepEqual(detail.graph.nodes[0].configuredRoute, execution.nodes[0].route)
  assert.equal(detail.trace.find(item => item.type === 'turn/start').nodeId, detail.graph.entryNodeId)
  assert.equal(detail.trace.find(item => item.type === 'turn/start').graphId, detail.graph.id)
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_PLAN_INSTRUCTION/u)
  dispose()
})
