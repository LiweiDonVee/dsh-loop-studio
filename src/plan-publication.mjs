import { freeze, LoopError } from './core.mjs'
import { validateExecutionPlan } from './plan.mjs'

export const EXECUTION_PLAN_SERVICE = 'loopStudioExecutionPlan'
export const EXECUTION_PLAN_ROW_ID = 'loop-studio-execution'
export const EXECUTION_PLAN_MODULE_NAME = 'dsh-loop-studio/execution'
export const EXECUTION_PLAN_MODULE_URL = import.meta.resolve(EXECUTION_PLAN_MODULE_NAME)

export function validateExecutionPublication(config) {
  const publication = config?.publication
  const presetId = publication?.presetId, version = publication?.version
  if (typeof presetId !== 'string' || !presetId.trim() || presetId.length > 256
    || !Number.isSafeInteger(version) || version < 1) {
    throw new LoopError('invalid-execution-publication', 'A published graph needs a preset id and version.')
  }
  const execution = validateExecutionPlan(config.execution)
  if (execution.mode !== 'graph') throw new LoopError('invalid-execution-publication', 'Only graph mode mounts an execution plan.')
  return freeze({ publication: { presetId, version }, execution })
}

/** Resolve through the installed package's own export while retaining the source preset's Loader base. */
export function materializeExecutionRows({ execution, presetId, version }) {
  if (execution.mode === 'native') return []
  const config = validateExecutionPublication({ execution, publication: { presetId, version } })
  return [{ id: EXECUTION_PLAN_ROW_ID, name: EXECUTION_PLAN_MODULE_URL,
    isolate: { [EXECUTION_PLAN_SERVICE]: true }, config }]
}
