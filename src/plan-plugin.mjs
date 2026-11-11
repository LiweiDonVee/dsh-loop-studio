import { EXECUTION_PLAN_SERVICE, validateExecutionPublication } from './plan-publication.mjs'

export const name = 'loop-studio-execution'

/** The native preset registry owns this marker for the lifetime of the mounted revision. */
export function apply(ctx, config) {
  ctx.provide(EXECUTION_PLAN_SERVICE, validateExecutionPublication(config))
}
