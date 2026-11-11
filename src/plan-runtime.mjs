import { randomUUID } from 'node:crypto'
import { freeze, LoopError } from './core.mjs'
import { compileExecutionPlan } from './plan.mjs'

const messageSource = 'loop-studio-execution'
const executorNames = new Set(['NativeToolExecutor', 'PtcExecutor'])
const restoredExecutors = new WeakMap()
const denial = 'This Loop Studio model node does not have a tools connection.'
const isContinuation = message => message.source?.kind === messageSource && message.source.continuation === true

/** Bind one published graph to the rc.1 driver's native turn and tool boundaries. */
export function createPlanRuntime({ agent, publication: marker, router, ownsPlan = () => true, changed = () => {} }) {
  const graph = compileExecutionPlan(marker.execution)
  const { presetId, version } = marker.publication
  const blockedSet = Object.freeze({ view: () => new Map(), dispose() {} })
  const disposers = []
  let run, startupFailure, fault, stopped = false, releaseExecutor

  function report(error) {
    fault = error.message
    changed()
    return error
  }

  function messageFor(node, turn, step, continuation = false) {
    return freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text',
      text: `[Loop Studio · ${node.label}]\n${node.instruction || 'Continue from the previous stage.'}` }],
    source: { kind: messageSource, presetId, version, nodeId: node.id, turn, step,
      ...(continuation ? { continuation: true } : {}) } })
  }

  function restoreClaimed(messages) {
    const queued = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))
    const retained = []
    for (const message of messages) {
      if (isContinuation(message) || queued.has(message.id)) continue
      retained.push(message)
      queued.add(message.id)
    }
    if (retained.length) agent.inbox.splice('next-step', 0, 0, retained)
    return retained.length
  }

  function finish(current, endNode) {
    current.terminal = true
    current.endNode = endNode
    current.next = null
  }

  function toolNode(node) { return graph.successor(node.id, 'tools') }

  function offersTools() {
    if (stopped || !run || run.ended || run.terminal) return true
    if (toolNode(run.next)) return true
    run.noToolsOffer = { node: run.next, step: run.visits + 1 }
    return false
  }

  async function executeBatch(base, input) {
    const current = run, step = current?.step
    if (!step || input.agent !== agent || input.log?.turn !== current.turn || input.log.step !== step.number) {
      return base.execute(input)
    }
    if (!step.tools) {
      const denied = await base.execute({ ...input, toolSet: blockedSet })
      if (input.signal.aborted) return denied
      for (const context of denied.additionalContexts) agent.inject(context)
      throw report(new LoopError('unexpected-tool-calls', denial))
    }
    const result = await base.execute(step.tools.execution === 'sequential' ? { ...input, maxParallelToolCalls: 1 } : input)
    if (stopped || current !== run || input.signal.aborted) return result
    if (result.concluded) finish(current)
    else {
      current.next = graph.successor(step.tools.id, 'next')
      // Native continuation may have no inbox claims. Prepare before yielding the batch back to the driver.
      prepareCandidate(current)
    }
    return result
  }

  function ensureExecutor() {
    if (releaseExecutor) return
    const tools = agent.ctx.tools
    const base = tools.selectExecutor(agent)
    if (!executorNames.has(base.constructor.name)) {
      throw new LoopError('unsupported-executor', 'Loop Studio requires the native DSH tool executor or PTC executor.')
    }
    const wrapper = {
      describe(definitions) {
        if (offersTools()) return base.describe(definitions)
        const { knownNames } = base.describe([])
        return { schemas: [], ...(knownNames === undefined ? {} : { knownNames }) }
      },
      sections: base.sections?.map(section => ({ ...section, text: definitions => {
        if (!offersTools()) return ''
        return typeof section.text === 'function' ? section.text(definitions) : section.text
      } })),
      execute: input => executeBatch(base, input),
    }
    let remove, removeGuard, removeGate
    const denied = exec => exec.agent === agent && exec.toolSet === blockedSet
    const restored = restoredExecutors.get(agent)
    const reclaim = restored?.base === base
    function restoreBase() {
      const dispose = tools.setExecutor(base)
      restoredExecutors.set(agent, { base, dispose })
    }
    try {
      // Only a native slot restored by this module can be reclaimed on re-enable.
      if (reclaim) {
        restored.dispose()
        restoredExecutors.delete(agent)
      }
      remove = tools.setExecutor(wrapper)
      removeGuard = tools.guard(exec => denied(exec) ? denial : undefined)
      removeGate = agent.ctx.on('tools/pre-execute', (exec, next) => denied(exec) ? { kind: 'deny', reason: denial } : next(), { prepend: true })
    } catch (error) {
      removeGate?.()
      removeGuard?.()
      remove?.()
      if (remove || reclaim) restoreBase()
      throw new LoopError('unsupported-executor', `Loop Studio could not mount the scoped DSH executor. ${error.message}`)
    }
    releaseExecutor = restore => {
      removeGate()
      removeGuard()
      remove()
      // rc.1 leaves a vacant selection at this scope when a provider is disposed.
      if (restore) restoreBase()
    }
  }

  function prepareCandidate(current) {
    if (stopped || !ownsPlan() || current?.terminal || current?.failure) return
    const node = current?.next ?? graph.entry
    if (current && current.visits >= graph.execution.maxModelSteps) return
    try {
      ensureExecutor()
      router.prepare(node.id)
    } catch (error) {
      if (current) current.failure = error
      else startupFailure = error
      report(error)
    }
  }

  function cleanup(restore) {
    for (const dispose of disposers.splice(0)) dispose()
    const release = releaseExecutor
    releaseExecutor = undefined
    release?.(restore)
  }

  disposers.push(agent.ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    if (status === 'running') prepareCandidate()
    else if (status === 'idle') {
      if (stopped) cleanup(true)
      else {
        try { router.prepare(null) } catch (error) { report(error) }
      }
    }
  }))

  disposers.push(agent.ctx.on('agent/inbox/claimed', ({ agent: subject, turn }) => {
    if (subject === agent && run?.turn === turn) prepareCandidate(run)
  }))

  disposers.push(agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start' && !stopped && ownsPlan()) {
      run = { turn: event.data.turn, next: graph.entry, visits: 0, failure: startupFailure }
      if (!startupFailure) fault = undefined
      startupFailure = undefined
      return
    }
    if (!run || event.data?.turn !== run.turn) return
    if (event.type === 'turn/end') {
      run.ended = true
      return
    }
    const step = run.step
    if (!step || event.data.step !== step.number) return
    if (event.type === 'step/start') run.visits++
    if (event.type !== 'assistant/message' || stopped) return
    const { message, stream, interrupted } = event.data
    const reason = stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'finish')?.chunk.reason.kind
    if (interrupted || reason === 'max-tokens') finish(run)
    else if (!message.content.some(block => block.type === 'tool-call')) {
      const next = graph.successor(step.node.id, 'no-tools')
      if (next.kind === 'end') finish(run, next)
      else run.next = next
    }
  }))

  disposers.push(agent.ctx.on('agent/pre-step', async (proposal, next) => {
    const current = run
    if (proposal.agent !== agent || !current || proposal.turn !== current.turn || current.ended) return next()
    if (stopped) {
      const offered = current.noToolsOffer
      if (offered?.step === proposal.step) current.step = { node: offered.node, number: proposal.step }
      current.noToolsOffer = undefined
      return next()
    }
    if (!ownsPlan()) return next()
    if (current.terminal) {
      if (restoreClaimed(proposal.messages)) {
        report(new LoopError('execution-pending-input', 'The graph stopped with input still queued for the next turn.'))
      }
      return { kind: 'reject' }
    }
    const error = current.failure ?? (current.visits >= graph.execution.maxModelSteps
      ? new LoopError('execution-step-limit', `Loop Studio reached the ${graph.execution.maxModelSteps}-step model limit.`) : null)
    if (error) {
      restoreClaimed(proposal.messages)
      throw report(error)
    }
    const node = current.next, tools = toolNode(node)
    try { router.capture(proposal, node.id) }
    catch (error) { restoreClaimed(proposal.messages); throw report(error) }
    current.step = { node, tools, number: proposal.step }
    current.noToolsOffer = undefined
    const decision = await next()
    if (decision.kind === 'reject' || proposal.signal.aborted || stopped) return decision
    const wakeId = current.wakeId
    current.wakeId = undefined
    const messages = decision.messages.filter(message => !isContinuation(message) || message.id === wakeId)
    if (proposal.step === 1 && messages.length === 0) return { ...decision, messages }
    if (node.instruction.trim() && !messages.some(message => message.id === wakeId)) {
      messages.push(messageFor(node, proposal.turn, proposal.step))
    }
    const history = agent.session.toolHistory?.()
    const hasPriorTools = history?.tools.length || history?.updates.some(update => update.additions.length)
    return { ...decision, messages, ...(!tools && hasPriorTools ? { startsRequestSeries: true } : {}) }
  }, { prepend: true }))

  disposers.push(agent.ctx.on('agent/turn-stopping', ({ agent: subject, turn, signal }) => {
    const current = run
    if (subject !== agent || stopped || !ownsPlan() || signal.aborted || !current || current.turn !== turn
      || current.terminal || current.wakeId || agent.inbox.nextStep.length) return
    prepareCandidate(current)
    const message = messageFor(current.next, turn, current.visits + 1, true)
    current.wakeId = message.id
    agent.inject(message)
  }))

  return {
    get fault() { return fault },
    nodeFor({ type, turn, step }) {
      if (type === 'turn/start') return graph.entry.id
      if (!run || run.turn !== turn) return undefined
      if (type === 'turn/end') return run.endNode?.id ?? run.step?.node.id
      if (run.step?.number !== step) return undefined
      if (type === 'tool/call' || type === 'tool/result') return run.step.tools?.id ?? run.step.node.id
      return run.step.node.id
    },
    close() {
      if (stopped) return
      stopped = true
      if (agent.status !== 'running') cleanup(true)
    },
    dispose() {
      stopped = true
      cleanup(false)
    },
  }
}
