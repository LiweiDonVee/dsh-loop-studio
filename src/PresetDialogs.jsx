import React, { useEffect, useId, useRef } from 'react'
import { compareDocuments, equalJson, isGroup } from './preset-tree.js'
import { rowLabel } from './PresetRows.jsx'

const dialogLabels = {
  create: ['创建可编辑副本', '创建副本'],
  metadata: ['编辑名称与说明', '应用名称与说明'],
  plugin: ['添加插件', '添加插件'],
  group: ['添加分组', '添加分组'],
  move: ['移动组件', '移动'],
  delete: ['删除分组', '删除分组'],
  publish: ['发布预设', '确认发布'],
}

export function describeChanges(base, document) {
  const changes = compareDocuments(base, document)
  return { ...changes, execution: !equalJson(base.execution, document.execution) }
}

export function changeSummary(changes) {
  return [
    changes.added.length > 0 && `新增 ${changes.added.length} 项`,
    changes.removed.length > 0 && `删除 ${changes.removed.length} 项`,
    changes.changed.length > 0 && `修改 ${changes.changed.length} 项`,
    changes.moved.length > 0 && `移动 ${changes.moved.length} 项`,
    changes.reordered.length > 0 && `调整 ${changes.reordered.length} 处顺序`,
    changes.metadata && '名称或说明',
    changes.execution && '执行编排',
  ].filter(Boolean)
}

function ExecutionSummary({ execution }) {
  if (execution?.mode !== 'graph') return <p>执行编排使用 DSH 标准流程。</p>
  const nodes = execution.nodes ?? []
  const entry = nodes.find(node => node.id === execution.entryNodeId)
  return <p>自定义执行编排 · {nodes.length} 个节点 · {execution.edges?.length ?? 0} 条连线{entry && ` · 入口 ${entry.label || entry.id}`}</p>
}

function PublicationReview({ dialog, document, catalog }) {
  const { published, changes, warnings } = dialog
  const rows = [
    ['新增', changes.added],
    ['删除', changes.removed],
    ['修改', changes.changed],
    ['移动到其他分组', changes.moved],
  ]
  const hasChanges = changeSummary(changes).length > 0
  return <div className="preset-review">
    <p>{published ? <>将更新「<strong>{document.name}</strong>」的已发布版本。</> : <>「<strong>{document.name}</strong>」将加入 DSH 的预设列表。</>}</p>
    <p className="preset-caption">新会话可在 DSH 的预设选择器中使用此预设。</p>
    <div className="preset-review-diff">
      <h3>{published ? '与上次发布相比' : '与来源预设相比'}</h3>
      {hasChanges ? <ul>
        {rows.map(([label, items]) => items.length > 0 && <li key={label}><strong>{label} {items.length} 项</strong><span>{items.map(row => rowLabel(row, catalog)).join('、')}</span></li>)}
        {changes.reordered.length > 0 && <li><strong>调整声明顺序</strong><span>{changes.reordered.join('、')}</span></li>}
        {changes.metadata && <li>名称或说明已更新</li>}
        {changes.execution && <li>执行编排已更新</li>}
      </ul> : <p className="preset-caption">{published ? '使用上次发布的内容' : '沿用来源结构'}</p>}
    </div>
    <ExecutionSummary execution={document.execution} />
    {warnings.length > 0 && <ul className="preset-row-issues">{warnings.map((issue, index) => <li key={`${issue.code}-${index}`} data-severity={issue.severity}>{issue.message}</li>)}</ul>}
  </div>
}

function GroupPicker({ groups, root, value, onChange }) {
  return <label>添加到<select value={value} onChange={event => onChange(event.target.value)}>
    {root && <option value="">顶层</option>}
    {groups.map(group => <option value={group.row.id} key={group.row.id}>{group.row.id}</option>)}
  </select></label>
}

export function PresetDialog({ dialog, document, catalog, busy, feedback, saved, onClose, onField, onSubmit }) {
  const ref = useRef(null)
  const titleId = useId()
  const [title, action] = dialog.kind === 'discard' ? [dialog.title, dialog.actionLabel] : dialogLabels[dialog.kind]
  const fields = dialog.fields ?? {}
  useEffect(() => {
    const node = ref.current
    const previouslyFocused = node.ownerDocument.activeElement
    node.showModal()
    node.querySelector('[data-preset-autofocus]')?.focus()
    return () => {
      node.close()
      if (previouslyFocused?.isConnected && !previouslyFocused.disabled) previouslyFocused.focus()
    }
  }, [])

  const hasName = ['create', 'metadata', 'plugin', 'group'].includes(dialog.kind)
  const query = (fields.name ?? '').trim().toLowerCase()
  const choices = dialog.kind === 'plugin' ? [...catalog.values()].filter(item => !isGroup({ name: item.moduleName })
    && [item.label, item.moduleName, item.description].some(value => value?.toLowerCase().includes(query))) : []
  return <dialog ref={ref} className="preset-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <form onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <header className="preset-dialog-heading"><h2 id={titleId}>{title}</h2></header>
      <div className="preset-dialog-body preset-fields">
        {['create', 'metadata'].includes(dialog.kind) && <>
          {dialog.kind === 'create' && <p className="preset-caption">来源 {dialog.sourceName}</p>}
          <label>预设名称<input data-preset-autofocus required disabled={busy} value={fields.name} onChange={event => onField('name', event.target.value)} /></label>
          <label>说明 <small>可选</small><textarea rows={3} disabled={busy} value={fields.description} onChange={event => onField('description', event.target.value)} /></label>
        </>}
        {dialog.kind === 'plugin' && <>
          <label>插件模块 <small>搜索目录或输入完整模块名</small>
            <input data-preset-autofocus required spellCheck={false} disabled={busy} value={fields.name} onChange={event => onField('name', event.target.value)} />
          </label>
          {choices.length > 0 && <ul className="preset-catalog" aria-label="插件目录">
            {choices.map(item => <li key={item.moduleName}><button type="button" disabled={busy} aria-pressed={fields.name === item.moduleName} onClick={() => onField('name', item.moduleName)}>
              <strong>{item.label || item.moduleName}</strong>
              {item.label && item.label !== item.moduleName && <span className="preset-module">{item.moduleName}</span>}
            </button></li>)}
          </ul>}
        </>}
        {dialog.kind === 'group' && <label>分组名称<input data-preset-autofocus required disabled={busy} value={fields.name} onChange={event => onField('name', event.target.value)} /></label>}
        {['plugin', 'group'].includes(dialog.kind) && <GroupPicker groups={dialog.groups} root={true} value={fields.parentId} onChange={value => onField('parentId', value)} />}
        {dialog.kind === 'move' && <>
          <p>移动「<strong>{dialog.name}</strong>」并放在目标分组末尾。</p>
          <label>移动到<select data-preset-autofocus value={fields.parentId} onChange={event => onField('parentId', event.target.value)}>
            {dialog.root && <option value="">顶层</option>}
            {dialog.groups.map(group => <option key={group.row.id} value={group.row.id}>{group.row.id}</option>)}
          </select></label>
        </>}
        {dialog.kind === 'delete' && <p>删除「<strong>{dialog.name}</strong>」以及其中的 {dialog.count} 项组件。可使用撤销恢复。</p>}
        {dialog.kind === 'discard' && <p>{dialog.message}</p>}
        {dialog.kind === 'publish' && <PublicationReview dialog={dialog} document={document} catalog={catalog} />}
        {dialog.error && <p className="preset-inline-error" role="alert">{dialog.error}</p>}
        {feedback?.kind === 'error' && <div>
          {dialog.kind === 'publish' && saved && <p className="preset-caption">草稿已保存。</p>}
          <p className="preset-inline-error" role="alert">{feedback.message}</p>
        </div>}
      </div>
      <footer className="preset-dialog-actions">
        <button type="button" className="preset-button" disabled={busy} onClick={onClose}>{dialog.kind === 'publish' ? '返回编辑' : '取消'}</button>
        <button type="submit" className={`preset-button ${['discard', 'delete'].includes(dialog.kind) ? 'preset-danger' : 'preset-primary'}`}
          disabled={busy || (hasName && !fields.name.trim()) || (dialog.kind === 'publish' && feedback?.code === 'revision-conflict')}>
          {busy ? (dialog.kind === 'publish' ? '正在发布…' : '请稍候…') : action}
        </button>
      </footer>
    </form>
  </dialog>
}
