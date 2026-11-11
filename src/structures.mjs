import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { LoopError } from './core.mjs'
import { createStructureStore } from './store.mjs'
import { detachedJson, identity, isGroup, presetIdFor, record, validateStructureDocument } from './structure-document.mjs'
import { createNativeExecutionPlan, validateExecutionPlan } from './plan.mjs'
import { EXECUTION_PLAN_MODULE_URL, EXECUTION_PLAN_ROW_ID, materializeExecutionRows } from './plan-publication.mjs'

const DECLARATION = '@deepseek-ai/dsh-agent-preset'
const NO_SELECTION = 'Open a new session to use a published preset.'
const READ_ONLY = 'DSH did not identify a unique resolution base for this preset.'
const NO_GRAPH = 'Published execution graphs require the native DSH Agent Loop.'
const READY = Object.freeze({ activation: 'ready' })
const protectedRow = { protectedId: EXECUTION_PLAN_ROW_ID, protectedModule: EXECUTION_PLAN_MODULE_URL }
const notFound = () => new LoopError('not-found', 'The requested preset or draft is unavailable.', 404)
const unavailable = () => new LoopError('unavailable', 'Preset structure editing is unavailable in this host.', 503)
const unsupportedDriver = () => new LoopError('unsupported-driver', NO_GRAPH, 422)
const sourceRef = source => ({ presetId: source.id, name: source.name })
const changedSincePublication = draft => !isDeepStrictEqual(draft.document, draft.published?.document)

function fileBase(value) {
  if (typeof value !== 'string') return undefined
  try { return new URL(value).protocol === 'file:' ? value : undefined } catch { return undefined }
}

async function parseNativeRows(content, anchor) {
  const include = createRequire(anchor).resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema } = await import(pathToFileURL(include).href)
  const yaml = createRequire(include)('js-yaml')
  return yaml.load(content, { schema: entryListSchema })
}

function checkedDocument(input, { assignIds = false } = {}) {
  const result = validateStructureDocument(input, { assignIds, ...protectedRow })
  if (result.document) {
    try {
      const plan = result.document.execution === undefined ? createNativeExecutionPlan() : result.document.execution
      result.document.execution = validateExecutionPlan(plan)
    } catch (error) {
      if (!(error instanceof LoopError)) throw error
      for (const issue of error.issues ?? [{ code: error.code, message: error.message }]) {
        result.issues.push({ severity: 'error', field: 'execution', ...issue })
      }
    }
  }
  return result
}

function invalid(issues) {
  const error = new LoopError('invalid-structure', 'Review the structure validation issues before saving.', 422)
  if (issues?.length) error.issues = issues
  return error
}

/** Native diagnostics may include values supplied by a plugin. Expose matching row IDs only. */
function activationFailed(broken, rows = []) {
  const problems = typeof broken === 'string' ? broken.split('\n') : []
  const blocked = new Set()
  const stack = [rows]
  while (stack.length) {
    for (const row of stack.pop()) {
      if (isGroup(row)) stack.push(row.config)
      if (problems.some(line => line.startsWith(`${row.id} (${row.name}):`))) blocked.add(row.id)
    }
  }
  const detail = blocked.size ? ` Check plugin rows ${[...blocked].map(id => JSON.stringify(id)).join(', ')}.`
    : ' Review its modules, configuration, and service requirements.'
  const error = new LoopError('activation-failed', `DSH could not activate this composition.${detail}`, 422)
  if (blocked.size) error.issues = [...blocked].map(rowId => ({ severity: 'error', code: 'activation-failed',
    message: 'Check that this plugin is installed and its service requirements are available.', rowId, field: 'name',
  }))
  return error
}

function waitForNative(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function loaderEntries(ctx) {
  return [...(ctx.get('loader')?.entries?.() ?? [])]
}

function modulesIn(rows) {
  const names = new Set()
  const stack = [rows]
  while (stack.length) {
    const list = stack.pop()
    if (!Array.isArray(list)) continue
    for (const row of list) {
      if (!record(row)) continue
      if (isGroup(row)) stack.push(row.config)
      else if (identity(row.name)) names.add(row.name)
    }
  }
  return names
}

function pluginCatalog(ctx, ownRows) {
  const catalog = new Map()
  const add = (moduleName, source) => {
    if (!identity(moduleName) || [DECLARATION, 'dsh-loop-studio/execution', EXECUTION_PLAN_MODULE_URL].includes(moduleName) || catalog.has(moduleName)) return
    catalog.set(moduleName, { moduleName, label: moduleName, source })
  }
  for (const moduleName of modulesIn(ownRows)) add(moduleName, 'preset')
  const portable = name => typeof name === 'string' && /^(?:@[^/]+\/)?[\w-][\w./-]*$/.test(name)
  for (const entry of loaderEntries(ctx)) {
    const row = entry.options
    if (row?.name === DECLARATION) {
      for (const moduleName of modulesIn(row.config?.plugins)) if (portable(moduleName)) add(moduleName, 'preset')
    } else if (portable(row?.name)) add(row.name, 'installed')
  }
  return [...catalog.values()].sort((a, b) => a.moduleName.localeCompare(b.moduleName))
}

function draftListRow(draft, status) {
  return {
    id: draft.id, name: draft.document.name, revision: draft.revision,
    ...(draft.published ? { publishedPresetId: draft.published.presetId, publishedVersion: draft.published.version,
      publishedActivation: status.activation, ...(status.reason ? { publishedReason: status.reason } : {}) } : {}),
    hasUnpublishedChanges: changedSincePublication(draft),
  }
}

function draftView(ctx, draft, status) {
  return {
    draftId: draft.id, revision: draft.revision, source: draft.source, ...draft.document,
    readOnly: false, baseDocument: draft.published?.document ?? draft.baseDocument,
    ...(draft.published ? { published: { presetId: draft.published.presetId, version: draft.published.version, ...status } } : {}),
    hasUnpublishedChanges: changedSincePublication(draft), catalog: pluginCatalog(ctx, draft.document.rows),
  }
}

function rowsForView(rows) {
  const seen = new Set()
  let index = 0
  function normalize(list) {
    return list.filter(row => record(row) && identity(row.name)).map(row => {
      let id = row.id
      if (!identity(id) || seen.has(id)) do { id = `source-row-${++index}` } while (seen.has(id))
      seen.add(id)
      return { ...row, id, ...(isGroup(row) ? { config: normalize(Array.isArray(row.config) ? row.config : []) } : {}) }
    })
  }
  return normalize(rows)
}

/** One profile-local editor. The registry still owns mounts and their retained Agent revisions. */
export function createStructureEditor(ctx, { store, storeOptions, decode = parseNativeRows, changed = () => {},
  canRunGraph = () => ctx.get('agentLoop')?.constructor?.name === 'AgentLoop' } = {}) {
  const registry = ctx.get('agentPresets')
  const registrations = new Map()
  const lifetime = new AbortController()
  let pending = Promise.resolve()
  let openStore
  let closeTask

  function getStore() {
    const profile = ctx.get('profileContext')
    openStore ??= store ? Promise.resolve(store) : createStructureStore({
      home: profile?.home, profileDir: profile?.dir, ...storeOptions,
    })
    return openStore
  }

  function serialize(signal, action) {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const task = pending.then(async () => {
      combined.throwIfAborted()
      if (!registry?.readDocument || !registry?.register) throw unavailable()
      const library = await getStore()
      combined.throwIfAborted()
      return action(library, combined)
    })
    pending = task.catch(() => {})
    return task
  }

  function currentDraft(library, id, expectedRevision) {
    const draft = library.get(id)
    if (!draft) throw notFound()
    if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
      throw new LoopError('revision-conflict', 'This draft changed. Reload before applying your edits.', 409)
    }
    return draft
  }

  function publicationStatus(draft, metadata) {
    if (!draft.published) return undefined
    if (draft.published.document.execution.mode === 'graph' && !canRunGraph()) return { activation: 'unavailable', reason: NO_GRAPH }
    if (!registrations.has(draft.published.presetId) || !metadata) {
      return { activation: 'unavailable', reason: 'The saved publication is unavailable in the DSH preset registry.' }
    }
    return metadata.broken ? { activation: 'unavailable', reason: activationFailed(metadata.broken, draft.published.document.rows).message } : READY
  }

  async function readPublicationStatus(draft, signal) {
    if (!draft.published) return undefined
    const id = draft.published.presetId
    let metadata
    if (registrations.has(id)) {
      try { metadata = await waitForNative(registry.resolve(id), signal) }
      catch (error) { if (error?.code !== 'agent-preset/not-found') throw error }
    }
    return publicationStatus(draft, metadata)
  }

  async function readSource(presetId, signal, known) {
    let native
    try { native = await registry.readDocument(presetId) }
    catch (error) {
      if (error?.code === 'agent-preset/not-found') throw notFound()
      return { id: presetId, name: known?.name ?? presetId, description: known?.description ?? '', rows: [], reason: 'DSH could not read the preset declaration.' }
    }
    const declarations = loaderEntries(ctx).filter(entry => entry.options?.name === DECLARATION
      && entry.options.config?.id === presetId && entry.fiber?.state === 2)
    const source = { id: presetId, name: native.name ?? presetId, description: native.description ?? '', rows: [] }
    const anchors = [ctx.get('profileContext')?.installAnchor, fileBase(ctx.baseUrl),
      fileBase(declarations[0]?.fiber.ctx.baseUrl), fileBase(ctx.get('loader')?.context?.baseUrl)]
    let decoded = false
    for (const anchor of new Set(anchors)) {
      try {
        source.rows = detachedJson(await decode(native.content, anchor))
        decoded = true
        break
      } catch { /* Try the next native resolution base. */ }
    }
    if (!decoded) {
      if (declarations.length === 1) {
        try { source.rows = detachedJson(declarations[0].options.config.plugins) } catch { /* No lossless view is available. */ }
      }
      return { ...source, rows: Array.isArray(source.rows) ? source.rows : [], reason: 'DSH could not decode this preset as an editable native declaration.' }
    }
    if (!Array.isArray(source.rows)) return { ...source, rows: [], reason: 'This preset does not declare an ordered plugin list.' }
    const matches = declarations.filter(entry => isDeepStrictEqual(entry.options.config.plugins, source.rows))
    let baseUrl = matches.length === 1 ? fileBase(matches[0].fiber.ctx.baseUrl) : undefined
    if (!baseUrl && declarations.length === 0) {
      const metadata = known ?? await waitForNative(registry.resolve(presetId), signal)
      const generations = registry.inspectCompositions?.().filter(entry => entry.id === presetId) ?? []
      if (!metadata.broken && generations.length === 1) {
        const bases = new Set(generations[0].modules.filter(row => row.useHostBase).map(row => row.baseUrl))
        if (bases.size === 1) baseUrl = fileBase([...bases][0])
      }
    }
    if (!baseUrl) return { ...source, reason: READ_ONLY }
    const preview = validateStructureDocument({ name: source.name, description: source.description, rows: source.rows },
      { assignIds: true, ...protectedRow })
    return preview.issues.length ? { ...source, reason: 'This preset contains plugin rows that cannot be copied as a native structure.' } : { ...source, baseUrl }
  }

  function selectionFor(sessionId) {
    const agent = ctx.agents.get?.(sessionId)
    if (agent && ctx.agents.turnBoundaryOf) {
      const boundary = ctx.agents.turnBoundaryOf(agent.session)
      if (boundary.openTurnStartSeq === null && boundary.lastTurn === 0) return { canSelectCurrent: true }
    }
    return { canSelectCurrent: false, selectionReason: NO_SELECTION }
  }

  async function register(draft, publication) {
    const { document, presetId, version } = publication
    const baseUrl = fileBase(draft.baseUrl)
    if (!baseUrl || presetId !== presetIdFor(draft.id) || !Number.isSafeInteger(version) || version < 1) throw invalid()
    const checked = checkedDocument(document)
    if (checked.issues.length) throw invalid(checked.issues)
    const { name, description, rows, execution } = checked.document
    const owner = ctx.extend({ baseUrl })
    const dispose = await owner.agentPresets.register({
      id: presetId, name, description, plugins: [...rows, ...materializeExecutionRows({ execution, presetId, version })],
    })
    registrations.set(presetId, dispose)
  }

  async function unregister(presetId) {
    const dispose = registrations.get(presetId)
    registrations.delete(presetId)
    await dispose?.()
  }

  return {
    restore() {
      return serialize(undefined, async (library, signal) => {
        // Native registration can happen during Loader activation. Its later
        // diagnostic may await the Host Loader, so audit on an owner request.
        let restored = false
        for (const draft of library.list()) {
          signal.throwIfAborted()
          if (!draft.published || registrations.has(draft.published.presetId)) continue
          if (draft.published.document.execution.mode === 'graph' && !canRunGraph()) continue
          try { await register(draft, draft.published); restored = true }
          catch { ctx.logger?.warn('A saved Loop Studio preset could not be registered.') }
        }
        if (restored) changed()
      })
    },
    async publishedVersion(presetId) {
      try { return (await openStore)?.publishedVersion?.(presetId.slice('loop-studio.'.length)) }
      catch { return undefined }
    },
    listStructures({ sessionId }, signal) {
      return serialize(signal, async (library, active) => {
        const drafts = library.list()
        const published = new Set(drafts.map(draft => draft.published?.presetId))
        const roster = await waitForNative(registry.list(), active)
        const byId = new Map(roster.map(preset => [preset.id, preset]))
        const sources = await Promise.all(roster.filter(preset => !published.has(preset.id)).map(async preset => {
          const source = await readSource(preset.id, active, preset)
          return { id: source.id, name: source.name, description: source.description, editableCopy: Boolean(source.baseUrl),
            ...(source.reason ? { reason: source.reason } : {}) }
        }))
        active.throwIfAborted()
        const canExecuteGraph = canRunGraph(sessionId)
        return { sources, drafts: drafts.map(draft => draftListRow(draft, publicationStatus(draft, byId.get(draft.published?.presetId)))),
          capabilities: { ...selectionFor(sessionId), canExecuteGraph, ...(canExecuteGraph ? {} : { executionReason: NO_GRAPH }) } }
      })
    },
    readStructure({ draftId, sourcePresetId }, signal) {
      return serialize(signal, async (library, active) => {
        if (draftId !== undefined) {
          const draft = currentDraft(library, draftId)
          return draftView(ctx, draft, await readPublicationStatus(draft, active))
        }
        const source = await readSource(sourcePresetId, active)
        active.throwIfAborted()
        return { source: sourceRef(source), name: source.name, description: source.description, rows: rowsForView(source.rows), readOnly: true,
          editableCopy: Boolean(source.baseUrl), ...(source.reason ? { reason: source.reason } : {}), catalog: pluginCatalog(ctx, source.rows) }
      })
    },
    createStructure({ sourcePresetId, name, description = '' }, signal) {
      return serialize(signal, async (library, active) => {
        const source = await readSource(sourcePresetId, active)
        if (!source.baseUrl) throw new LoopError('source-read-only', source.reason ?? READ_ONLY, 409)
        const checked = checkedDocument({ name, description, rows: source.rows }, { assignIds: true })
        if (checked.issues.length) throw invalid(checked.issues)
        const draft = { id: randomUUID(), revision: 1, source: sourceRef(source), baseUrl: source.baseUrl,
          baseDocument: checked.document, document: checked.document }
        const result = draftView(ctx, draft)
        active.throwIfAborted()
        await library.set(draft)
        changed()
        return result
      })
    },
    validateStructure({ sessionId, draftId, expectedRevision, document }, signal) {
      return serialize(signal, library => {
        currentDraft(library, draftId, expectedRevision)
        const { issues } = checkedDocument(document, { assignIds: true })
        if (document?.execution?.mode === 'graph' && !canRunGraph(sessionId)) {
          issues.push({ severity: 'error', code: 'unsupported-driver', message: NO_GRAPH, field: 'execution' })
        }
        return { valid: issues.length === 0, issues }
      })
    },
    saveStructure({ draftId, expectedRevision, document }, signal) {
      return serialize(signal, async (library, active) => {
        const draft = currentDraft(library, draftId, expectedRevision)
        const checked = checkedDocument(document, { assignIds: true })
        if (checked.issues.length) throw invalid(checked.issues)
        const next = { ...draft, revision: draft.revision + 1, document: checked.document }
        const result = draftView(ctx, next, await readPublicationStatus(draft, active))
        active.throwIfAborted()
        await library.set(next)
        changed()
        return result
      })
    },
    publishStructure({ sessionId, draftId, expectedRevision }, signal) {
      return serialize(signal, async (library, active) => {
        const draft = currentDraft(library, draftId, expectedRevision)
        if (draft.document.execution.mode === 'graph' && !canRunGraph(sessionId)) throw unsupportedDriver()
        if (!changedSincePublication(draft) && registrations.has(draft.published.presetId)) {
          const { broken } = await waitForNative(registry.resolve(draft.published.presetId), active)
          active.throwIfAborted()
          if (!broken) return { draft: draftView(ctx, draft, READY), presetId: draft.published.presetId, version: draft.published.version, ...READY }
        }
        const published = { presetId: presetIdFor(draft.id), version: (draft.published?.version ?? 0) + 1, document: draft.document }
        const { presetId, version } = published
        const next = { ...draft, revision: draft.revision + 1, published }
        const result = { draft: draftView(ctx, next, READY), presetId, version, ...READY }
        let audited = false
        active.throwIfAborted()
        try {
          await unregister(presetId)
          active.throwIfAborted()
          await register(draft, published)
          const { broken } = await waitForNative(registry.resolve(presetId), active)
          if (broken) throw activationFailed(broken, published.document.rows)
          audited = true
          active.throwIfAborted()
          await library.set(next)
        } catch (error) {
          try {
            await unregister(presetId)
            if (draft.published) await register(draft, draft.published)
          } catch {
            throw new LoopError('unavailable', 'The previous publication could not be restored. Reopen the host to reload the saved publication.', 503)
          }
          active.throwIfAborted()
          if (error instanceof LoopError) throw error
          if (audited) throw new LoopError('unavailable', 'The publication could not be saved to the Loop Studio library.', 503)
          throw activationFailed()
        }
        changed()
        return result
      })
    },
    selectStructure({ sessionId, draftId, expectedRevision }, signal) {
      return serialize(signal, async (library, active) => {
        const draft = currentDraft(library, draftId, expectedRevision)
        const presetId = draft.published?.presetId
        if (draft.published?.document.execution.mode === 'graph' && !canRunGraph(sessionId)) throw unsupportedDriver()
        if (!presetId || !registrations.has(presetId)) throw new LoopError('not-found', 'Publish this draft before selecting it.', 404)
        if (!selectionFor(sessionId).canSelectCurrent) throw new LoopError('preset-locked', NO_SELECTION, 409)
        try {
          const result = await ctx.typertGateway.invoke({ namespace: 'agentPresets', method: 'select',
            args: { agentId: sessionId, agentPreset: presetId }, peer: ctx.connection.browserPeer, signal: active })
          if (result !== presetId) throw unavailable()
        } catch (error) {
          if (error?.code === 'agent-preset/locked') throw new LoopError('preset-locked', NO_SELECTION, 409)
          if (error?.code === 'agent-preset/invalid') throw activationFailed()
          throw error
        }
        changed(sessionId)
        return { presetId, selected: true }
      })
    },
    close() {
      lifetime.abort()
      closeTask ??= pending.then(async () => {
        const results = await Promise.allSettled([...registrations.keys()].map(unregister))
        if (results.some(result => result.status === 'rejected')) throw new Error('Loop Studio preset cleanup failed.')
      })
      return closeTask
    },
  }
}
