import React, { useId } from 'react'
import { childRows, disabledMode, hasAncestor, isGroup } from './preset-tree.js'

const managedKeys = new Set(['id', 'name', 'group', 'config', 'disabled'])
const modeLabel = { enabled: '已启用', disabled: '已停用', conditional: '条件启用', custom: '自定义状态' }

export function rowLabel(row, catalog) {
  return isGroup(row) ? row.id : catalog.get(row.name)?.label || row.name
}

export function editableFields(row) {
  const options = Object.fromEntries(Object.entries(row).filter(([key]) => !managedKeys.has(key)))
  return {
    name: row.name,
    id: row.id,
    mode: disabledMode(row),
    condition: row.disabled?.__jsExpr ?? '',
    config: isGroup(row) || !Object.hasOwn(row, 'config') ? '' : JSON.stringify(row.config, null, 2),
    options: Object.keys(options).length ? JSON.stringify(options, null, 2) : '',
  }
}

export function parseRowFields(row, fields, byId) {
  const name = isGroup(row) || fields.name === row.name ? row.name : fields.name.trim()
  const id = fields.id === row.id ? row.id : fields.id.trim()
  if (!name) return { field: 'name', message: '请输入插件模块名。' }
  if (!id) return { field: 'id', message: '请输入行 ID。' }
  if (id !== row.id && byId.has(id)) return { field: 'id', message: '行 ID 已存在。' }
  let options
  try { options = fields.options.trim() ? JSON.parse(fields.options) : {} }
  catch { return { field: 'options', message: '高级选项需要有效的 JSON。' } }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { field: 'options', message: '高级选项需要一个 JSON 对象。' }
  }
  if (Object.keys(options).some(key => managedKeys.has(key))) {
    return { field: 'options', message: '请在对应字段编辑名称、行 ID、配置或启用状态。' }
  }
  const next = { ...options, id, name }
  if (Object.hasOwn(row, 'group')) next.group = row.group
  if (isGroup(row)) next.config = row.config
  else if (fields.config.trim()) {
    try { next.config = JSON.parse(fields.config) }
    catch { return { field: 'config', message: '插件配置需要有效的 JSON。' } }
  }

  if (fields.mode === 'conditional') {
    if (!fields.condition.trim()) return { field: 'condition', message: '请输入停用条件。' }
    next.disabled = { ...row.disabled, __jsExpr: fields.condition }
  } else if (fields.mode === disabledMode(row)) {
    if (Object.hasOwn(row, 'disabled')) next.disabled = row.disabled
  } else {
    next.disabled = fields.mode === 'disabled'
  }
  return { row: next }
}

function displayedRows(entries, catalog, filter, collapsed) {
  const query = filter.trim().toLowerCase()
  if (!query) return entries.filter(entry => {
    for (let parent = entry.parent; parent; parent = parent.parent) {
      if (collapsed.has(parent.row.id)) return false
    }
    return true
  })

  const matches = new Set()
  for (const entry of entries) {
    const { row } = entry
    if (![row.id, row.name, rowLabel(row, catalog)].some(value => String(value ?? '').toLowerCase().includes(query))) continue
    for (let current = entry; current; current = current.parent) matches.add(current.row.id)
  }
  return entries.filter(entry => matches.has(entry.row.id))
}

export function PresetTree({ entries, catalog, selectedId, collapsed, filter, issues, readOnly, busy, pending, onFilter, onToggleGroup, onSelect, onToggleRow }) {
  const searchId = useId()
  const visible = displayedRows(entries, catalog, filter, collapsed)
  const searching = Boolean(filter.trim())
  return <div className="preset-tree">
    <label htmlFor={searchId} className="preset-sr-only">搜索组件</label>
    <input id={searchId} className="preset-search" type="search" value={filter} placeholder="搜索名称、模块或行 ID" onChange={event => onFilter(event.target.value)} />
    {visible.length ? <ul className="preset-tree-list" aria-label="组件声明顺序">
      {visible.map(entry => {
        const { row, parent } = entry
        const name = rowLabel(row, catalog)
        const group = isGroup(row)
        const mode = disabledMode(row)
        const expanded = searching ? visible.some(item => item.parent === entry) : !collapsed.has(row.id)
        const rowIssues = issues.filter(issue => issue.rowId === row.id)
        let depth = 0
        let ancestorMode
        for (let current = parent; current; current = current.parent) {
          depth++
          const state = disabledMode(current.row)
          if (state === 'disabled' || (state === 'conditional' && !ancestorMode)) ancestorMode = state
        }
        return <li key={row.id} className="preset-tree-row" data-preset-row={row.id} data-selected={selectedId === row.id} style={{ '--preset-depth': Math.min(depth, 4) }}>
          {group && childRows(row).length > 0 ? <button type="button" className="preset-disclosure" aria-label={`${expanded ? '折叠' : '展开'}分组 ${name}`} aria-expanded={expanded} disabled={searching} onClick={() => onToggleGroup(row.id)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span></button> : <span className="preset-row-spacer" />}
          <button type="button" className="preset-row-select" aria-pressed={selectedId === row.id} disabled={busy} onClick={() => onSelect(row.id)}>
            <span className="preset-row-main"><strong>{name}</strong>{group && <small>分组 · {childRows(row).length} 项</small>}</span>
            {!group && name !== row.name && <span className="preset-module">{row.name}</span>}
            <span className="preset-row-state">
              <span data-state={mode}>{modeLabel[mode]}</span>
              {ancestorMode && <span>{ancestorMode === 'disabled' ? '上级分组停用' : '上级分组含条件'}</span>}
              {rowIssues.length > 0 && <span data-state="error">{rowIssues.length} 项问题</span>}
            </span>
          </button>
          {!readOnly && <input type="checkbox" className="preset-row-toggle" checked={mode !== 'disabled'} disabled={busy || pending || !['enabled', 'disabled'].includes(mode)} aria-label={`启用 ${name}`} title={['enabled', 'disabled'].includes(mode) ? `启用 ${name}` : '在组件详情中修改条件'} onChange={event => onToggleRow(entry, event.target.checked)} />}
        </li>
      })}
    </ul> : <p className="preset-empty">{filter.trim() ? '没有匹配的组件。' : '此预设尚无组件。'}</p>}
  </div>
}

function RowIssues({ issues }) {
  return issues.length > 0 && <ul className="preset-row-issues">
    {issues.map((issue, index) => <li key={`${issue.code}-${index}`} data-severity={issue.severity}>{issue.message}</li>)}
  </ul>
}

export function PresetRowInspector({ entry, catalog, fields, pending, error, issues, readOnly, busy, inspectorRef, onReturn, onFields, onApply, onCancel, onReorder, onMove, onDuplicate, onDelete, canMove }) {
  const headingId = useId()
  const errorId = useId()
  if (!entry) return <section ref={inspectorRef} className="preset-inspector" aria-label="组件详情"><p className="preset-empty">选择一项查看详情。</p></section>
  const { row } = entry
  const group = isGroup(row)
  const inputError = field => ({ 'aria-invalid': error?.field === field || undefined, 'aria-describedby': error?.field === field ? errorId : undefined })
  const rowIssues = issues.filter(issue => issue.rowId === row.id)

  return <section ref={inspectorRef} className="preset-inspector" aria-labelledby={headingId} tabIndex={-1}>
    <button type="button" className="preset-back" onClick={onReturn}>← 返回组件列表</button>
    <div className="preset-inspector-heading">
      <div>
        <span className="preset-caption">{group ? '分组详情' : '插件详情'}</span>
        <h3 id={headingId}>{rowLabel(row, catalog)}</h3>
      </div>
      {pending && <span className="preset-pill" data-state="edited">修改待应用</span>}
    </div>
    <RowIssues issues={rowIssues} />
    {readOnly ? <div className="preset-read-fields">
      <dl>
        <dt>插件模块</dt><dd>{row.name}</dd>
        <dt>行 ID</dt><dd>{row.id}</dd>
        <dt>启用状态</dt><dd>{modeLabel[disabledMode(row)]}</dd>
      </dl>
      {fields.condition && <details open><summary>停用条件</summary><pre tabIndex={0}>{fields.condition}</pre></details>}
      {fields.config && <details><summary>插件配置</summary><pre tabIndex={0}>{fields.config}</pre></details>}
      {fields.options && <details><summary>高级选项</summary><pre tabIndex={0}>{fields.options}</pre></details>}
    </div> : <>
      <div className="preset-row-actions" role="group" aria-label="选中组件的操作">
        <button type="button" className="preset-button" disabled={busy || pending || entry.index === 0} onClick={() => onReorder(-1)}>上移</button>
        <button type="button" className="preset-button" disabled={busy || pending || entry.index + 1 === entry.siblings} onClick={() => onReorder(1)}>下移</button>
        <button type="button" className="preset-button" disabled={busy || pending || !canMove} onClick={onMove}>移动到…</button>
        <button type="button" className="preset-button" disabled={busy || pending} onClick={onDuplicate}>复制</button>
        <button type="button" className="preset-button preset-danger" disabled={busy || pending} onClick={onDelete}>删除</button>
      </div>
      <form className="preset-fields" onSubmit={event => { event.preventDefault(); onApply() }}>
        {group ? <label>分组名称<input disabled={busy} value={fields.id} onChange={event => onFields({ ...fields, id: event.target.value })} {...inputError('id')} /></label>
          : <label>插件模块<input disabled={busy} value={fields.name} onChange={event => onFields({ ...fields, name: event.target.value })} {...inputError('name')} /></label>}
        <label>启用状态<select disabled={busy} value={fields.mode} onChange={event => onFields({ ...fields, mode: event.target.value })}>
          <option value="enabled">启用</option>
          <option value="disabled">停用</option>
          <option value="conditional">条件启用</option>
          {disabledMode(row) === 'custom' && <option value="custom">保留自定义状态</option>}
        </select></label>
        {fields.mode === 'conditional' && <label>停用条件 <small>表达式为真时停用此项</small>
          <textarea className="preset-code" rows={3} spellCheck={false} disabled={busy} value={fields.condition} onChange={event => onFields({ ...fields, condition: event.target.value })} {...inputError('condition')} />
        </label>}
        {!group && <label>插件配置 <small>JSON，可留空</small><textarea className="preset-code" rows={5} spellCheck={false} disabled={busy} value={fields.config} onChange={event => onFields({ ...fields, config: event.target.value })} {...inputError('config')} /></label>}
        <details key={row.id} className="preset-advanced" open={['id', 'options'].includes(error?.field) || undefined}>
          <summary>高级设置</summary>
          {group ? <p className="preset-caption">插件模块 {row.name}</p> : <label>行 ID<input className="preset-code" spellCheck={false} disabled={busy} value={fields.id} onChange={event => onFields({ ...fields, id: event.target.value })} {...inputError('id')} /></label>}
          <label>高级选项 <small>例如 inject、isolate、intercept</small>
            <textarea className="preset-code" rows={4} spellCheck={false} disabled={busy} value={fields.options} onChange={event => onFields({ ...fields, options: event.target.value })} {...inputError('options')} />
          </label>
        </details>
        {error && <p id={errorId} className="preset-inline-error" role="alert">{error.message}</p>}
        {pending && <div className="preset-form-actions">
          <button type="button" className="preset-button" disabled={busy} onClick={onCancel}>取消本项修改</button>
          <button type="submit" className="preset-button preset-primary" disabled={busy}>应用组件修改</button>
        </div>}
      </form>
    </>}
  </section>
}

export function moveDestinations(entries, entry) {
  const parentId = entry.parent?.row.id ?? null
  const groups = entries.filter(candidate => isGroup(candidate.row) && candidate.row.id !== parentId
    && candidate.row.id !== entry.row.id && !hasAncestor(candidate, entry.row.id))
  return { groups, root: parentId !== null }
}
