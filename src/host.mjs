import { randomUUID } from 'node:crypto'
import { buildGraph, mergeParticipants, resolvePolicy, validatePolicy, freeze, modelNodeId, projectTraceEvent, tokenMetadata, LoopError } from './core.mjs'
import { createPolicyStore } from './store.mjs'
import { createLoopRoutes, STRUCTURE_ACTIONS } from './routes.mjs'
import { createRoutingJournal } from './routing-journal.mjs'
import { createAgentRouter } from './routing.mjs'
import { createStructureEditor } from './structures.mjs'
import { EXECUTION_PLAN_SERVICE, EXECUTION_PLAN_ROW_ID } from './plan-publication.mjs'
import { createPlanRuntime } from './plan-runtime.mjs'

export const name = 'loop-studio'
export const inject = ['connection', 'typertGateway', 'agents', 'llm']
const TRACE_LIMIT = 256
const planNodeId = id => `host.execution.${id}`
const planEdgeLabel = { tools: '有工具调用', 'no-tools': '无工具调用', next: '工具完成' }
/** Custom drivers retain observation; the rc.1 driver exposes the Model API. */
function supportedAgent(ctx, agent) {
  return Boolean(ctx.get('agentLoop')) && agent?.constructor?.name === 'ReactLoopAgent'
    && typeof agent.model?.current === 'function' && typeof agent.model?.select === 'function'
}

/** Connect public DSH registries and scoped waterfalls to the independent kernel. */
export async function createLoopHost(ctx, options = {}) {
  const store = options.store ?? await createPolicyStore()
  const journal = options.journal ?? createRoutingJournal(options.journalOptions)
  let stopped = false
  let structures = options.structures
  const attached = new Map()
  const participants = new Map()
  const traces = new Map()
  const sessions = new Map()
  const subscribers = new Map()
  const reads = new Set()
  const disposers = []

  function active() { if (stopped) throw new LoopError('unavailable', 'Loop Studio has been unloaded.', 503) }
  function changed(sessionId) {
    for (const listener of subscribers.get(sessionId) ?? []) listener({ type: 'changed', sessionId })
  }
  function changedAll() { for (const sessionId of subscribers.keys()) changed(sessionId) }
  function graphFor(presetId, supported, publication) {
    const graph = mergeParticipants(buildGraph({ presetId: presetId ?? 'unassigned', supported }), [...participants.values()])
    if (!publication) return graph
    const { execution, publication: { version } } = publication
    const independent = graph.nodes.filter(node => node.source !== 'host')
    const independentIds = new Set(independent.map(node => node.id))
    return { ...graph, id: `${graph.id}:published:${version}`, entryNodeId: planNodeId(execution.entryNodeId),
      nodes: [...execution.nodes.map(node => ({ id: planNodeId(node.id), executionNodeId: node.id, label: node.label,
        kind: node.kind === 'tools' ? 'tool' : node.kind === 'end' ? 'program' : 'model', control: 'observe', source: 'host',
        ...(node.route ? { configuredRoute: node.route } : {}),
      })), ...independent],
      edges: [...execution.edges.map(edge => ({ id: planNodeId(edge.id), from: planNodeId(edge.from), to: planNodeId(edge.to),
        label: planEdgeLabel[edge.when], when: edge.when,
      })), ...graph.edges.filter(edge => independentIds.has(edge.from) && independentIds.has(edge.to))],
    }
  }
  function currentPlan(record) {
    if (!record.presetId?.startsWith('loop-studio.')) return undefined
    const marker = ctx.get('agentPresets')?.serviceFor?.(record.agent, EXECUTION_PLAN_SERVICE)
    return marker?.publication?.presetId === record.presetId ? marker : undefined
  }
  function configureExecution(record) {
    const { agent, supported } = record
    const publication = currentPlan(record)
    if (record.router && record.publication === publication) return
    record.runtime?.close()
    record.router?.close()
    record.runtime = undefined
    record.router = undefined
    record.publication = publication
    if (!supported) return
    const routes = publication && Object.fromEntries(publication.execution.nodes.filter(node => node.route).map(node => [node.id, node.route]))
    record.router = createAgentRouter({ agent, journal, manual: Boolean(publication),
      policy: () => {
        if (publication) return { routes }
        const { policies } = store.read({ sessionId: agent.id, presetId: record.presetId })
        return resolvePolicy(policies.preset, policies.session)
      },
      position: () => stateFor(agent.id), changed: () => changed(agent.id),
    })
    if (publication) record.runtime = createPlanRuntime({ agent, publication, router: record.router,
      ownsPlan: () => currentPlan(record) === publication, changed: () => changed(agent.id),
    })
  }
  function tracePlacement(sessionId, presetId, type, turn, step) {
    const record = attached.get(sessionId)
    const nodeId = record?.runtime?.nodeFor({ type, turn, step })
    const baseline = buildGraph({ presetId: presetId ?? 'unassigned' }).id
    return nodeId ? { graphId: `${baseline}:published:${record.publication.publication.version}`, nodeId: planNodeId(nodeId) }
      : { graphId: baseline }
  }
  function presetFor(agent) {
    const inspection = ctx.get('agentPresets')?.inspectCompositions?.(agent.ctx)?.[0]
    return inspection?.id ?? agent.session.header?.agentPreset
  }
  function stateFor(sessionId) {
    let state = traces.get(sessionId)
    if (!state) {
      state = { records: new Map(), tools: new Map(), turn: undefined, step: 0 }
      traces.set(sessionId, state)
    }
    return state
  }
  function retain(sessionId, trace) {
    if (!trace) return
    const state = stateFor(sessionId)
    state.records.set(trace.id, freeze(trace))
    while (state.records.size > TRACE_LIMIT) state.records.delete(state.records.keys().next().value)
  }
  function observe(sessionId, event, presetId, live = false) {
    const state = stateFor(sessionId)
    if (event.type === 'turn/start') { state.turn = event.data.turn; state.step = 0 }
    if (event.type === 'step/start') { state.turn = event.data.turn; state.step = event.data.step }
    if (event.type === 'tool/call') state.tools.set(event.data.callId, event.data.name)
    const toolName = event.type === 'tool/result' ? state.tools.get(event.data.message?.toolCallId ?? event.data.message?.callId) : undefined
    const placement = live ? tracePlacement(sessionId, presetId, event.type, event.data?.turn ?? state.turn, event.data?.step ?? state.step)
      : { graphId: buildGraph({ presetId: presetId ?? 'unassigned' }).id }
    const trace = projectTraceEvent(event, { sessionId, graphId: placement.graphId,
      turn: state.turn, step: state.step || undefined, toolName })
    if (trace && (live || !state.records.has(trace.id))) retain(sessionId, placement.nodeId ? { ...trace, nodeId: placement.nodeId } : trace)
    if (event.type === 'tool/result') state.tools.delete(event.data.message?.toolCallId ?? event.data.message?.callId)
    return trace
  }

  function attach(agent) {
    if (stopped || !agent || attached.get(agent.id)?.agent === agent) return
    attached.get(agent.id)?.dispose()
    const supported = supportedAgent(ctx, agent)
    const record = { agent, supported, presetId: presetFor(agent), disposers: [] }
    record.dispose = () => {
      record.runtime?.dispose()
      record.router?.dispose()
      for (const dispose of record.disposers.splice(0)) dispose()
    }
    attached.set(agent.id, record)
    sessions.set(agent.id, { presetId: record.presetId })
    for (const event of agent.session.snapshotEvents?.() ?? []) observe(agent.id, event, record.presetId)
    configureExecution(record)
    if (!supported) return
    record.disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
      if (stopped || frame.type === 'chunk') return
      const id = `${agent.id}:attempt:${frame.attemptId}`
      if (frame.type === 'end') {
        const previous = stateFor(agent.id).records.get(id)
        if (!previous) return
        retain(agent.id, { ...previous, durationMs: Math.max(0, Date.now() - previous.timestamp),
          status: frame.outcome.kind === 'abandoned' ? 'abandoned' : frame.outcome.eventType === 'assistant/message' ? 'completed' : 'settled',
          ...(frame.outcome.seq === undefined ? {} : { seq: frame.outcome.seq }),
        })
        changed(agent.id)
        return
      }
      const config = agent.session.requestHeader?.()?.config
      const placement = tracePlacement(agent.id, record.presetId, 'request', frame.turn, frame.step)
      retain(agent.id, { id, type: 'request', nodeId: placement.nodeId ?? modelNodeId(frame.step),
        sessionId: agent.id, graphId: placement.graphId, graphSchemaVersion: 1,
        timestamp: Date.now(), turn: frame.turn, step: frame.step, status: 'running',
        ...(config?.provider ? { provider: config.provider, model: config.model } : {}),
      })
      changed(agent.id)
    }))
  }

  disposers.push(ctx.on('agent/created', ({ agent }) => attach(agent)))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    const record = attached.get(agent.id)
    if (record?.agent !== agent) return
    record.dispose()
    attached.delete(agent.id)
    changed(agent.id)
  }))
  disposers.push(ctx.on('agent/status', ({ agent }) => changed(agent.id)))
  disposers.push(ctx.on('session/event', (session, event) => {
    const record = attached.get(session.id)
    if (record && record.agent.session !== session) return
    const selection = event.type === 'agent-preset/selected'
    if (selection && record) {
      record.presetId = event.data.agentPreset
      // Native Session observers are synchronous. Model writes belong after
      // this selection event commits.
      queueMicrotask(() => {
        if (stopped || attached.get(session.id) !== record) return
        try { configureExecution(record); record.executionFault = undefined }
        catch { record.executionFault = 'Loop Studio could not update the session execution adapter.' }
        changed(session.id)
      })
    }
    const trace = observe(session.id, event, record?.presetId ?? sessions.get(session.id)?.presetId, true)
    if (selection || trace) changed(session.id)
  }))
  for (const agent of ctx.agents.list()) attach(agent)

  async function readSession(sessionId, signal) {
    active()
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new LoopError('bad-request', 'A sessionId is required.')
    const lifetime = new AbortController()
    reads.add(lifetime)
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    let iterator
    try {
      combined.throwIfAborted()
      const stream = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow',
        args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } },
        peer: ctx.connection.browserPeer, signal: combined })
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      combined.throwIfAborted()
      if (first.done || first.value.type !== 'snapshot' || first.value.header?.id !== sessionId) throw new LoopError('not-found', 'Session is unavailable.', 404)
      const snapshot = first.value
      const presetId = attached.get(sessionId)?.presetId ?? snapshot.projections?.values?.agentPreset ?? snapshot.header.agentPreset
      sessions.set(sessionId, { presetId })
      for (const record of snapshot.records) if (record.type === 'event') observe(sessionId, record.event, presetId)
      return { presetId }
    } finally {
      lifetime.abort()
      reads.delete(lifetime)
      await iterator?.return?.()
    }
  }

  async function inventory(diagnostics) {
    const registry = ctx.get('agentPresets')
    if (!registry?.compositionInventory) { diagnostics.push('The host does not expose a preset composition registry.'); return [] }
    try { return await registry.compositionInventory() }
    catch { diagnostics.push('Preset composition is temporarily unavailable.'); return [] }
  }
  async function modelCatalog(diagnostics, signal) {
    const models = []
    for (const provider of ctx.llm.listProviders()) {
      try {
        for (const model of await ctx.llm.listModels(provider.id)) {
          signal?.throwIfAborted()
          let reasoning
          try { reasoning = (await ctx.llm.resolveModelInfo(provider.id, model.id, signal)).reasoning }
          catch { diagnostics.push(`Reasoning metadata unavailable for ${provider.id}/${model.id}.`) }
          models.push({ provider: provider.id, id: model.id, name: model.name,
            ...(reasoning ? { reasoning: { efforts: reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })), ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }) } } : {}),
          })
        }
      } catch { diagnostics.push(`Model catalog unavailable for ${provider.id}.`) }
    }
    signal?.throwIfAborted()
    return models
  }

  const service = {
    ...Object.fromEntries(STRUCTURE_ACTIONS.map(action => [action, async (input, signal) => {
      await readSession(input.sessionId, signal)
      active()
      if (!structures) throw new LoopError('unavailable', 'Preset structure editing is unavailable in this host.', 503)
      return structures[action](input, signal)
    }])),
    async restoreStructures(child) {
      active()
      const editor = createStructureEditor(child, {
        canRunGraph: sessionId => attached.get(sessionId)?.supported ?? (child.get('agentLoop')?.constructor?.name === 'AgentLoop'),
        changed: sessionId => sessionId === undefined ? changedAll() : changed(sessionId),
      })
      structures = editor
      child.effect(() => async () => {
        if (structures === editor) structures = undefined
        await editor.close()
      }, 'Loop Studio published presets')
      const restore = async () => {
        try { await editor.restore() }
        catch (error) { if (error?.name !== 'AbortError') child.logger.warn('The Loop Studio preset library is unavailable.') }
      }
      if (!child.get('agentLoop')) child.inject(['agentLoop'], restore)
      await restore()
    },
    async inspect(sessionId, signal) {
      const diagnostics = []
      const session = await readSession(sessionId, signal)
      const [compositions, models] = await Promise.all([inventory(diagnostics), modelCatalog(diagnostics, signal)])
      active()
      const selectedPresetId = session.presetId ?? compositions.find(preset => preset.isDefault)?.id ?? null
      sessions.set(sessionId, { presetId: selectedPresetId })
      const selected = compositions.find(preset => preset.id === selectedPresetId)
      const record = attached.get(sessionId)
      const supported = record?.supported === true
      const publication = record?.publication
      const latestVersion = publication && await structures?.publishedVersion?.(publication.publication.presetId)
      if (!supported) diagnostics.push('The active driver is not recognized by the DSH 0.2.2-rc.1 main-loop adapter. Host stages are observe-only.')
      if (record?.router?.fault) diagnostics.push(record.router.fault)
      if (record?.runtime?.fault) diagnostics.push(record.runtime.fault)
      if (record?.executionFault) diagnostics.push(record.executionFault)
      if (selected?.broken) diagnostics.push('The selected preset reports a composition error.')
      const { revision, policies } = store.read({ sessionId, presetId: selectedPresetId })
      return { revision, selectedPresetId,
        presets: compositions.map(preset => ({ id: preset.id, ...(preset.name ? { name: preset.name } : {}), isDefault: preset.isDefault,
          ...(preset.broken ? { broken: 'Preset composition unavailable.' } : {}),
        })),
        composition: (selected?.rows ?? []).filter(row => row.entryId !== EXECUTION_PLAN_ROW_ID).map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled,
          ...(row.condition === undefined ? {} : { condition: row.condition }), ...(row.fiberState === undefined ? {} : { fiberState: row.fiberState }),
        })),
        graph: graphFor(selectedPresetId, supported, publication), policies, effectivePolicy: resolvePolicy(policies.preset, policies.session), models,
        ...(publication ? { executionPublication: { ...publication.publication, mode: 'graph',
          ...(latestVersion === undefined ? {} : { latestVersion }),
        } } : {}),
        trace: [...stateFor(sessionId).records.values()].sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0)),
        running: attached.get(sessionId)?.agent.status === 'running', routingCapability: supported ? 'supported' : 'unknown-driver', diagnostics,
      }
    },
    authorize: readSession,
    async savePolicy(input, signal) {
      active()
      const session = await readSession(input.sessionId, signal)
      const presetId = input.presetId ?? session.presetId
      if (input.scope === 'preset' && !(await inventory([])).some(preset => preset.id === presetId)) throw new LoopError('bad-request', 'Unknown preset policy scope.')
      const policy = validatePolicy(input.policy)
      const record = attached.get(input.sessionId)
      // Legacy model settings remain stored across a blank preset change.
      // Published model nodes use their own routes and never read those settings.
      const graph = graphFor(presetId, record?.supported === true)
      for (const nodeId of Object.keys(policy.routes)) {
        if (!graph.nodes.some(node => node.id === nodeId && node.control === 'route')) throw new LoopError('unsupported-node', 'The selected node cannot be routed by this adapter.')
      }
      signal?.throwIfAborted()
      const result = await store.savePolicy({ ...input, presetId, policy })
      for (const record of attached.values()) {
        if (!record.publication && (input.scope === 'preset' ? record.presetId === presetId : record.agent.id === input.sessionId)) record.router?.refresh()
      }
      if (input.scope === 'preset') changedAll()
      else changed(input.sessionId)
      return result
    },
    async resetPolicy(input, signal) {
      const session = await readSession(input.sessionId, signal)
      const presetId = input.presetId ?? session.presetId
      const result = await store.resetPolicy({ ...input, presetId })
      for (const record of attached.values()) {
        if (!record.publication && (input.scope === 'preset' ? record.presetId === presetId : record.agent.id === input.sessionId)) record.router?.refresh()
      }
      if (input.scope === 'preset') changedAll()
      else changed(input.sessionId)
      return result
    },
    subscribe(sessionId, listener) {
      active()
      const listeners = subscribers.get(sessionId) ?? new Set()
      listeners.add(listener)
      subscribers.set(sessionId, listeners)
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(sessionId) }
    },
    /** Register local stage ids under participant.id; return its unregister disposer. */
    registerParticipant(participant) {
      active()
      if (participants.has(participant.id)) throw new LoopError('bad-request', 'Participant is already registered.')
      const detached = structuredClone(participant)
      mergeParticipants(buildGraph({}), [...participants.values(), detached])
      participants.set(participant.id, freeze(detached))
      changedAll()
      return () => { if (participants.delete(participant.id)) changedAll() }
    },
    /** Freeze a registered model stage route at the participant's assembly boundary. */
    resolveRoute({ sessionId, nodeId }) {
      active()
      const presetId = attached.get(sessionId)?.presetId ?? sessions.get(sessionId)?.presetId
      if (!attached.has(sessionId) && !sessions.has(sessionId)) return null
      if (!graphFor(presetId, attached.get(sessionId)?.supported === true).nodes.some(node => node.id === nodeId && node.control === 'route')) return null
      const { policies } = store.read({ sessionId, presetId })
      return resolvePolicy(policies.preset, policies.session).routes[nodeId] ?? null
    },
    /** Only metadata for registered participant-owned stages can cross this seam. */
    recordTrace(input) {
      active()
      const presetId = attached.get(input.sessionId)?.presetId ?? sessions.get(input.sessionId)?.presetId
      const record = attached.get(input.sessionId)
      const graph = graphFor(presetId, record?.supported === true, record?.publication)
      const node = graph.nodes.find(node => node.id === input.nodeId && node.source !== 'host')
      if (!node || (!attached.has(input.sessionId) && !sessions.has(input.sessionId))) throw new LoopError('bad-request', 'Unknown participant stage or session.')
      const trace = { id: randomUUID(), type: 'participant', nodeId: node.id, sessionId: input.sessionId,
        graphId: graph.id, graphSchemaVersion: graph.schemaVersion, timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now() }
      for (const key of ['provider', 'model', 'toolName', 'status']) if (typeof input[key] === 'string' && input[key].length <= 256) trace[key] = input[key]
      for (const key of ['turn', 'step', 'seq', 'durationMs']) if (Number.isFinite(input[key]) && input[key] >= 0) trace[key] = input[key]
      const tokens = tokenMetadata(input.tokens)
      if (tokens) trace.tokens = tokens
      retain(input.sessionId, trace)
      changed(input.sessionId)
      return trace.id
    },
    async close() {
      if (stopped) return
      stopped = true
      for (const lifetime of reads) lifetime.abort()
      for (const dispose of disposers.splice(0)) dispose()
      const records = [...attached.values()]
      subscribers.clear()
      participants.clear()
      const failures = []
      for (const record of records) {
        for (const dispose of record.disposers.splice(0)) dispose()
        try { record.runtime?.close() } catch (error) { failures.push(error) }
        try { record.router?.close() } catch (error) { failures.push(error) }
      }
      try { await structures?.close?.() } catch (error) { failures.push(error) }
      attached.clear()
      sessions.clear()
      traces.clear()
      if (failures.length) throw new AggregateError(failures, 'Loop Studio route cleanup failed.')
    },
  }
  return service
}

export async function apply(ctx) {
  const service = await createLoopHost(ctx)
  const routes = createLoopRoutes(service)
  ctx.provide('loopStudio', service)
  ctx.connection.fetch.register({ path: '/api/loop-studio/request', methods: ['POST'], requestBody: 'buffered', fetch: request => routes.request(request) })
  ctx.connection.fetch.register({ path: '/api/loop-studio/events', methods: ['GET'], requestBody: 'buffered', fetch: request => routes.events(request) })
  ctx.effect(() => async () => { await routes.close(); await service.close() }, 'Loop Studio runtime')
  await ctx.inject(['agentPresets'], child => service.restoreStructures(child))
}
