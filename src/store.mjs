import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { LoopError, validatePolicy } from './core.mjs'

async function writeJson(path, value, mode) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** One serialized, revisioned policy store per plugin instance/DSH home. */
export async function createPolicyStore({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh'), directory = join(home, 'app-data', 'loop-studio') } = {}) {
  const path = join(resolve(directory), 'policies.json')
  let state = { schemaVersion: 1, revision: 0, sessions: {}, presets: {} }
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'))
    if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || !saved.sessions || !saved.presets) throw new Error('Unsupported Loop Studio policy data.')
    for (const records of [saved.sessions, saved.presets]) for (const policy of Object.values(records)) validatePolicy(policy)
    state = saved
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let pending = Promise.resolve()

  function target(input) {
    const key = input.scope === 'session' ? input.sessionId : input.scope === 'preset' ? input.presetId : undefined
    if (typeof key !== 'string' || !key || key.length > 256) throw new LoopError('bad-request', 'A valid policy scope and identity are required.')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new LoopError('bad-request', 'expectedRevision is required.')
    return { table: input.scope === 'session' ? 'sessions' : 'presets', key }
  }

  function write(input, reset) {
    const operation = pending.then(async () => {
      const { table, key } = target(input)
      if (input.expectedRevision !== state.revision) throw new LoopError('revision-conflict', 'The policy changed. Reload before saving.', 409)
      const next = structuredClone(state)
      if (reset) delete next[table][key]
      else Object.defineProperty(next[table], key, { value: validatePolicy(input.policy), enumerable: true, configurable: true, writable: true })
      next.revision += 1
      await writeJson(path, next)
      state = next
      return { revision: state.revision }
    })
    pending = operation.catch(() => {})
    return operation
  }

  return {
    read({ sessionId, presetId } = {}) {
      return structuredClone({ revision: state.revision, policies: {
        session: Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : null,
        preset: Object.hasOwn(state.presets, presetId) ? state.presets[presetId] : null,
      } })
    },
    savePolicy: input => write(input, false),
    resetPolicy: input => write(input, true),
  }
}

/** Drafts and the last successful publication share one atomic profile document. */
export async function createStructureStore({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  directory = join(home, 'app-data', 'loop-studio'), profileDir } = {}) {
  const profile = profileDir ? createHash('sha256').update(resolve(profileDir)).digest('hex') : undefined
  const path = join(resolve(directory), profile ? `structures.${profile}.json` : 'structures.json')
  let records = new Map()
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'))
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.drafts)) throw new Error('Unsupported Loop Studio structure data.')
    for (const record of saved.drafts) {
      if (typeof record?.id !== 'string' || records.has(record.id)) throw new Error('Invalid Loop Studio structure identity.')
      records.set(record.id, record)
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  return {
    list: () => structuredClone([...records.values()]),
    get: id => structuredClone(records.get(id)),
    publishedVersion: id => records.get(id)?.published?.version,
    async set(record) {
      const next = new Map(records).set(record.id, structuredClone(record))
      await writeJson(path, { schemaVersion: 1, drafts: [...next.values()] }, 0o600)
      records = next
    },
  }
}
