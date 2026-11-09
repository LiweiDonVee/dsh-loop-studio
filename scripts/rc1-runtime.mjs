import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.DSH_LOOP_EVIDENCE_ROOT ?? join(repo, 'artifacts/native-routing'))
if (!process.env.DSH_RUNTIME_DIR) throw new Error('Set DSH_RUNTIME_DIR to the exact DSH runtime package root (containing node_modules).')
const runtime = resolve(process.env.DSH_RUNTIME_DIR)
const product = resolve(process.env.DSH_LOOP_PRODUCT ?? join(repo, 'dist/host.js'))
await mkdir(output, { recursive: true })
const moduleOf = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const [{ Context }, { default: LlmRuntime, LlmAdapter, createUserMessage }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, { default: Agents }, { default: Loop }, native] = await Promise.all([moduleOf('cordis'), moduleOf('dsh-llm'), moduleOf('dsh-session'),
  moduleOf('dsh-session-projection'), moduleOf('dsh-system-prompt'), moduleOf('dsh-tools'), moduleOf('dsh-agent'),
  moduleOf('dsh-agent-loop'), moduleOf('dsh-tool-executor-native')])
const route = (model, maxTokens) => ({ provider: 'product-fixture', model, ...(maxTokens === undefined ? {} : { maxTokens }) })
const prompt = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function fixture(name, { action, seed, home: priorHome, journal, persistence = false, resume = false, mountProduct = true, initialMaxTokens = 512 } = {}) {
  const home = priorHome ?? join(output, `product-${name}-${Date.now()}`)
  await mkdir(home, { recursive: true })
  const ctx = new Context(), result = { name, home, requests: [], errors: [] }
  let agent, host, turn = 0, step = 0
  for (const plugin of [LlmRuntime, Sessions, Projections, Prompt, Tools, Agents]) await ctx.plugin(plugin)
  await ctx.plugin(native)
  if (persistence) await ctx.plugin(await moduleOf('dsh-session-persistence-jsonl'), { root: join(home, 'sessions'), compression: 'none' })
  await ctx.plugin(Loop, { agents: [] })
  class Adapter extends LlmAdapter {
    resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }) }
    async *stream(options) {
      result.requests.push({ turn, step, model: options.model, maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort })
      await action?.({ agent, host, options, result, turn, step, save })
      if (options.signal?.aborted) return
      if (step === 1) {
        const id = `${name}-${turn}-${step}`, block = { type: 'tool-call', id, name: 'fixture_tool', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'PRODUCT_LOCAL_DONE' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRODUCT_LOCAL_DONE' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['product-fixture'], new Adapter())
  ctx.tools.register({ name: 'fixture_tool', description: 'Synthetic local fixture.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"ok":true}' }] },
    execute: async () => ({ ok: true }), isConcurrencySafe: () => true })
  const handle = resume ? await ctx.agents.resume({ resumeSessionId: `product-${name}`, agentOptions: route('baseline', initialMaxTokens === null ? undefined : initialMaxTokens) }) : await ctx.agents.create({ sessionId: `product-${name}`, ...(seed ? { seed } : {}), agentOptions: route('baseline', initialMaxTokens === null ? undefined : initialMaxTokens) })
  agent = handle.agent
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start') { turn = event.data.turn; step = 0 }
    if (event.type === 'step/start') step = event.data.step
  })
  ctx.on('agent/error', payload => result.errors.push({ message: payload.error.message, code: payload.error.code }))
  ctx.provide('connection', { browserPeer: { principal: { kind: 'owner' } } })
  ctx.provide('typertGateway', { stream: async request => (async function* () {
    assert.equal(request.args.request.address.sessionId, agent.id)
    yield { type: 'snapshot', header: agent.session.header, records: agent.session.snapshotEvents().map(event => ({ type: 'event', event })),
      cursor: agent.session.snapshotEvents().at(-1)?.seq ?? -1, hasMore: false }
  })() })
  const savedEnvironment = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { if (mountProduct) { const { createLoopHost } = await import(pathToFileURL(product).href); host = await createLoopHost(ctx, { ...(journal ? { journal } : {}), journalOptions: { home } }) } }
  finally { if (savedEnvironment === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedEnvironment }
  const save = async (routes, enabled = true) => {
    const before = await host.inspect(agent.id)
    return host.savePolicy({ sessionId: agent.id, scope: 'session', expectedRevision: before.revision, policy: { enabled, routes } })
  }
  return { ctx, host, agent, result, save,
    async run(text) { agent.followup(prompt(text)); await agent.whenIdle() },
    async finish({ closeHost = true } = {}) {
      result.events = agent.session.snapshotEvents()
      result.selection = agent.model.current()
      if (closeHost) result.diagnostics = (await host.inspect(agent.id)).diagnostics
      if (closeHost) await host.close()
      result.afterClose = agent.model.current()
      await handle.dispose(); await ctx.fiber.dispose()
      return result
    },
  }
}


export { fixture, output, product, runtime, route, prompt }
