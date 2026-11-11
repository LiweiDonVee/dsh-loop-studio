import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStructureEditor } from '../src/structures.mjs'
import { createStructureStore } from '../src/store.mjs'
import { createStarterExecutionPlan } from '../src/plan.mjs'
import { EXECUTION_PLAN_MODULE_URL, EXECUTION_PLAN_ROW_ID } from '../src/plan-publication.mjs'

const baseUrl = 'file:///loop-fixture/source/'
const originalRows = [{
  id: 'group', name: 'cordis:group', group: true, isolate: { fixture: true },
  disabled: { __jsExpr: 'process.platform === "unavailable"' },
  config: [{ name: './fixture.mjs', config: { secretRef: { __jsExpr: 'process.env.FIXTURE_KEY' } }, custom: { preserve: [1, true] } }],
}]
const inputOf = (draft, changes = {}) => ({
  draftId: draft.draftId, expectedRevision: draft.revision,
  document: { name: draft.name, description: draft.description, rows: draft.rows, execution: draft.execution, ...changes },
})

async function fixture(t, options = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'loop-structures-'))
  if (!options.home) t.after(() => rm(home, { recursive: true, force: true }))
  const source = { id: 'standard', name: 'Standard', plugins: structuredClone(originalRows) }
  const definitions = new Map([[source.id, source]])
  const peer = { principal: { kind: 'owner' } }
  const calls = []
  const boundary = { openTurnStartSeq: null, lastTurn: 0 }
  const diagnostic = id => {
    const found = definitions.get(id)
    const broken = found?.plugins.find(row => row.name === 'missing-module' || options.isUnavailable?.(row.name))
    return { id, ...(broken ? { broken: `${broken.id} (${broken.name}): PRIVATE_PLUGIN_ERROR` } : {}) }
  }
  const registry = {
    async list() { return [...definitions.values()].map(({ id, name }) => ({ name, ...diagnostic(id) })) },
    async readDocument(id) {
      const found = definitions.get(id)
      if (!found) throw Object.assign(new Error('unknown'), { code: 'agent-preset/not-found' })
      return { agentPreset: id, name: found.name, description: found.description, content: JSON.stringify(found.plugins) }
    },
    async register(preset, base) {
      assert.equal(base, baseUrl)
      assert.ok(!definitions.has(preset.id))
      calls.push(['register', preset.id])
      definitions.set(preset.id, preset)
      return async () => { calls.push(['unregister', preset.id]); definitions.delete(preset.id) }
    },
    async resolve(id) {
      calls.push(['audit', id])
      return diagnostic(id)
    },
  }
  const declaration = { options: { name: '@deepseek-ai/dsh-agent-preset', config: source }, fiber: { state: 2, ctx: { baseUrl } } }
  const loader = { entries: () => options.unknownBase ? [] : [declaration] }
  const ctx = {
    get: service => ({ agentPresets: registry, loader }[service]),
    agents: { get: () => ({ session: {} }), turnBoundaryOf: () => boundary },
    connection: { browserPeer: peer },
    typertGateway: { async invoke({ namespace, method, args, peer: admitted, signal }) {
      assert.deepEqual({ namespace, method, agentId: args.agentId }, { namespace: 'agentPresets', method: 'select', agentId: 'session' })
      assert.equal(admitted, peer)
      assert.ok(signal instanceof AbortSignal)
      calls.push(['select', args.agentPreset])
      return args.agentPreset
    } },
    extend: ({ baseUrl: base }) => ({ agentPresets: { register: definition => registry.register(definition, base) } }),
  }
  const profileDir = join(home, options.profile ?? 'profile-a')
  const store = options.store ?? await createStructureStore({ home, profileDir })
  const editor = createStructureEditor(ctx, { store, decode: JSON.parse, canRunGraph: options.canRunGraph ?? (() => true),
    changed: id => calls.push(['changed', id]) })
  t.after(() => editor.close())
  return { editor, registry, definitions, source, boundary, calls, home, profileDir, store }
}

const clone = editor => editor.createStructure({ sourcePresetId: 'standard', name: 'Owned preset' })
const write = (editor, draft, changes) => editor.saveStructure(inputOf(draft, changes))
const publish = (editor, draft) => editor.publishStructure({ draftId: draft.draftId, expectedRevision: draft.revision })

test('source copies preserve group data and native expressions while normalizing missing owned row IDs', async t => {
  const { editor, source, definitions } = await fixture(t)
  const firstView = await editor.readStructure({ sourcePresetId: source.id })
  const secondView = await editor.readStructure({ sourcePresetId: source.id })
  assert.deepEqual(firstView, secondView)
  assert.equal(firstView.readOnly, true)
  assert.ok(firstView.rows[0].config[0].id)
  const draft = await clone(editor)
  assert.equal(draft.execution.mode, 'native')
  assert.equal(draft.published, undefined)
  const nested = draft.rows[0].config[0]
  assert.ok(nested.id)
  assert.deepEqual(draft.rows[0].disabled, originalRows[0].disabled)
  assert.deepEqual(nested.config, originalRows[0].config[0].config)
  assert.deepEqual(nested.custom, originalRows[0].config[0].custom)
  const saved = await write(editor, draft, { rows: [{ ...draft.rows[0], config: [{ ...nested, disabled: true }] }] })
  assert.equal(saved.baseDocument.rows[0].config[0].disabled, undefined)
  const publication = await publish(editor, saved)
  assert.equal(publication.activation, 'ready')
  assert.equal(publication.version, 1)
  assert.equal(publication.draft.hasUnpublishedChanges, false)
  assert.deepEqual(definitions.get(publication.presetId).plugins, saved.rows)
  assert.deepEqual(source.plugins, originalRows)
})

test('sources with ambiguous native provenance remain available to inspect', async t => {
  const { editor } = await fixture(t, { unknownBase: true })
  const roster = await editor.listStructures({ sessionId: 'session' })
  assert.equal(roster.sources[0].editableCopy, false)
  assert.equal((await editor.readStructure({ sourcePresetId: 'standard' })).rows[0].config[0].name, './fixture.mjs')
  await assert.rejects(clone(editor), { code: 'source-read-only' })
})

test('validation identifies nested duplicate IDs, protected rows and graph edges without mounting a plugin', async t => {
  const { editor, calls } = await fixture(t)
  const draft = await clone(editor)
  const execution = createStarterExecutionPlan()
  execution.edges[0].to = 'end'
  const rows = [...draft.rows, { id: draft.rows[0].config[0].id, name: 'duplicate' },
    { id: EXECUTION_PLAN_ROW_ID, name: './alias.mjs' }, { id: 'adapter', name: EXECUTION_PLAN_MODULE_URL }]
  const result = await editor.validateStructure(inputOf(draft, { rows, execution }))
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(issue => issue.code === 'duplicate-row-id'))
  assert.ok(result.issues.some(issue => issue.code === 'reserved-row-id'))
  assert.ok(result.issues.some(issue => issue.code === 'reserved-module'))
  assert.ok(result.issues.some(issue => issue.edgeId === 'model-tools' && issue.nodeId === 'model'))
  await assert.rejects(write(editor, draft, { rows, execution }), { code: 'invalid-structure' })
  assert.equal(calls.some(([action]) => action === 'register'), false)
})

test('competing draft writes share one revision and publish the saved document only', async t => {
  const { editor, definitions } = await fixture(t)
  const draft = await clone(editor)
  const [accepted, conflict] = await Promise.allSettled([
    write(editor, draft, { name: 'First draft' }),
    write(editor, draft, { name: 'Stale draft' }),
  ])
  assert.equal(accepted.status, 'fulfilled')
  assert.equal(conflict.reason.code, 'revision-conflict')
  await assert.rejects(publish(editor, draft), { code: 'revision-conflict' })
  const ready = await publish(editor, accepted.value)
  assert.equal(definitions.get(ready.presetId).name, 'First draft')
})

test('failed native activation retains the old publication and preserves the failed draft for repair', async t => {
  const { editor, definitions } = await fixture(t)
  const first = await publish(editor, await clone(editor))
  const saved = await write(editor, first.draft, { rows: [{ id: 'missing-row', name: 'missing-module' }] })
  await assert.rejects(publish(editor, saved), error => error.code === 'activation-failed'
    && error.message.includes('missing-row') && !error.message.includes('PRIVATE_PLUGIN_ERROR'))
  const after = await editor.readStructure({ draftId: saved.draftId })
  assert.equal(after.published.version, 1)
  assert.equal(after.revision, saved.revision)
  assert.equal(after.rows[0].name, 'missing-module')
  assert.deepEqual(definitions.get(first.presetId).plugins, first.draft.rows)
  const fixed = await write(editor, saved, { rows: [], execution: createStarterExecutionPlan() })
  const second = await publish(editor, fixed)
  assert.equal(second.presetId, first.presetId)
  assert.equal(second.version, 2)
  assert.equal(second.draft.rows.length, 0)
  const [generated] = definitions.get(second.presetId).plugins
  assert.equal(generated.id, EXECUTION_PLAN_ROW_ID)
  assert.equal(generated.config.publication.version, 2)
  assert.deepEqual(generated.config.execution, fixed.execution)
})

test('failed durable commit rolls back the staged native definition', async t => {
  const { editor, definitions, store } = await fixture(t)
  const first = await publish(editor, await clone(editor))
  const saved = await write(editor, first.draft, { name: 'Uncommitted publication' })
  const set = store.set
  store.set = async () => { throw new Error('PRIVATE_DISK_ERROR') }
  await assert.rejects(publish(editor, saved), { code: 'unavailable' })
  assert.equal(definitions.get(first.presetId).name, first.draft.name)
  assert.equal((await editor.readStructure({ draftId: saved.draftId })).published.version, 1)
  store.set = set
})

test('cold restore is profile-qualified, preserves publication identity, and defers native audit', async t => {
  const first = await fixture(t)
  const ready = await publish(first.editor, await clone(first.editor))
  await first.editor.close()
  assert.ok(!first.definitions.has(ready.presetId))
  const other = await fixture(t, { home: first.home, profile: 'profile-b' })
  await other.editor.restore()
  assert.equal((await other.editor.listStructures({ sessionId: 'session' })).drafts.length, 0)
  const cold = await fixture(t, { home: first.home })
  await cold.editor.restore()
  assert.deepEqual(cold.calls, [['register', ready.presetId], ['changed', undefined]])
  const read = await cold.editor.readStructure({ draftId: ready.draft.draftId })
  assert.deepEqual(read, ready.draft)
  assert.deepEqual(cold.definitions.get(ready.presetId).plugins, ready.draft.rows)
})

test('cold availability follows the native roster and an unchanged publication can be retried', async t => {
  const first = await fixture(t)
  const draft = await clone(first.editor)
  const ready = await publish(first.editor, await write(first.editor, draft, { rows: [{ id: 'fixture', name: 'installed-module' }] }))
  await first.editor.close()
  let missing = true
  const cold = await fixture(t, { home: first.home, isUnavailable: name => missing && name === 'installed-module' })
  await cold.editor.restore()
  const list = await cold.editor.listStructures({ sessionId: 'session' })
  assert.equal(list.drafts[0].publishedActivation, 'unavailable')
  assert.match(list.drafts[0].publishedReason, /"fixture"/u)
  assert.doesNotMatch(list.drafts[0].publishedReason, /PRIVATE_PLUGIN_ERROR/u)
  const detail = await cold.editor.readStructure({ draftId: draft.draftId })
  assert.equal(detail.published.activation, 'unavailable')
  assert.equal(detail.hasUnpublishedChanges, false)
  missing = false
  const retried = await publish(cold.editor, detail)
  assert.equal(retried.presetId, ready.presetId)
  assert.equal(retried.draft.published.activation, 'ready')
})

test('unsupported drivers can edit native compositions while graph publication waits for native capability', async t => {
  const first = await fixture(t)
  const native = await publish(first.editor, await clone(first.editor))
  const execution = createStarterExecutionPlan()
  const graph = await publish(first.editor, await write(first.editor, await clone(first.editor), { execution }))
  await first.editor.close()
  let supported = false
  const cold = await fixture(t, { home: first.home, canRunGraph: () => supported })
  await cold.editor.restore()
  assert.ok(cold.definitions.has(native.presetId))
  assert.ok(!cold.definitions.has(graph.presetId))
  const list = await cold.editor.listStructures({ sessionId: 'session' })
  assert.equal(list.capabilities.canExecuteGraph, false)
  assert.equal(list.drafts.find(draft => draft.publishedPresetId === graph.presetId).publishedActivation, 'unavailable')
  const checked = await cold.editor.validateStructure(inputOf(graph.draft))
  assert.ok(checked.issues.some(issue => issue.code === 'unsupported-driver'))
  await assert.rejects(publish(cold.editor, graph.draft), { code: 'unsupported-driver' })
  await assert.rejects(cold.editor.selectStructure({ sessionId: 'session', draftId: graph.draft.draftId, expectedRevision: graph.draft.revision }),
    { code: 'unsupported-driver' })
  supported = true
  await cold.editor.restore()
  assert.ok(cold.definitions.has(graph.presetId))
})

test('selection delegates only a published revision to the native owner route before the first turn', async t => {
  const { editor, calls, boundary } = await fixture(t)
  const draft = await clone(editor)
  const input = { sessionId: 'session', draftId: draft.draftId, expectedRevision: draft.revision }
  await assert.rejects(editor.selectStructure(input), { code: 'not-found' })
  const ready = await publish(editor, draft)
  await assert.rejects(editor.selectStructure(input), { code: 'revision-conflict' })
  const selection = { ...input, expectedRevision: ready.draft.revision }
  assert.deepEqual(await editor.selectStructure(selection), { presetId: ready.presetId, selected: true })
  boundary.lastTurn = 1
  assert.equal((await editor.listStructures(input)).capabilities.canSelectCurrent, false)
  await assert.rejects(editor.selectStructure(selection), { code: 'preset-locked' })
  assert.equal(calls.filter(([action]) => action === 'select').length, 1)
})
