import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRoutingJournal } from '../src/routing-journal.mjs'

const route = model => ({ provider: 'fixture', model })
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'loop-journal-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return createRoutingJournal({ home })
}
test('an interrupted new intent retains the prior confirmed ownership and original baseline', async t => {
  const journal = await fixture(t)
  journal.write({ schemaVersion: 1, sessionId: 'one', baseline: route('original'), selection: route('new-intent'), selectionSeq: 5,
    previous: { selection: route('confirmed'), selectionSeq: 3 } })
  const saved = journal.read({ id: 'one', snapshotEvents: () => [{ type: 'model/selection', seq: 3, data: route('confirmed') }] })
  assert.deepEqual(saved.baseline, route('original'))
  assert.equal(saved.selectionSeq, 3)
  assert.deepEqual(saved.selection, route('confirmed'))
})
test('a later external selection invalidates both ownership receipts', async t => {
  const journal = await fixture(t)
  journal.write({ schemaVersion: 1, sessionId: 'one', baseline: route('original'), selection: route('new-intent'), selectionSeq: 5,
    previous: { selection: route('confirmed'), selectionSeq: 3 } })
  assert.equal(journal.read({ id: 'one', snapshotEvents: () => [{ type: 'model/selection', seq: 6, data: route('external') }] }), null)
  assert.equal(journal.read({ id: 'fork-child', snapshotEvents: () => [{ type: 'model/selection', seq: 3, data: route('confirmed') }] }), null)
})
test('old receipts without previous remain readable and clear removes only their Session file', async t => {
  const journal = await fixture(t)
  for (const id of ['one', 'two']) journal.write({ schemaVersion: 1, sessionId: id, baseline: route('original'), selection: route('owned'), selectionSeq: 1 })
  const session = id => ({ id, snapshotEvents: () => [{ type: 'model/selection', seq: 1, data: route('owned') }] })
  assert.deepEqual(journal.read(session('one')).baseline, route('original'))
  journal.clear('one')
  assert.equal(journal.read(session('one')), null)
  assert.equal(journal.read(session('two')).selection.model, 'owned')
})
