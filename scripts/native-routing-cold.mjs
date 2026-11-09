import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, output, product, runtime, route } from './rc1-runtime.mjs'

const mode = process.argv[2], home = process.argv[3]
if (mode === 'write') {
  const f = await fixture('cold-process', { home, persistence: true })
  await f.save({ 'host.first': route('first'), 'host.continuation': route('continuation') })
  await f.run('OWNED_PROCESS_COLD_FIXTURE')
  await f.ctx.sessionPersistence.flush()
  assert.equal(f.agent.model.current().model, 'continuation')
  await writeFile(join(home, 'before.json'), JSON.stringify({ pid: process.pid, selection: f.agent.model.current(), events: f.agent.session.snapshotEvents() }, null, 2))
  // End this owned process after the real JSONL backend flushed, without plugin cleanup.
  process.exit(0)
}
if (mode === 'read') {
  const f = await fixture('cold-process', { home, persistence: true, resume: true })
  const before = JSON.parse(await readFile(join(home, 'before.json'), 'utf8'))
  assert.equal(f.agent.model.current().model, 'continuation')
  assert.deepEqual(f.agent.session.snapshotEvents().slice(0, before.events.length), before.events)
  await f.host.close()
  assert.equal(f.agent.model.current().model, 'baseline')
  await f.ctx.sessionPersistence.flush()
  await writeFile(join(home, 'after.json'), JSON.stringify({ pid: process.pid, selection: f.agent.model.current(), prefixEqual: true,
    events: f.agent.session.snapshotEvents() }, null, 2))
  await f.ctx.fiber.dispose()
  process.exit(0)
}
const runHome = join(output, `cold-whole-process-${Date.now()}`)
const children = []
for (const phase of ['write', 'read']) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase, runHome], { encoding: 'utf8', windowsHide: true })
  children.push({ phase, exitCode: child.status, stdout: child.stdout, stderr: child.stderr })
  assert.equal(child.status, 0, child.stderr || child.stdout)
}
const before = JSON.parse(await readFile(join(runHome, 'before.json'), 'utf8'))
const after = JSON.parse(await readFile(join(runHome, 'after.json'), 'utf8'))
assert.notEqual(before.pid, after.pid)
await writeFile(join(output, 'loop-cold-process-results.json'), JSON.stringify({ assertions: 'PASS', runtime, product,
  home: runHome, realSessionPersistence: true, compression: 'none', independentOwnedProcessIds: [before.pid, after.pid],
  before: before.selection, after: after.selection, canonicalPrefixEqual: after.prefixEqual, children }, null, 2) + '\n')
console.log('LOOP_REAL_RC1_JSONL_WHOLE_PROCESS_COLD_PASS')
