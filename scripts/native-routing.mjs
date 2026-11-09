import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fixture, output, product, runtime, route, prompt } from './rc1-runtime.mjs'

const results = []
{
  let edited = false, retry = false
  const f = await fixture('edit-retry', { action: async ({ save }) => {
    if (!edited) { edited = true; await save({ 'host.first': route('first-edited', 333), 'host.continuation': route('continuation-edited', 444) }) }
    if (!retry) { retry = true; throw new Error('LOCAL_PRODUCT_RETRY') }
  } })
  f.agent.ctx.on('agent/request-error', async (_payload, next) => await next() ?? { kind: 'retry' })
  await f.save({ 'host.first': route('first', 111), 'host.continuation': route('continuation', 222) })
  await f.run('ONE'); await f.run('TWO')
  assert.deepEqual(f.result.requests.map(x => [x.model, x.maxTokens]), [['first', 111], ['first', 111], ['continuation-edited', 444], ['first-edited', 333], ['continuation-edited', 444]])
  results.push(await f.finish())
  assert.equal(results.at(-1).afterClose.model, 'baseline')
}
{
  let closed = false, retried = false
  const f = await fixture('active-unload', { action: async ({ host }) => {
    if (!closed) { closed = true; await host.close() }
    if (!retried) { retried = true; throw new Error('ACTIVE_UNLOAD_RETRY') }
  } })
  f.agent.ctx.on('agent/request-error', async (_payload, next) => await next() ?? { kind: 'retry' })
  await f.save({ 'host.first': route('first', 111), 'host.continuation': route('continuation', 222) })
  await f.run('ACTIVE')
  assert.deepEqual(f.result.requests.map(x => [x.model, x.maxTokens]), [['first', 111], ['first', 111], ['baseline', 512]])
  results.push(await f.finish({ closeHost: false }))
}
{
  let changed = false
  const f = await fixture('external-pending', { action: async ({ agent, host }) => {
    if (!changed) { changed = true; agent.model.select(route('user-pending')); await host.close() }
  } })
  await f.save({ 'host.first': route('first', 111), 'host.continuation': route('continuation', 222) })
  await f.run('PENDING')
  assert.deepEqual(f.result.requests.map(x => [x.model, x.maxTokens]), [['first', 111], ['user-pending', 512]])
  assert.equal(f.agent.model.current().model, 'user-pending')
  const value = { ...f.result, events: f.agent.session.snapshotEvents(), afterClose: f.agent.model.current() }
  await f.ctx.fiber.dispose(); results.push(value)
}
{
  let cancelled = false
  const f = await fixture('cancel-steer', { action: async ({ agent }) => {
    if (!cancelled) { cancelled = true; agent.cancel({ kind: 'user' }); agent.steer(prompt('STEER_AFTER_CANCEL')) }
  } })
  await f.save({ 'host.first': route('first'), 'host.continuation': route('continuation') })
  await f.run('CANCEL')
  assert.deepEqual(f.result.requests.map(x => x.model), ['first', 'first', 'continuation'])
  results.push(await f.finish())
}
{
  const f = await fixture('cold-owner')
  await f.save({ 'host.first': route('first'), 'host.continuation': route('continuation') })
  await f.run('BEFORE_COLD')
  const seed = f.agent.session.snapshotEvents(), home = f.result.home
  // Process-stop analogue: dispose Agent scope without invoking plugin close/baseline restoration.
  const value = { ...f.result, events: seed, selection: f.agent.model.current() }
  await f.ctx.fiber.dispose()
  const reopened = await fixture('cold-owner', { home, seed })
  assert.equal(reopened.agent.model.current().model, 'continuation')
  const final = await reopened.finish()
  assert.equal(final.afterClose.model, 'baseline')
  assert.equal((await readdir(join(home, 'app-data/loop-studio/routing-owners'))).length, 0)
  results.push({ ...value, coldRestored: final.afterClose })
}
{
  const journal = { read: () => null, write() { throw new Error('LOCAL_JOURNAL_IO_FAILURE') }, clear() {} }
  const f = await fixture('journal-io', { journal })
  await assert.rejects(f.save({ 'host.first': route('first') }), /LOCAL_JOURNAL_IO_FAILURE/)
  await f.run('MUST_NOT_REQUEST')
  assert.equal(f.result.requests.length, 0)
  assert.ok(f.result.errors.some(error => /LOCAL_JOURNAL_IO_FAILURE/.test(error.message)))
  results.push(await f.finish())
}
await writeFile(join(output, 'loop-product-runtime-results.json'), JSON.stringify({ assertions: 'PASS', runtime, product,
  productSha256: createHash('sha256').update(await readFile(product)).digest('hex'), productionLoop: true,
  productionSessions: true, mockedBoundary: 'owner Remote snapshot authorization only; no network, no user data',
  externalModelCalls: 0, results }, null, 2) + '\n')
console.log(JSON.stringify({ result: 'REAL_RC1_LOOP_PRODUCT_PASS', cases: results.length, product }))
