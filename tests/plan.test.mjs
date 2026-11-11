import assert from 'node:assert/strict'
import test from 'node:test'
import { compileExecutionPlan, createNativeExecutionPlan, createStarterExecutionPlan, executionPlanIssues, validateExecutionPlan } from '../src/plan.mjs'
import { apply as provideExecutionPlan } from '../src/plan-plugin.mjs'
import { EXECUTION_PLAN_MODULE_URL, EXECUTION_PLAN_ROW_ID, EXECUTION_PLAN_SERVICE, materializeExecutionRows } from '../src/plan-publication.mjs'

test('the starter graph compiles a native tool continuation with a path to the end', () => {
  const original = createStarterExecutionPlan()
  delete original.maxModelSteps
  const plan = compileExecutionPlan(original)
  assert.equal(plan.execution.maxModelSteps, 32)
  assert.equal(plan.entry.id, 'model')
  assert.equal(plan.successor('model', 'tools').id, 'tools')
  assert.equal(plan.successor('tools', 'next'), plan.entry)
  assert.equal(plan.successor('model', 'no-tools').kind, 'end')
  original.nodes[0].label = 'draft changed'
  assert.notEqual(plan.entry.label, original.nodes[0].label)
  assert.ok(Object.isFrozen(plan.entry))
})

test('a port accepts only one edge and checks the target kind', () => {
  const plan = createStarterExecutionPlan()
  plan.edges.push({ id: 'duplicate-port', from: 'model', to: 'end', when: 'no-tools' })
  plan.edges.find(edge => edge.when === 'next').to = 'end'
  const issues = executionPlanIssues(plan)
  assert.ok(issues.some(issue => issue.code === 'duplicate-exit' && issue.nodeId === 'model' && issue.when === 'no-tools'))
  assert.ok(issues.some(issue => issue.code === 'invalid-exit' && issue.nodeId === 'tools' && issue.when === 'next'))
  assert.throws(() => validateExecutionPlan(plan), { code: 'invalid-execution-plan' })
})

test('a reachable cycle must still have a path to an end', () => {
  const plan = createStarterExecutionPlan()
  plan.edges.find(edge => edge.when === 'no-tools').to = 'model'
  const issues = executionPlanIssues(plan)
  assert.ok(issues.some(issue => issue.code === 'unreachable-node' && issue.nodeId === 'end'))
  assert.ok(issues.some(issue => issue.code === 'no-end-path' && issue.nodeId === 'tools'))
})

test('step bounds, route controls, and native execution shape are validated', () => {
  const plan = createStarterExecutionPlan()
  plan.nodes[0].route = { provider: 'fixture', model: 'local', maxTokens: -1 }
  for (const maxModelSteps of [null, 0, 257, 1.5]) {
    const issues = executionPlanIssues({ ...plan, maxModelSteps })
    assert.ok(issues.some(issue => issue.code === 'invalid-step-limit'))
    assert.ok(issues.some(issue => issue.code === 'invalid-route' && issue.nodeId === 'model'))
  }
  assert.deepEqual(validateExecutionPlan(createNativeExecutionPlan()), createNativeExecutionPlan())
  assert.deepEqual(materializeExecutionRows({ execution: createNativeExecutionPlan() }), [])
})

test('graph materialization gives the native preset revision an isolated immutable marker', () => {
  const execution = createStarterExecutionPlan()
  const presetId = 'loop-studio.fixture', version = 3
  const [row] = materializeExecutionRows({ execution, presetId, version })
  assert.equal(row.id, EXECUTION_PLAN_ROW_ID)
  assert.equal(row.name, EXECUTION_PLAN_MODULE_URL)
  assert.equal(new URL(row.name).protocol, 'file:')
  assert.deepEqual(row.isolate, { [EXECUTION_PLAN_SERVICE]: true })
  let service
  provideExecutionPlan({ provide(name, marker) { assert.equal(name, EXECUTION_PLAN_SERVICE); service = marker } }, row.config)
  assert.deepEqual(service.publication, { presetId, version })
  assert.deepEqual(service.execution, execution)
  assert.ok(Object.isFrozen(service.execution.nodes[0]))
  execution.nodes[0].instruction = 'draft changed'
  assert.equal(service.execution.nodes[0].instruction, '')
})
