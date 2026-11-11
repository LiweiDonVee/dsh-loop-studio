import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'loop-structure-native-fixture'
export const inject = ['appExit', 'connection', 'llm', 'agents', 'tools', 'systemPrompt', 'typertGateway', 'sessionQuery', 'sessionPersistence', 'agentPresets']

const provider = 'loop-structure-local'
const models = ['configured', 'routed-first', 'routed-continuation', 'draft', 'review', 'alternate', 'final']
const toolNames = ['structure_fixture_a', 'structure_fixture_b']
const terminal = 'STRUCTURE_FIXTURE_DONE'
const errorCauses = error => error instanceof AggregateError ? error.errors.map(errorCauses)
  : { code: error?.code, message: error?.message ?? String(error), ...(error?.cause ? { cause: errorCauses(error.cause) } : {}) }
const textOf = message => (typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'))

async function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolCall(name) {
  const id = randomUUID()
  const args = '{"value":"synthetic"}'
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export function apply(ctx) {
  const calls = []
  const errors = []
  const executed = []
  async function* stream(options) {
    const initiator = ctx.agents.currentInitiator()
    const messages = options.messages ?? []
    const user = messages.findLastIndex(message => message.role === 'user' && /^(?:ROUTING_FIXTURE|WORKFLOW_|SOURCE_FIXTURE)/.test(textOf(message)))
    const prompt = textOf(messages[user])
    const system = typeof options.system === 'string'
      ? options.system
      : [JSON.stringify(options.system ?? ''), ...messages.filter(message => message.role === 'system').map(textOf)].join('\n')
    const tools = (options.tools ?? []).map(tool => tool.name)
    calls.push({ kind: 'model', sessionId: initiator?.id, provider: options.provider, model: options.model,
      maxTokens: options.maxTokens ?? null, prompt, tools, requestConfig: initiator?.session.requestHeader()?.config,
      instructions: [...[system, ...messages.map(textOf)].join('\n').matchAll(/\bWORKFLOW_INSTRUCTION_[A-Z_]+/g)].map(match => match[0]),
      markers: [...system.matchAll(/\b(?:SOURCE|EDITED)_[A-Z_]+(?=\s+LOOP_STRUCTURE_RELATIVE_ASSET)/g)].map(match => match[0]) })
    if (prompt.includes('ROUTING_FIXTURE') && !messages.slice(user + 1).some(message => message.role === 'tool')) {
      yield* toolCall(toolNames[0])
      return
    }
    if (options.model === 'draft' && prompt.includes('WORKFLOW_WITH_TOOL')) {
      yield* toolCall(toolNames[0])
      return
    }
    if (options.model === 'review' && prompt.includes('WORKFLOW_DENIED_TOOL')) {
      yield* toolCall(toolNames[1])
      return
    }
    yield* text(terminal)
  }
  const adapter = {
    providerInfo: id => ({ id, name: 'Loop Studio local fixture' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => image,
    listModels: async id => models.map(model => ({ provider: id, id: model, name: model })),
    async resolveModel(id, model) {
      if (id !== provider || !models.includes(model)) throw Error('Unknown fixture route')
      return { provider: id, id: model, name: model, context: { contextWindow: 131_072 } }
    },
    async prepareCall(id, model) { return { model: await this.resolveModel(id, model), stream } },
  }
  ctx.llm.registerAdapter([provider], adapter)
  const tool = name => ({
    name,
    description: 'A deterministic tool that only records synthetic fixture input.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    output: { schema: { type: 'object' }, render: result => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async ({ value }, execution) => {
      executed.push({ sessionId: execution.agent.id, name })
      return { name, value }
    },
    isConcurrencySafe: () => true,
  })
  ctx.tools.register(tool(toolNames[0]))
  // Agent-owned definitions are exempt from a native restriction layer. The
  // no-tools graph branch must still prevent this tool body from running.
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.register(tool(toolNames[1])) })
  ctx.on('tools/result', (execution, result) => {
    if (toolNames.includes(execution.name)) {
      calls.push({ kind: 'tool', sessionId: execution.agent?.id, name: execution.name, value: result.value,
        isError: result.isError === true })
    }
  })
  ctx.on('agent/error', ({ agent, error }) => errors.push({ sessionId: agent?.id, message: error.message, code: error.code }))

  const invoke = (method, request, signal) => ctx.typertGateway.invoke({
    namespace: 'session', method, args: { request }, peer: ctx.connection.browserPeer, signal,
  })
  async function snapshot(sessionId) {
    const view = await ctx.sessionQuery.observeSession(sessionId)
    try {
      return { header: view.header, events: view.events, projections: view.projections, inheritedEventCount: view.inheritedEventCount }
    } finally {
      view[Symbol.dispose]()
    }
  }
  const trace = sessionId => calls.filter(call => call.sessionId === sessionId)
  const toolExecutions = sessionId => executed.filter(call => call.sessionId === sessionId).map(call => call.name)
  const agentErrors = sessionId => errors.filter(error => error.sessionId === sessionId)
  async function idle(sessionId) {
    await ctx.agents.get(sessionId)?.whenIdle()
    await ctx.sessionPersistence.flush()
    return snapshot(sessionId)
  }
  ctx.connection.fetch.register({
    path: '/api/loop-structure-probe',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { action, sessionId, preset, prompt } = await request.json()
        let result
        if (action === 'ready') result = { pid: process.pid, presets: await ctx.agentPresets.list(), defaultPresetId: ctx.agentPresets.defaultId,
          providers: ctx.llm.listProviders().map(provider => provider.id), loop: !!ctx.get('loopStudio') }
        else if (action === 'workspace') result = await ctx.typertGateway.invoke({
          namespace: 'workspace', method: 'create',
          args: { request: { path: fileURLToPath(new URL('../workspace', import.meta.url)) } },
          peer: ctx.connection.browserPeer, signal: request.signal,
        })
        else if (action === 'document') result = await ctx.agentPresets.readDocument(preset)
        else if (action === 'create') result = await invoke('create', {
          ...(sessionId === undefined ? {} : { sessionId }), ...(preset === undefined ? {} : { agentPreset: preset }),
        }, request.signal)
        else if (action === 'snapshot') result = await snapshot(sessionId)
        else if (action === 'armScopedTool') {
          const agent = ctx.agents.get(sessionId)
          if (!agent) throw Error('A live fixture session is required.')
          if (!ctx.tools.get(toolNames[1], agent)) agent.ctx.tools.register(tool(toolNames[1]))
          result = { registered: Boolean(ctx.tools.get(toolNames[1], agent)), global: Boolean(ctx.tools.get(toolNames[1])) }
        }
        else if (action === 'idle') result = { snapshot: await idle(sessionId), calls: trace(sessionId), executed: toolExecutions(sessionId), errors: agentErrors(sessionId) }
        else if (action === 'run') {
          const before = trace(sessionId).length
          const beforeExecuted = toolExecutions(sessionId).length
          const beforeErrors = agentErrors(sessionId).length
          await invoke('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }] }, request.signal)
          result = { snapshot: await idle(sessionId), calls: trace(sessionId).slice(before),
            executed: toolExecutions(sessionId).slice(beforeExecuted), errors: agentErrors(sessionId).slice(beforeErrors) }
        } else if (action === 'exit') {
          await ctx.sessionPersistence.flush()
          setTimeout(() => ctx.appExit(0), 100)
          result = { exiting: true }
        } else return Response.json({ error: 'Unknown fixture action' }, { status: 400 })
        return Response.json({ result })
      } catch (error) {
        const details = errorCauses(error)
        console.error('Loop Structure fixture:', error.stack, JSON.stringify(details))
        return Response.json({ error: { code: error.code, message: error.message, details } }, { status: 500 })
      }
    },
  })
}
