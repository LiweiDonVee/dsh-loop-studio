import { freeze, LoopError, validatePolicy } from './core.mjs'

export const EXECUTION_PLAN_VERSION = 1
export const DEFAULT_MODEL_STEPS = 32
export const MAX_MODEL_STEPS = 256
export const MAX_EXECUTION_NODES = 256
export const MAX_EXECUTION_EDGES = 512
export const MAX_NODE_LABEL = 256
export const MAX_NODE_INSTRUCTION = 4000
export const EXECUTION_TARGET_KINDS = freeze({ model: { 'no-tools': ['model', 'end'], tools: ['tools'] }, tools: { next: ['model'] }, end: {} })

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && idPattern.test(value)
const fields = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))

export function createNativeExecutionPlan() {
  return { schemaVersion: EXECUTION_PLAN_VERSION, mode: 'native', entryNodeId: '', maxModelSteps: DEFAULT_MODEL_STEPS, nodes: [], edges: [] }
}

export function createStarterExecutionPlan() {
  return {
    ...createNativeExecutionPlan(), mode: 'graph', entryNodeId: 'model',
    nodes: [
      { id: 'model', kind: 'model', label: '模型请求', instruction: '' },
      { id: 'tools', kind: 'tools', label: '执行工具', execution: 'inherit' },
      { id: 'end', kind: 'end', label: '回合结束' },
    ],
    edges: [
      { id: 'model-tools', from: 'model', to: 'tools', when: 'tools' },
      { id: 'tools-model', from: 'tools', to: 'model', when: 'next' },
      { id: 'model-end', from: 'model', to: 'end', when: 'no-tools' },
    ],
  }
}

/** Validate the published graph using the same node and edge contract in Host and Client. */
export function executionPlanIssues(plan) {
  if (!object(plan) || !fields(plan, ['schemaVersion', 'mode', 'entryNodeId', 'maxModelSteps', 'nodes', 'edges'])
    || plan.schemaVersion !== EXECUTION_PLAN_VERSION || !['native', 'graph'].includes(plan.mode)
    || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) {
    return [{ code: 'invalid-plan', message: 'Execution requires schema version 1, a mode, nodes and edges.' }]
  }
  const issues = []
  const issue = (code, message, detail = {}) => issues.push({ code, message, ...detail })
  const limit = plan.maxModelSteps === undefined ? DEFAULT_MODEL_STEPS : plan.maxModelSteps
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODEL_STEPS) {
    issue('invalid-step-limit', `Model steps must be an integer from 1 to ${MAX_MODEL_STEPS}.`)
  }
  if (plan.mode === 'native') {
    if (plan.entryNodeId !== '' || plan.nodes.length || plan.edges.length) {
      issue('invalid-native-plan', 'Native execution uses an empty graph.')
    }
    return issues
  }
  if (plan.nodes.length > MAX_EXECUTION_NODES || plan.edges.length > MAX_EXECUTION_EDGES) {
    issue('graph-size', `Execution supports at most ${MAX_EXECUTION_NODES} nodes and ${MAX_EXECUTION_EDGES} edges.`)
    return issues
  }

  const nodes = new Map()
  for (const node of plan.nodes) {
    if (!object(node) || !id(node.id) || !['model', 'tools', 'end'].includes(node.kind)) {
      issue('invalid-node', 'Each node needs a valid id and a model, tools or end kind.')
      continue
    }
    const detail = { nodeId: node.id }
    if (nodes.has(node.id)) {
      issue('duplicate-node', 'Node ids must be unique.', detail)
      continue
    }
    nodes.set(node.id, node)
    if (typeof node.label !== 'string' || !node.label.trim() || node.label.length > MAX_NODE_LABEL) {
      issue('invalid-label', `Node labels need 1 to ${MAX_NODE_LABEL} characters.`, detail)
    }
    if (node.kind === 'model') {
      if (!fields(node, ['id', 'kind', 'label', 'instruction', 'route'])
        || typeof node.instruction !== 'string' || node.instruction.length > MAX_NODE_INSTRUCTION) {
        issue('invalid-model-node', `A model node needs an instruction of at most ${MAX_NODE_INSTRUCTION} characters.`, detail)
      }
      if (node.route !== undefined) {
        try { validatePolicy({ enabled: true, routes: { model: node.route } }) }
        catch { issue('invalid-route', 'A model route requires a provider and model with valid optional controls.', detail) }
      }
    } else if (node.kind === 'tools') {
      if (!fields(node, ['id', 'kind', 'label', 'execution']) || !['inherit', 'sequential'].includes(node.execution)) {
        issue('invalid-tools-node', 'Tool execution must inherit the preset setting or run sequentially.', detail)
      }
    } else if (!fields(node, ['id', 'kind', 'label'])) {
      issue('invalid-end-node', 'An end node only accepts an id and label.', detail)
    }
  }
  if (nodes.get(plan.entryNodeId)?.kind !== 'model') issue('invalid-entry', 'The entry must be a model node.')

  const edgeIds = new Set()
  const exits = new Map([...nodes.keys()].map(nodeId => [nodeId, new Map()]))
  const incoming = new Map([...nodes.keys()].map(nodeId => [nodeId, []]))
  for (const edge of plan.edges) {
    if (!object(edge) || !fields(edge, ['id', 'from', 'to', 'when']) || !id(edge.id)
      || !nodes.has(edge.from) || !nodes.has(edge.to) || !['tools', 'no-tools', 'next'].includes(edge.when)) {
      issue('invalid-edge', 'Each edge requires an id, two existing nodes and an exit condition.')
      continue
    }
    const detail = { nodeId: edge.from, edgeId: edge.id, when: edge.when }
    if (edgeIds.has(edge.id)) {
      issue('duplicate-edge', 'Edge ids must be unique.', detail)
      continue
    }
    edgeIds.add(edge.id)
    const from = nodes.get(edge.from).kind, to = nodes.get(edge.to).kind
    if (!EXECUTION_TARGET_KINDS[from][edge.when]?.includes(to)) {
      issue('invalid-exit', 'Connect tools to a tools node, no-tools to a model or end node, and next to a model node.', detail)
      continue
    }
    if (exits.get(edge.from).has(edge.when)) {
      issue('duplicate-exit', 'Each exit condition can have one connection.', detail)
      continue
    }
    exits.get(edge.from).set(edge.when, edge.to)
    incoming.get(edge.to).push(edge.from)
  }
  const ends = []
  for (const node of nodes.values()) {
    const when = node.kind === 'model' ? 'no-tools' : 'next'
    if (node.kind === 'end') ends.push(node.id)
    else if (!exits.get(node.id).has(when)) issue('missing-exit', `Connect the ${when} exit.`, { nodeId: node.id, when })
  }
  if (issues.length) return issues
  const reachable = visit([plan.entryNodeId], nodeId => exits.get(nodeId).values())
  const ending = visit(ends, nodeId => incoming.get(nodeId))
  for (const nodeId of nodes.keys()) {
    if (!reachable.has(nodeId)) issue('unreachable-node', 'Every node must be reachable from the entry.', { nodeId })
    if (!ending.has(nodeId)) issue('no-end-path', 'Every node must have a path to an end node.', { nodeId })
  }
  return issues
}

function visit(start, adjacent) {
  const visited = new Set(start)
  const queue = [...start]
  for (const current of queue) {
    for (const next of adjacent(current)) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push(next)
    }
  }
  return visited
}

/** Return a detached DTO with its step budget resolved. */
export function validateExecutionPlan(plan) {
  const issues = executionPlanIssues(plan)
  if (issues.length) {
    const error = new LoopError('invalid-execution-plan', issues[0].message)
    error.issues = issues
    throw error
  }
  return structuredClone({ ...plan, maxModelSteps: plan.maxModelSteps ?? DEFAULT_MODEL_STEPS })
}

export function compileExecutionPlan(value) {
  const execution = freeze(validateExecutionPlan(value))
  const nodes = new Map(execution.nodes.map(node => [node.id, node]))
  const exits = new Map(execution.edges.map(edge => [`${edge.from}:${edge.when}`, nodes.get(edge.to)]))
  return Object.freeze({ execution, entry: nodes.get(execution.entryNodeId),
    successor: (nodeId, when) => exits.get(`${nodeId}:${when}`) })
}
