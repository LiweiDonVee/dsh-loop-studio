import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, output, product, route } from './rc1-runtime.mjs'

const phase = process.argv[2]
if (phase) {
  const config = JSON.parse(process.argv[3]), initialMaxTokens = config.cap
  const f = await fixture('cap-cold-probe', { home: config.home, persistence: true, resume: phase === 'read',
    mountProduct: phase === 'write' || config.mode !== 'no-module', initialMaxTokens })
  if (phase === 'write') {
    const model = config.different ? 'routed' : 'baseline'
    await f.save({ 'host.first': route(model, 256), 'host.continuation': route(model, 256) })
    await f.run('BEFORE_COLD')
    if (config.close) await f.host.close()
    await f.ctx.sessionPersistence.flush()
    await writeFile(join(config.home, 'write.json'), JSON.stringify({ pid: process.pid, requests: f.result.requests,
      selection: f.agent.model.current(), header: f.agent.session.requestHeader(), events: f.agent.session.snapshotEvents() }, null, 2))
    process.exit(0)
  }
  const before = JSON.parse(await readFile(join(config.home, 'write.json'), 'utf8'))
  assert.deepEqual(f.agent.session.snapshotEvents().slice(0, before.events.length), before.events)
  if (config.mode === 'policy-off') await f.save({}, false)
  await f.run('FIRST_AFTER_COLD')
  if (config.mode === 'policy-on') { await f.save({}, false); await f.run('DISABLE_AFTER_COLD') }
  await f.ctx.sessionPersistence.flush()
  const value = { pid: process.pid, moduleMounted: config.mode !== 'no-module', firstAfterCold: f.result.requests.slice(0, 2),
    afterDisable: f.result.requests.slice(2), selection: f.agent.model.current(), oldHeader: before.header,
    beforePid: before.pid, prefixEqual: true }
  await writeFile(join(config.home, 'read.json'), JSON.stringify(value, null, 2))
  await f.host?.close(); await f.ctx.fiber.dispose(); process.exit(0)
}
const results = []
for (const cap of [512, null]) for (const mode of ['no-module', 'policy-off', 'policy-on']) {
  for (const different of mode === 'no-module' ? [false, true] : [false]) {
    const config = { cap, mode, different, close: mode !== 'policy-on',
      home: join(output, `control-cold-${Date.now()}-${cap ?? 'auto'}-${mode}-${different}`) }
    for (const stage of ['write', 'read']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), stage, JSON.stringify(config)], { encoding: 'utf8', windowsHide: true })
      assert.equal(child.status, 0, child.stderr || child.stdout)
    }
    const value = JSON.parse(await readFile(join(config.home, 'read.json'), 'utf8'))
    const observed = mode === 'policy-on' ? value.afterDisable : value.firstAfterCold
    const actualCaps = observed.map(request => request.maxTokens ?? null)
    results.push({ ...config, ...value, expectedCaps: [cap, cap], actualCaps, pass: actualCaps.every(actual => actual === cap) })
  }
}
const result = { product, status: results.every(item => item.pass) ? 'PASS' : 'FAIL',
  modelCalls: 'Local deterministic adapter only', cases: results }
await writeFile(join(output, process.env.DSH_CAP_PROBE_RESULT ?? 'loop-control-cold-results.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: result.status, cases: results.map(item => ({ cap: item.cap, mode: item.mode, different: item.different, actualCaps: item.actualCaps, pass: item.pass })) }))

assert.equal(result.status, 'PASS')
