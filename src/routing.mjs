import { freeze, modelNodeId, LoopError } from './core.mjs'

const fields = ['provider', 'model', 'reasoningEffort', 'maxTokens']
const configOf = value => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const selectionOf = ({ provider, model, reasoningEffort }) => ({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const same = (a, b) => a && b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

/** rc.1 captures identity before assembly. Only public Model and event APIs write it. */
export function createAgentRouter({ agent, journal, policy, position, changed }) {
  const header = agent.session.requestHeader?.()
  let baseline = configOf({ ...agent.options, ...header?.config, ...agent.model.current() })
  if (agent.model.current()?.reasoningEffort === undefined) delete baseline.reasoningEffort
  if (header?.adapterDefaults?.maxTokens) delete baseline.maxTokens
  let lastOwn = null, lastOwnSeq = null, selecting = false, stopped = false, fault = null
  let currentSnapshot = null, nextNodeId = modelNodeId(position().step + 1), ownMaxTokens
  let cleanupControls = false, cleanupHeaderMax, requestDispose = () => {}, eventDispose = () => {}
  const snapshots = new WeakMap()
  const disposers = []

  function failed(error) {
    fault = `Loop Studio could not prepare its model route: ${error.message}`
    changed()
  }
  try {
    const receipt = journal.read(agent.session)
    if (receipt && same(agent.model.current(), receipt.selection)) {
      baseline = configOf(receipt.baseline)
      lastOwn = receipt.selection
      lastOwnSeq = receipt.selectionSeq
      if (header?.config.maxTokens !== baseline.maxTokens) ownMaxTokens = header?.config.maxTokens
    }
  } catch (error) { failed(error) }

  const latestSelection = () => agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
  function select(selected) {
    const current = agent.model.current()
    if (same(current, selected)) return
    const selection = selectionOf(selected)
    const selectionSeq = (agent.session.snapshotEvents().at(-1)?.seq ?? -1) + 1
    journal.write({ schemaVersion: 1, sessionId: agent.session.id, baseline: configOf(baseline), selection, selectionSeq,
      ...(lastOwn ? { previous: { selection: lastOwn, selectionSeq: lastOwnSeq } } : {}) })
    selecting = true
    try {
      agent.model.select(selection)
      const event = latestSelection()
      if (!same(agent.model.current(), selection) || event?.seq !== selectionSeq || !same(event.data, selection)) {
        throw new Error('Model selection readback did not match its ownership receipt.')
      }
      lastOwn = selection
      lastOwnSeq = selectionSeq
      fault = null
    } finally { selecting = false }
  }
  function restore() {
    if (!lastOwn) return
    if (!same(agent.model.current(), lastOwn) || latestSelection()?.seq !== lastOwnSeq) {
      journal.clear(agent.session.id)
      lastOwn = null
      lastOwnSeq = null
      return
    }
    selecting = true
    try {
      agent.model.select(selectionOf(baseline))
      if (!same(agent.model.current(), baseline)) throw new Error('Baseline model selection readback failed.')
      journal.clear(agent.session.id)
      lastOwn = null
      lastOwnSeq = null
      fault = null
    } finally { selecting = false }
  }
  function refresh(nodeId = nextNodeId, mustSucceed = false) {
    if (stopped) return
    nextNodeId = nodeId
    try {
      const selected = policy().routes[nodeId]
      if (selected) select(selected)
      else restore()
      if (mustSucceed && fault) throw new Error(fault)
    } catch (error) {
      failed(error)
      if (mustSucceed) throw new LoopError('routing-failed', fault, 503)
    }
  }
  function snapshot(context) {
    const fixed = context.modelSelection
    if (!fixed) throw new LoopError('routing-failed', 'The DSH driver did not provide a fixed model selection.', 503)
    let value = snapshots.get(fixed)
    if (!value) {
      const state = position(), nodeId = modelNodeId(state.step + 1)
      const selected = policy().routes[nodeId]
      value = Object.freeze({ turn: state.turn, step: state.step + 1, nodeId, signal: context.signal,
        selection: freeze({ ...fixed }), route: freeze(selected && same(selected, fixed) ? { ...selected } : { ...fixed }),
        ...(baseline.maxTokens === undefined ? {} : { baselineMaxTokens: baseline.maxTokens }) })
      snapshots.set(fixed, value)
    }
    currentSnapshot = value
    return value
  }

  disposers.push(agent.ctx.on('agent/inbox/claimed', () => {
    refresh(modelNodeId(position().step + 1))
  }))
  disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (!stopped) snapshot(context)
    return next()
  }, { prepend: true }))
  disposers.push(agent.ctx.on('agent/pre-step', async (proposal, next) => {
    if (fault) throw new LoopError('routing-failed', fault, 503)
    const selected = snapshot(proposal)
    const decision = await next()
    if (decision.kind !== 'reject' && !proposal.signal.aborted && !stopped) refresh('host.continuation')
    if (fault) throw new LoopError('routing-failed', fault, 503)
    currentSnapshot = selected
    return decision
  }, { prepend: true }))
  disposers.push(agent.ctx.on('tools/result', () => refresh('host.continuation')))
  disposers.push(agent.ctx.on('agent/turn-stopping', () => refresh('host.continuation')))
  requestDispose = agent.ctx.on('agent/request', async (payload, next) => {
    const bound = currentSnapshot
    const result = await next()
    const matches = bound && payload.turn === bound.turn && payload.step === bound.step
    const frozen = matches && !bound.signal.aborted
    if (!frozen && !cleanupControls) return result
    const proposed = { ...result }
    if (ownMaxTokens !== undefined && result.maxTokens === ownMaxTokens) {
      const cap = frozen ? bound.baselineMaxTokens : baseline.maxTokens
      if (cap === undefined) delete proposed.maxTokens
      else proposed.maxTokens = cap
    } else {
      if (result.maxTokens === undefined) delete baseline.maxTokens
      else baseline.maxTokens = result.maxTokens
    }
    if (frozen && bound.route.maxTokens !== undefined) {
      proposed.maxTokens = bound.route.maxTokens
      ownMaxTokens = bound.route.maxTokens
    } else ownMaxTokens = undefined
    if (cleanupControls && !frozen) cleanupHeaderMax = proposed.maxTokens
    // provider, model and reasoningEffort belong to the driver's captured selection.
    return proposed
  }, { prepend: true })
  eventDispose = agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'model/selection' && !selecting) {
      const { reasoningEffort: _effort, ...original } = baseline
      baseline = { ...original, ...selectionOf(event.data) }
      lastOwn = null
      lastOwnSeq = null
      try { journal.clear(agent.session.id) } catch (error) { failed(error) }
    }
    if (event.type === 'turn/start' || event.type === 'turn/end') nextNodeId = 'host.first'
    if (event.type === 'step/end' || event.type === 'turn/end') currentSnapshot = null
    if (stopped && cleanupControls && event.type === 'request/header'
      && (event.data.header.adapterDefaults?.maxTokens === true ? undefined : event.data.header.config.maxTokens) === cleanupHeaderMax && !currentSnapshot) {
      cleanupControls = false
      requestDispose()
      eventDispose()
    }
  })

  return {
    refresh: () => refresh(nextNodeId, true),
    get fault() { return fault },
    dispose() { for (const dispose of disposers.splice(0)) dispose(); requestDispose(); eventDispose() },
    close() {
      if (stopped) return
      stopped = true
      for (const dispose of disposers.splice(0)) dispose()
      try { restore() } catch (error) { failed(error); throw new LoopError('routing-failed', fault, 503) }
      cleanupControls = ownMaxTokens !== undefined || currentSnapshot?.route.maxTokens !== undefined
      if (!cleanupControls) { requestDispose(); eventDispose() }
    },
  }
}
