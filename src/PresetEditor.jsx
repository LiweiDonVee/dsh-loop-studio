import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PresetDialog, changeSummary, describeChanges } from './PresetDialogs.jsx'
import { PresetPlanEditor } from './PresetPlanEditor.jsx'
import { PresetRowInspector, PresetTree, editableFields, moveDestinations, parseRowFields, rowLabel } from './PresetRows.jsx'
import { ViewTabs } from './ViewTabs.jsx'
import { createNativeExecutionPlan } from './plan.mjs'
import { childRows, duplicateRow, equalJson, indexRows, insertRow, isGroup, removeRow, reorderRow, replaceRow, uniqueRowId } from './preset-tree.js'

const panels = [{ id: 'components', label: '组件' }, { id: 'plan', label: '执行编排' }]
const emptyHistory = { present: null, past: [], future: [] }
const initialPanel = { id: 'components', reveal: false }
const nativeExecution = createNativeExecutionPlan()

function documentOf(data) {
  return { name: data.name, description: data.description ?? '', rows: data.rows, execution: data.execution?.mode === 'graph' ? data.execution : nativeExecution }
}

function chooseInitial(list, currentPresetId) {
  const draft = list.drafts.find(item => item.publishedPresetId && item.publishedPresetId === currentPresetId)
  if (draft) return `draft:${draft.id}`
  const source = list.sources.find(item => item.id === currentPresetId) ?? list.sources[0]
  if (source) return `source:${source.id}`
  return list.drafts[0] ? `draft:${list.drafts[0].id}` : ''
}

function errorMessage(error) {
  if (error.code === 'revision-conflict') return '此草稿已在其他窗口更新。当前修改已保留，可重新载入最新草稿。'
  if (error.code === 'preset-locked') return '当前会话已开始，请在新会话中选择此预设。'
  return error.message || '无法完成预设操作，请重试。'
}

function updateDraftList(directory, record) {
  if (!directory || !record.draftId) return directory
  const previous = directory.drafts.find(draft => draft.id === record.draftId)
  const draft = {
    ...previous,
    id: record.draftId,
    name: record.name,
    revision: record.revision,
    publishedPresetId: record.published?.presetId,
    publishedVersion: record.published?.version,
    publishedActivation: record.published?.activation,
    publishedReason: record.published?.reason,
    hasUnpublishedChanges: record.hasUnpublishedChanges,
  }
  return {
    ...directory,
    drafts: previous ? directory.drafts.map(item => item.id === draft.id ? draft : item) : [...directory.drafts, draft],
  }
}

function findPlanIssue(issue) {
  return issue.nodeId !== undefined || issue.edgeId !== undefined || issue.field === 'execution'
    || issue.field?.startsWith('execution.') || issue.field?.startsWith('execution[')
}

function Feedback({ feedback, onReload, disabled }) {
  if (!feedback) return null
  return <div className="preset-feedback" data-kind={feedback.kind} role={feedback.kind === 'error' ? 'alert' : 'status'}>
    <p>{feedback.message}</p>
    {feedback.code === 'revision-conflict' && <button type="button" className="preset-button" disabled={disabled} onClick={onReload}>重新载入草稿</button>}
  </div>
}

function IssueSummary({ issues, entries, catalog, onOpenIssue }) {
  if (!issues.length) return null
  return <div className="preset-validation">
    <h3>预设校验</h3>
    <ul className="preset-row-issues">
      {issues.map((issue, index) => {
        const entry = entries.get(issue.rowId)
        const location = entry ? rowLabel(entry.row, catalog) : findPlanIssue(issue) ? '执行编排' : ''
        return <li key={`${issue.code}-${index}`} data-severity={issue.severity}>
          {location && <button type="button" className="preset-text-button" onClick={() => onOpenIssue(issue)}>{location}</button>} {issue.message}
        </li>
      })}
    </ul>
  </div>
}

export function PresetEditor({ sessionId, active, client, currentPresetId, currentPresetName, models, requestedDraft, onSelected }) {
  const panelId = useId()
  const editorRef = useRef(null)
  const scrollRef = useRef(null)
  const revealedPanel = useRef(null)
  const inspectorRef = useRef(null)
  const controllerRef = useRef(null)
  const workingRef = useRef(null)
  const currentChoice = useRef('')
  const preferredSource = useRef(currentPresetId)
  const handledRequest = useRef(null)
  preferredSource.current = currentPresetId

  const [directory, setDirectory] = useState(null)
  const [choice, setChoice] = useState('')
  const [record, setRecord] = useState(null)
  const [saved, setSaved] = useState(null)
  const [history, setHistory] = useState(emptyHistory)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [issues, setIssues] = useState([])
  const [dialog, setDialog] = useState(null)
  const [view, setView] = useState(initialPanel)
  const [selectedId, setSelectedId] = useState(null)
  const [collapsed, setCollapsed] = useState(new Set())
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState(null)
  const [rowError, setRowError] = useState(null)
  const [sessionLocked, setSessionLocked] = useState(false)
  const [usedHere, setUsedHere] = useState(null)

  const panel = view.id
  const document = history.present
  const readOnly = record?.readOnly !== false
  const entries = useMemo(() => indexRows(document?.rows ?? []), [document?.rows])
  const byId = useMemo(() => new Map(entries.map(entry => [entry.row.id, entry])), [entries])
  const catalog = useMemo(() => new Map((record?.catalog ?? []).map(item => [item.moduleName, item])), [record?.catalog])
  const selected = byId.get(selectedId) ?? entries[0]
  const groups = entries.filter(entry => isGroup(entry.row))
  const rowFields = selected ? pending ?? editableFields(selected.row) : null
  const destinations = selected ? moveDestinations(entries, selected) : { groups: [], root: false }
  const dirty = Boolean(document && !equalJson(saved, document))
  const baseDocument = record && documentOf(record.baseDocument ?? record)
  const unpublished = Boolean(record && (!record.published || !equalJson(document, baseDocument)))
  const publicationReady = record?.published?.activation === 'ready'
  const conflict = feedback?.code === 'revision-conflict'
  const canSave = !readOnly && dirty && !pending && !busy && !conflict
  const graphBlocked = document?.execution.mode === 'graph' && directory?.capabilities?.canExecuteGraph === false
  const canPublish = !readOnly && (unpublished || !publicationReady) && !graphBlocked && !pending && !busy && !conflict
  const source = record?.source && directory?.sources.find(item => item.id === record.source.presetId)
  const canCopy = (record?.editableCopy ?? source?.editableCopy) === true
  const sourceReason = record?.reason ?? source?.reason
  const canSelect = publicationReady && Boolean(directory?.capabilities?.canSelectCurrent && !sessionLocked)
  const localSummary = dirty ? changeSummary(describeChanges(saved, document)) : []
  const activatePanel = useCallback(id => setView({ id, reveal: true }), [])

  useLayoutEffect(() => {
    if (!active || !view.reveal || revealedPanel.current === view) return
    revealedPanel.current = view
    const width = editorRef.current?.clientWidth
    const scroller = scrollRef.current
    const tabs = scroller?.querySelector('.preset-tabs')
    if (!tabs || !width || width >= 680) return
    const offset = tabs.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += offset - 8
  }, [active, view])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    return () => {
      controller.abort()
      if (controllerRef.current === controller) {
        controllerRef.current = null
        workingRef.current = null
      }
    }
  }, [client, sessionId])

  const run = useCallback(async (kind, work, keepFeedback = false) => {
    const signal = controllerRef.current?.signal
    if (!signal || signal.aborted || workingRef.current) return undefined
    const token = {}
    workingRef.current = token
    setBusy(kind)
    if (!keepFeedback) setFeedback(null)
    try { return await work(signal) }
    catch (error) {
      if (!signal.aborted) {
        if (Array.isArray(error.issues)) setIssues(error.issues)
        if (error.code === 'preset-locked') setSessionLocked(true)
        setFeedback({ kind: 'error', code: error.code, message: errorMessage(error) })
      }
      return undefined
    } finally {
      if (!signal.aborted && workingRef.current === token) {
        workingRef.current = null
        setBusy('')
      }
    }
  }, [])

  const installRecord = useCallback((next, replaceHistory) => {
    const current = documentOf(next)
    const key = next.draftId ? `draft:${next.draftId}` : `source:${next.source.presetId}`
    currentChoice.current = key
    setChoice(key)
    setRecord(next)
    setSaved(current)
    setHistory(previous => replaceHistory ? { ...emptyHistory, present: current } : { ...previous, present: current })
    setDirectory(previous => updateDraftList(previous, next))
    if (replaceHistory) {
      setView(initialPanel)
      setSelectedId(null)
      setCollapsed(new Set())
      setFilter('')
      setPending(null)
      setRowError(null)
      setIssues([])
    }
  }, [])

  const readChoice = useCallback(async (key, signal, openPlan = false) => {
    const input = key.startsWith('source:') ? { sourcePresetId: key.slice(7) } : { draftId: key.slice(6) }
    const next = await client.readStructure(sessionId, input, signal)
    if (signal.aborted) return
    installRecord(next, true)
    if (openPlan) activatePanel('plan')
  }, [client, sessionId, installRecord, activatePanel])

  const refresh = useCallback((readCurrent = false, keepFeedback = false) => run('load', async signal => {
    const next = await client.listStructures(sessionId, signal)
    if (signal.aborted) return
    setDirectory(next)
    setSessionLocked(!next.capabilities?.canSelectCurrent)
    const current = currentChoice.current
    const key = current || chooseInitial(next, preferredSource.current)
    if (key && (!current || readCurrent)) await readChoice(key, signal)
  }, keepFeedback), [client, sessionId, readChoice, run])

  useEffect(() => {
    if (active) void refresh(false, Boolean(currentChoice.current))
  }, [active, refresh])

  const requestChoice = useCallback((key, openPlan = false) => {
    if (key === currentChoice.current) {
      if (openPlan) activatePanel('plan')
      return
    }
    const proceed = () => { void run('load', signal => readChoice(key, signal, openPlan)) }
    if (dirty || pending) setDialog({
      kind: 'discard', title: '切换预设？', actionLabel: '丢弃修改并切换',
      message: '当前副本有未保存修改。切换后将载入所选预设。', proceed,
    })
    else proceed()
  }, [dirty, pending, readChoice, run, activatePanel])

  useEffect(() => {
    if (!active || busy || !directory || !requestedDraft || handledRequest.current === requestedDraft) return
    handledRequest.current = requestedDraft
    const draft = directory.drafts.find(item => item.id === requestedDraft.draftId || item.publishedPresetId === requestedDraft.presetId)
    if (draft) requestChoice(`draft:${draft.id}`, true)
    else setFeedback({ kind: 'error', message: '无法找到当前预设的可编辑副本。' })
  }, [active, busy, directory, requestedDraft, requestChoice])

  function editDocument(next) {
    if (equalJson(document, next)) return
    setHistory(current => ({ present: next, past: [...current.past.slice(-79), current.present], future: [] }))
    setIssues([])
    setFeedback(current => current?.code === 'revision-conflict' ? current : null)
  }

  function stepHistory(direction) {
    setHistory(current => {
      if (direction < 0) {
        const present = current.past.at(-1)
        return { past: current.past.slice(0, -1), present, future: [current.present, ...current.future] }
      }
      const [present, ...future] = current.future
      return { past: [...current.past, current.present], present, future }
    })
    setIssues([])
    setFeedback(current => current?.code === 'revision-conflict' ? current : null)
  }

  function editRows(rows) {
    editDocument({ ...document, rows })
  }

  function focusInspector() {
    const width = editorRef.current?.clientWidth
    if (width > 0 && width < 680) {
      inspectorRef.current?.focus({ preventScroll: true })
      inspectorRef.current?.scrollIntoView?.({ block: 'start' })
    }
  }

  function pickRow(id) {
    const proceed = () => {
      setSelectedId(id)
      setPending(null)
      setRowError(null)
      focusInspector()
    }
    if (pending && id !== selected?.row.id) setDialog({
      kind: 'discard', title: '切换组件？', actionLabel: '丢弃本项修改',
      message: '此组件有待应用的修改。切换后会显示所选组件。', proceed,
    })
    else if (!pending) proceed()
    else focusInspector()
  }

  function revealRow(id) {
    setFilter('')
    setCollapsed(previous => {
      const next = new Set(previous)
      for (let current = byId.get(id); current; current = current.parent) next.delete(current.row.id)
      return next
    })
  }

  function returnToRows() {
    const row = [...editorRef.current.querySelectorAll('[data-preset-row]')].find(node => node.dataset.presetRow === selected?.row.id)
    const target = row?.querySelector('.preset-row-select') ?? editorRef.current.querySelector('.preset-search')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: 'nearest' })
  }

  function applyRow() {
    if (!pending || !selected) return
    const result = parseRowFields(selected.row, pending, byId)
    if (!result.row) { setRowError(result); return }
    editRows(replaceRow(document.rows, selected, result.row))
    if (result.row.id !== selected.row.id) {
      setSelectedId(result.row.id)
      setFilter('')
    }
    setPending(null)
    setRowError(null)
  }

  function toggleRow(entry, enabled) {
    const row = { ...entry.row, disabled: !enabled }
    editRows(replaceRow(document.rows, entry, row))
  }

  function openAdd(kind) {
    const target = byId.get(selectedId)
    const parentId = target && isGroup(target.row) ? target.row.id : target?.parent?.row.id ?? ''
    setDialog({ kind, groups, fields: { name: '', parentId } })
  }

  function addRow() {
    const { kind, fields } = dialog
    const group = kind === 'group'
    const name = fields.name.trim()
    const taken = new Set(byId.keys())
    if (group && taken.has(name)) {
      setDialog({ ...dialog, error: '分组名称与现有行 ID 重复。' })
      return
    }
    const slug = name.replace(/^@[^/]+\//u, '').replace(/^dsh-/u, '').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
    const row = group ? { id: name, name: 'cordis:group', group: true, config: [] } : { id: uniqueRowId(taken, slug || 'plugin'), name }
    editRows(insertRow(document.rows, fields.parentId || null, row))
    revealRow(fields.parentId)
    setSelectedId(row.id)
    setDialog(null)
  }

  function duplicateSelected() {
    const row = duplicateRow(selected.row, new Set(byId.keys()))
    editRows(insertRow(document.rows, selected.parent?.row.id ?? null, row, selected.index + 1))
    revealRow(selected.parent?.row.id)
    setSelectedId(row.id)
  }

  function deleteSelected() {
    editRows(removeRow(document.rows, selected))
    const index = entries.indexOf(selected)
    setSelectedId(selected.parent?.row.id ?? entries[index - 1]?.row.id ?? null)
    setDialog(null)
  }

  function openDelete() {
    const count = indexRows(childRows(selected.row)).length
    if (!count) deleteSelected()
    else setDialog({ kind: 'delete', name: rowLabel(selected.row, catalog), count })
  }

  function openMove() {
    setDialog({
      kind: 'move', name: rowLabel(selected.row, catalog), ...destinations,
      fields: { parentId: destinations.root ? '' : destinations.groups[0].row.id },
    })
  }

  function moveSelected() {
    const target = dialog.fields.parentId || null
    editRows(insertRow(removeRow(document.rows, selected), target, selected.row))
    revealRow(target)
    setDialog(null)
  }

  function reload() {
    const proceed = () => { void refresh(true) }
    if (dirty || pending) setDialog({
      kind: 'discard', title: '重新载入草稿？', actionLabel: '丢弃修改并载入',
      message: '重新载入后会显示宿主保存的最新草稿。当前未保存修改将被丢弃。', proceed,
    })
    else proceed()
  }

  async function createDraft() {
    await run('create', async signal => {
      const next = await client.createStructure(sessionId, {
        sourcePresetId: record.source.presetId, name: dialog.fields.name.trim(), description: dialog.fields.description,
      }, signal)
      if (signal.aborted) return
      installRecord(next, true)
      setDialog(null)
      setFeedback({ kind: 'status', message: '可编辑副本已创建。' })
    })
  }

  const saveInput = () => ({ draftId: record.draftId, expectedRevision: record.revision, document })

  async function saveDraft() {
    if (!canSave) return
    await run('save', async signal => {
      const next = await client.saveStructure(sessionId, saveInput(), signal)
      if (signal.aborted) return
      installRecord(next, false)
      setIssues([])
      setFeedback({ kind: 'status', message: '草稿已保存。' })
    })
  }

  async function preparePublication() {
    if (!canPublish) return
    await run('validate', async signal => {
      const result = await client.validateStructure(sessionId, saveInput(), signal)
      if (signal.aborted) return
      const findings = result.issues ?? []
      setIssues(findings)
      if (!result.valid) {
        setFeedback({ kind: 'error', message: '请处理校验问题后再发布。' })
        const issue = findings.find(item => item.severity === 'error')
        if (issue) openIssue(issue)
        return
      }
      setDialog({
        kind: 'publish', published: record.published, changes: describeChanges(baseDocument, document),
        warnings: findings.filter(issue => issue.severity !== 'error'),
      })
    })
  }

  async function publishDraft() {
    const completed = await run('publish', async signal => {
      let revision = record.revision
      if (dirty) {
        const next = await client.saveStructure(sessionId, saveInput(), signal)
        if (signal.aborted) return false
        installRecord(next, false)
        revision = next.revision
      }
      const result = await client.publishStructure(sessionId, { draftId: record.draftId, expectedRevision: revision }, signal)
      if (signal.aborted) return false
      if (result.activation !== 'ready' || result.draft.published?.activation !== 'ready') throw new Error('草稿已保存。发布尚未完成，请重试。')
      installRecord(result.draft, false)
      setIssues([])
      setDialog(null)
      setFeedback({ kind: 'status', message: `「${result.draft.name}」已发布。` })
      return true
    })
    if (completed) void refresh(false, true)
  }

  async function usePublication() {
    if (!canSelect || !record.published) return
    await run('select', async signal => {
      const result = await client.selectStructure(sessionId, { draftId: record.draftId, expectedRevision: record.revision }, signal)
      if (signal.aborted) return
      if (result.selected !== true || result.presetId !== record.published.presetId) throw new Error('宿主尚未应用此预设。')
      setUsedHere({ id: result.presetId, name: record.name })
      setFeedback({ kind: 'status', message: `当前空白会话已使用「${record.name}」。` })
      onSelected?.()
    })
  }

  function openIssue(issue) {
    if (findPlanIssue(issue)) activatePanel('plan')
    else if (issue.rowId && byId.has(issue.rowId)) {
      activatePanel('components')
      revealRow(issue.rowId)
      setSelectedId(issue.rowId)
    }
  }

  function submitDialog() {
    if (!dialog || busy) return
    if (dialog.kind === 'create') { void createDraft(); return }
    if (dialog.kind === 'publish') { void publishDraft(); return }
    if (dialog.kind === 'plugin' || dialog.kind === 'group') { addRow(); return }
    if (dialog.kind === 'move') { moveSelected(); return }
    if (dialog.kind === 'delete') { deleteSelected(); return }
    if (dialog.kind === 'metadata') {
      editDocument({ ...document, name: dialog.fields.name.trim(), description: dialog.fields.description })
    }
    setDialog(null)
    if (dialog.kind === 'discard') dialog.proceed()
  }

  const toolbarBusy = Boolean(busy || pending)
  const historyActions = <>
    <button type="button" className="preset-button" disabled={toolbarBusy || !history.past.length} onClick={() => stepHistory(-1)}>撤销</button>
    <button type="button" className="preset-button" disabled={toolbarBusy || !history.future.length} onClick={() => stepHistory(1)}>重做</button>
  </>
  const currentName = usedHere && (!currentPresetId || usedHere.id === currentPresetId) ? usedHere.name : currentPresetName
  return <div ref={editorRef} className="loop-preset-editor" aria-busy={Boolean(busy)}>
    {!dialog && <Feedback feedback={feedback} onReload={reload} disabled={Boolean(busy)} />}
    <div ref={scrollRef} className="preset-scroll">
      <div className="preset-context">
        <div className="preset-current"><span className="preset-caption">当前会话</span><strong>{currentName}</strong></div>
        <div className="preset-picker">
          <label>预设来源与副本<select value={choice} disabled={!directory || Boolean(busy)} onChange={event => requestChoice(event.target.value)}>
            {!choice && <option value="">选择预设</option>}
            {directory?.sources.length > 0 && <optgroup label="原始预设">{directory.sources.map(item => <option key={item.id} value={`source:${item.id}`}>{item.name || item.id}</option>)}</optgroup>}
            {directory?.drafts.length > 0 && <optgroup label="可编辑副本">{directory.drafts.map(item => <option key={item.id} value={`draft:${item.id}`}>{item.name}{item.publishedPresetId ? ' · 已发布' : ''}</option>)}</optgroup>}
          </select></label>
          <button type="button" className="preset-button" disabled={Boolean(busy)} onClick={reload}>重新读取</button>
        </div>
      </div>
      {!record && <p className="preset-empty" role={busy ? 'status' : undefined}>{busy ? '正在读取预设结构…' : '暂无可查看的预设。'}</p>}
      {record && <>
        <header className="preset-document">
          <div>
            <div className="preset-document-title">
              <h2>{document.name}</h2>
              <span className="preset-pill" data-state={record.published ? 'enabled' : undefined}>{readOnly ? '原始预设' : record.published ? '已发布' : '可编辑副本'}</span>
            </div>
            {!readOnly && <p className="preset-caption">来源 {record.source.name}</p>}
            {document.description && <p className="preset-description">{document.description}</p>}
          </div>
          {readOnly ? <button type="button" className="preset-button preset-primary" disabled={Boolean(busy) || !canCopy} onClick={() => setDialog({
            kind: 'create', sourceName: document.name, fields: { name: `${document.name} 副本`, description: document.description },
          })}>创建可编辑副本</button> : <button type="button" className="preset-button" disabled={toolbarBusy} onClick={() => setDialog({
            kind: 'metadata', fields: { name: document.name, description: document.description },
          })}>编辑名称与说明</button>}
        </header>
        {readOnly && sourceReason && <p className="preset-caption preset-source-reason">{sourceReason}</p>}
        {record.published && <div className="preset-published" data-unavailable={!publicationReady}>
          <div>
            <strong>{publicationReady ? '已加入 DSH 预设列表' : '已发布预设暂不可用'}</strong>
            <p className="preset-caption">已发布第 {record.published.version} 版{unpublished && ' · 有未发布修改'}</p>
            {!publicationReady && <p className="preset-caption">{record.published.reason || '可再次发布以恢复宿主注册。'}</p>}
            {publicationReady && !canSelect && <p className="preset-caption">请在新会话中选择此预设。</p>}
          </div>
          {canSelect &&
            <button type="button" className="preset-button" disabled={Boolean(busy) || conflict} onClick={() => { void usePublication() }}>在当前空白会话中使用</button>}
        </div>}
        <IssueSummary issues={issues} entries={byId} catalog={catalog} onOpenIssue={openIssue} />
        <ViewTabs id={panelId} label="预设编辑内容" className="preset-tabs" options={panels} active={panel} onChange={activatePanel} />
        <section role="tabpanel" id={`${panelId}-components-panel`} aria-labelledby={`${panelId}-components`} hidden={panel !== 'components'}>
          <div className="preset-components-heading">
            <div><h3>组件声明顺序</h3><p className="preset-caption">{entries.length} 项组件</p></div>
            {!readOnly && <div className="preset-toolbar" role="group" aria-label="组件编辑">
              <button type="button" className="preset-button" disabled={toolbarBusy} onClick={() => openAdd('plugin')}>添加插件</button>
              <button type="button" className="preset-button" disabled={toolbarBusy} onClick={() => openAdd('group')}>添加分组</button>
              {historyActions}
            </div>}
          </div>
          <div className="preset-layout">
            <PresetTree entries={entries} catalog={catalog} selectedId={selected?.row.id} collapsed={collapsed} filter={filter} issues={issues}
              readOnly={readOnly} busy={Boolean(busy)} pending={Boolean(pending)} onFilter={setFilter}
              onToggleGroup={id => setCollapsed(previous => {
                const next = new Set(previous)
                if (!next.delete(id)) next.add(id)
                return next
              })} onSelect={pickRow} onToggleRow={toggleRow} />
            <PresetRowInspector entry={selected} catalog={catalog} fields={rowFields} pending={Boolean(pending)} error={rowError}
              issues={issues} readOnly={readOnly} busy={Boolean(busy)} inspectorRef={inspectorRef} onReturn={returnToRows}
              onFields={fields => { setPending(equalJson(fields, editableFields(selected.row)) ? null : fields); setRowError(null) }}
              onApply={applyRow} onCancel={() => { setPending(null); setRowError(null) }}
              onReorder={direction => editRows(reorderRow(document.rows, selected, direction))} onMove={openMove} onDuplicate={duplicateSelected} onDelete={openDelete}
              canMove={destinations.root || destinations.groups.length > 0} />
          </div>
        </section>
        <section role="tabpanel" id={`${panelId}-plan-panel`} aria-labelledby={`${panelId}-plan`} hidden={panel !== 'plan'}>
          {!readOnly && <div className="preset-toolbar preset-plan-history" role="group" aria-label="编排编辑历史">{historyActions}</div>}
          <PresetPlanEditor plan={document.execution} onChange={execution => editDocument({ ...document, execution })}
            models={models} readOnly={readOnly || Boolean(busy)} issues={issues.filter(findPlanIssue)} />
        </section>
      </>}
    </div>
    {record && !readOnly && <footer className="preset-save-bar">
      <div className="preset-save-state">
        <strong>{pending ? '组件修改待应用' : dirty ? '有未保存修改' : publicationReady && !unpublished ? '已发布' : '草稿已保存'}</strong>
        {pending && panel === 'plan' && <button type="button" className="preset-text-button" onClick={() => activatePanel('components')}>返回组件</button>}
        {localSummary.length > 0 && <small>{localSummary.join(' · ')}</small>}
        {graphBlocked && <small>当前宿主暂不可发布连线编排。</small>}
        {busy === 'validate' && <small role="status">正在校验预设…</small>}
      </div>
      <div className="preset-save-actions">
        <button type="button" className="preset-button" disabled={!canSave} onClick={() => { void saveDraft() }}>{busy === 'save' ? '正在保存…' : '保存草稿'}</button>
        <button type="button" className="preset-button preset-primary" disabled={!canPublish} onClick={() => { void preparePublication() }}>发布预设</button>
      </div>
    </footer>}
    {active && dialog && <PresetDialog key={dialog.kind} dialog={dialog} document={document} catalog={catalog} busy={Boolean(busy)} feedback={feedback} saved={!dirty}
      onClose={() => setDialog(null)} onSubmit={submitDialog} onField={(key, value) => setDialog(current => ({ ...current, error: '', fields: { ...current.fields, [key]: value } }))} />}
  </div>
}
