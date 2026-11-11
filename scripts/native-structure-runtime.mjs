import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const profile = 'loop-structure-test'
const name = 'dsh-loop-studio'
const probePath = '/api/loop-structure-probe'
export const sourcePreset = 'structure-fixture-source'
export const structureProvider = 'loop-structure-local'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const redact = value => String(value).replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]')
export const save = (directory, name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n')

function localEnvironment(home) {
  const systemKeys = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programdata|programfiles(?:\(x86\))?|userprofile|home|shell|lang|xdg_data_home|pnpm_home)$/i
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.test(key))),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
}

export async function prepareStructureRuntime(archiveInput, outputInput) {
  assert.ok(archiveInput && outputInput && process.env.DSH_RUNTIME_DIR,
    'Set DSH_RUNTIME_DIR, then pass an exact plugin tarball and an output directory.')
  const runtime = resolve(process.env.DSH_RUNTIME_DIR)
  const archive = await realpath(resolve(archiveInput))
  const output = resolve(outputInput)
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(join(output, 'native-'))
  const home = join(directory, 'home')
  const fixture = join(directory, 'fixture')
  await mkdir(home)
  await mkdir(fixture)
  await mkdir(join(directory, 'workspace'))
  // The native include intentionally has its own base. Its preset declaration uses the same built-in runtime package.
  await mkdir(join(fixture, 'node_modules'))
  await symlink(join(runtime, 'node_modules', '@deepseek-ai'), join(fixture, 'node_modules', '@deepseek-ai'),
    process.platform === 'win32' ? 'junction' : 'dir')
  await Promise.all(['structure-source.yml', 'structure-source-row.mjs', 'structure-source-resource.txt', 'structure-probe.mjs']
    .map(file => copyFile(join(repo, 'tests', 'fixtures', file), join(fixture, file))))
  const patch = join(fixture, 'host.patch.yml')
  await writeFile(patch, [
    '- id: session-title-llm', '  disabled: true',
    '- id: llm-deepseek', '  disabled: true',
    '- id: llm-deepseek-account', '  disabled: true',
    '- id: llm-pi-ai', '  disabled: true',
    '- id: agent-default-model', '  config:', '    provider: ' + structureProvider, '    model: configured',
    '- id: tool-executor-native', '  disabled: false',
    '- id: tool-executor-ptc', '  disabled: true',
    '- insert:', '    - id: loop-structure-test-include', "      name: 'cordis:include'", '      config:',
    '        path: ' + JSON.stringify(pathToFileURL(join(fixture, 'structure-source.yml')).href),
    '',
  ].join('\n'))
  const node = process.env.DSH_NATIVE_NODE ?? process.execPath
  const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const env = localEnvironment(home)
  async function runCli(label, args) {
    try {
      const result = await exec(node, ['--expose-internals', cli, ...args], { cwd: fixture, env, windowsHide: true, timeout: 90_000 })
      await save(directory, label + '.json', { args, stdout: redact(result.stdout), stderr: redact(result.stderr), exitCode: 0 })
      return result.stdout.trim()
    } catch (error) {
      const details = redact((error.stderr ?? '') + (error.stdout ?? ''))
      await save(directory, label + '.json', { args, details, exitCode: error.code, signal: error.signal })
      throw Error(label + ' failed: ' + details, { cause: error })
    }
  }
  const version = await runCli('runtime-version', ['--version'])
  assert.equal(version, '0.2.2-rc.1')
  await runCli('initialize', ['--profile', profile, '--from-default-profile', 'web', '--help'])
  await runCli('install', ['plugin', '--profile', profile, 'add', archive])

  const installed = await realpath(join(home, 'profiles', profile, 'node_modules', name))
  assert.ok(!relative(home, installed).startsWith('..'), 'Installation must resolve inside the owned test home')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, name)
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
  const members = {}
  const packageFiles = ['package.json', 'dist/host.js', 'dist/client.js', 'cordis.patch.yml']
  const executionExport = manifest.exports['./execution']
  if (executionExport) packageFiles.push(executionExport.replace(/^\.\//, ''))
  for (const member of packageFiles) {
    const { stdout } = await exec(tar, ['-xOf', archive, 'package/' + member], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
    const expected = sha(stdout)
    assert.equal(sha(await readFile(join(installed, member))), expected, 'Installed bytes differ for ' + member)
    members[member] = expected
  }
  const identity = { runtime, version, node, cliSha256: sha(await readFile(cli)), archive, archiveSha256: sha(await readFile(archive)),
    installed, productVersion: manifest.version, members, home }
  await save(directory, 'identity.json', identity)
  const protectedPaths = [
    join(fixture, 'structure-source.yml'), join(fixture, 'structure-source-row.mjs'), join(fixture, 'structure-source-resource.txt'),
    ...['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'].map(file => join(home, 'profiles', profile, file)),
  ]
  async function configurationHashes() {
    return Object.fromEntries(await Promise.all(protectedPaths.map(async path => [path, sha(await readFile(path))])))
  }

  async function start(phase) {
    const hostDirectory = join(directory, phase)
    await mkdir(hostDirectory)
    const args = ['--expose-internals', cli, '--profile', profile, '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open']
    const child = spawn(node, args, { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const processReceipt = { pid: child.pid, args, home }
    let logs = ''
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { logs += chunk })
    const stopped = new Promise(done => {
      child.once('error', error => done({ error: error.message }))
      child.once('close', (exitCode, signal) => done({ exitCode, signal }))
    })
    let ended
    void stopped.then(result => { ended = result })
    let cookie
    let url
    async function request(path, input, options = {}) {
      const { authenticated = true, allowError = false, headers = {} } = options
      const response = await fetch(new URL(path, url), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}), ...headers },
        body: JSON.stringify(input),
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { text: redact(text.slice(0, 500)) } }
      if (allowError) return { status: response.status, body }
      assert.ok(response.ok && !body.error, path + ' failed with ' + response.status + ': ' + JSON.stringify(body))
      return body
    }
    const probe = async (action, args = {}) => (await request(probePath, { action, ...args })).result
    async function close() {
      if (!ended && cookie) {
        await probe('exit').catch(() => {})
        const deadline = Date.now() + 10_000
        while (!ended && Date.now() < deadline) await sleep(50)
      }
      if (!ended) child.kill('SIGTERM')
      const exit = await stopped
      await save(hostDirectory, 'process.json', { ...processReceipt, ...exit })
      await writeFile(join(hostDirectory, 'host.log'), redact(logs))
      return exit
    }
    try {
      const deadline = Date.now() + 35_000
      while (Date.now() < deadline && !ended) {
        url = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/.exec(logs)?.[0]
        if (url) break
        await sleep(50)
      }
      assert.ok(url, 'Host did not start: ' + redact(logs.slice(-3500)))
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
      assert.ok(cookie, 'Owner cookie exchange failed with ' + response.status)
      const ready = await probe('ready')
      await save(hostDirectory, 'ready.json', ready)
      assert.equal(ready.pid, child.pid)
      assert.equal(ready.loop, true)
      const source = ready.presets.find(preset => preset.id === sourcePreset)
      assert.ok(source, 'Fixture source preset is missing from the native registry')
      assert.equal(source.broken, undefined)
      return { directory: hostDirectory, base: new URL(url).origin, url, request, probe, close, ready }
    } catch (error) {
      await close()
      throw error
    }
  }

  return { directory, identity, start, configurationHashes }
}
