import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import {
  createNativeExecutionPlan, createStarterExecutionPlan, DEFAULT_MODEL_STEPS, executionPlanIssues,
  EXECUTION_TARGET_KINDS as targets, MAX_EXECUTION_NODES, MAX_MODEL_STEPS, MAX_NODE_INSTRUCTION, MAX_NODE_LABEL,
} from './plan.mjs'

const nodeKind = { model: '模型步骤', tools: '工具批次', end: '结束节点' }
const exitLabel = { 'no-tools': '未调用工具', tools: '调用了工具', next: '工具完成后' }
const nodeName = node => node?.label || (node ? `未命名${nodeKind[node.kind]}` : '')
const exitKey = (nodeId, when) => `${nodeId}:${when}`
const newId = kind => `${kind}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`

function issueText(issue) {
  const port = exitLabel[issue.when]
  const messages = {
    'invalid-step-limit': `每回合模型请求上限须为 1 至 ${MAX_MODEL_STEPS} 的整数。`,
    'invalid-entry': '请选择一个模型步骤作为回合入口。',
    'invalid-label': `节点名称须包含 1 至 ${MAX_NODE_LABEL} 个字符。`,
    'invalid-route': '请选择提供方和模型，并填写有效的推理强度及输出上限。',
    'invalid-exit': `${port || '此出口'}连到了不适用的节点。`,
    'duplicate-exit': `${port || '此出口'}只能连接一个目标。`,
    'missing-exit': `请为「${port}」选择目标。`,
    'unreachable-node': '从回合入口无法到达此节点。',
    'no-end-path': '请连接一条可到达结束节点的路径。',
  }
  return messages[issue.code] || issue.message || issue.code
}

function measureGraph(canvas) {
  const rect = canvas.getBoundingClientRect()
  const point = element => {
    const bounds = element.getBoundingClientRect()
    return { x: bounds.left + bounds.width / 2 - rect.left, y: bounds.top + bounds.height / 2 - rect.top }
  }
  const inputs = new Map()
  const outputs = new Map()
  for (const card of canvas.querySelectorAll('[data-plan-node]')) {
    const id = card.dataset.planNode
    inputs.set(id, { ...point(card.querySelector('[data-plan-input]')), top: card.getBoundingClientRect().top - rect.top })
    for (const output of card.querySelectorAll('[data-plan-output]')) {
      outputs.set(exitKey(id, output.dataset.planOutput), point(output.querySelector('.loop-plan-port-dot')))
    }
  }
  return { width: rect.width, height: rect.height, inputs, outputs }
}

function wirePath(from, to, width, index) {
  const lane = index % 3 * 4
  return `M ${from.x} ${from.y} H ${width - 7 - lane} V ${to.top - 8 - lane} H ${7 + lane} V ${to.y} H ${to.x - 4}`
}

function PlanGraph({ plan, selectedId, nodeIssues, onSelect, onConnect, readOnly }) {
  const marker = `loop-plan-arrow-${useId().replace(/:/g, '')}`
  const canvasRef = useRef(null)
  const gesture = useRef(null)
  const skipClick = useRef(false)
  const [geometry, setGeometry] = useState(null)
  const [intent, setIntent] = useState(null)
  const [pointer, setPointer] = useState(null)
  const [feedback, setFeedback] = useState('')
  const source = !readOnly && intent?.plan === plan ? intent : null
  const fromNode = source && plan.nodes.find(node => node.id === source.nodeId)
  const eligible = source ? targets[fromNode?.kind]?.[source.when] || [] : []
  const labels = new Map(plan.nodes.map(node => [node.id, nodeName(node)]))
  const exits = new Map(plan.edges.map(edge => [exitKey(edge.from, edge.when), edge]))

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const update = () => setGeometry(measureGraph(canvas))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(canvas)
    for (const card of canvas.querySelectorAll('[data-plan-node]')) observer.observe(card)
    return () => observer.disconnect()
  }, [plan.nodes])

  function chooseSource(nodeId, when) {
    const same = source?.nodeId === nodeId && source.when === when
    setFeedback('')
    setIntent(same ? null : { nodeId, when, plan })
    onSelect(nodeId, false)
  }

  function connect(source, targetId) {
    const target = plan.nodes.find(node => node.id === targetId)
    const from = plan.nodes.find(node => node.id === source.nodeId)
    if (!target || !targets[from?.kind]?.[source.when]?.includes(target.kind)) {
      setFeedback(target ? '请选择此出口标出的可连接节点。' : '请把连线放到目标节点上。')
      return
    }
    onConnect(source.nodeId, source.when, target.id)
    setIntent(null)
    setFeedback('')
  }

  function nodeAt(event) {
    const canvas = canvasRef.current
    const hit = canvas.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest('[data-plan-node]')
    return canvas.contains(hit) ? hit.dataset.planNode : undefined
  }

  function beginDrag(event, nodeId, when) {
    if (readOnly || event.button !== 0 || gesture.current) return
    skipClick.current = false
    const handle = event.currentTarget
    gesture.current = { nodeId, when, plan, handle, id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    handle.setPointerCapture?.(event.pointerId)
  }

  function moveDrag(event) {
    const current = gesture.current
    if (readOnly || current?.id !== event.pointerId || current.plan !== plan) return
    if (!current.moved) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return
      current.moved = true
      setIntent(current)
      setFeedback('')
      onSelect(current.nodeId, false)
    }
    const bounds = canvasRef.current.getBoundingClientRect()
    setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, targetId: nodeAt(event) })
  }

  function endDrag(event) {
    const current = gesture.current
    if (current?.id !== event.pointerId) return
    gesture.current = null
    setPointer(null)
    if (!current.moved) return
    skipClick.current = true
    if (!readOnly && current.plan === plan) connect(current, nodeAt(event))
  }

  function cancelConnection() {
    const current = gesture.current
    gesture.current = null
    if (current?.handle.hasPointerCapture?.(current.id)) current.handle.releasePointerCapture(current.id)
    setIntent(null)
    setPointer(null)
    setFeedback('')
  }

  const previewStart = source && pointer && geometry?.outputs.get(exitKey(source.nodeId, source.when))
  return <div className="loop-plan-map">
    <div ref={canvasRef} className="loop-plan-canvas" aria-label="连线画布" role="group"
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelConnection}
      onLostPointerCapture={() => { if (gesture.current) cancelConnection() }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !source) return
        event.stopPropagation()
        cancelConnection()
      }}>
      <svg className="loop-plan-wires" aria-hidden="true" viewBox={geometry?.width ? `0 0 ${geometry.width} ${geometry.height}` : undefined}>
        <defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="m1 1 5 3-5 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </marker></defs>
        {plan.edges.map((edge, index) => {
          const from = geometry?.outputs.get(exitKey(edge.from, edge.when))
          const to = geometry?.inputs.get(edge.to)
          return from && to && <path key={edge.id} className="loop-plan-wire" data-plan-edge={edge.id} data-when={edge.when}
            data-selected={edge.from === selectedId || undefined} d={wirePath(from, to, geometry.width, index)} markerEnd={`url(#${marker})`} />
        })}
        {previewStart && <path className="loop-plan-wire loop-plan-preview"
          d={`M ${previewStart.x} ${previewStart.y} C ${previewStart.x + 24} ${previewStart.y}, ${pointer.x - 20} ${pointer.y}, ${pointer.x} ${pointer.y}`} />}
      </svg>
      {plan.nodes.map(node => {
        const label = labels.get(node.id)
        const isTarget = eligible.includes(node.kind)
        const isEntry = plan.entryNodeId === node.id
        const activate = () => source ? connect(source, node.id) : onSelect(node.id, true)
        return <div key={node.id} className="loop-plan-node" data-plan-node={node.id} data-kind={node.kind}
          data-selected={node.id === selectedId || undefined} data-eligible={isTarget || undefined}
          data-hovered={isTarget && pointer?.targetId === node.id || undefined} data-issue={nodeIssues.has(node.id) || undefined}>
          <button type="button" className="loop-plan-node-input" data-plan-input="" disabled={readOnly}
            aria-label={`连接到 ${label}`} title={`连接到 ${label}`} tabIndex={source ? 0 : -1} onClick={activate}><span /></button>
          <button type="button" className="loop-plan-node-title" aria-pressed={node.id === selectedId} title={label} onClick={activate}>
            <strong>{label}</strong><small>{isEntry ? '回合入口' : nodeKind[node.kind]}</small>
          </button>
          {Object.keys(targets[node.kind]).map(when => {
            const edge = exits.get(exitKey(node.id, when))
            return <button key={when} type="button" className="loop-plan-output" data-plan-output={when} data-linked={Boolean(edge) || undefined}
              disabled={readOnly} aria-pressed={source?.nodeId === node.id && source.when === when}
              aria-label={`连接 ${label} · ${exitLabel[when]}`} title={edge ? `${exitLabel[when]} → ${labels.get(edge.to)}` : exitLabel[when]}
              onPointerDown={event => beginDrag(event, node.id, when)} onClick={event => {
                if (skipClick.current && event.detail > 0) { skipClick.current = false; return }
                chooseSource(node.id, when)
              }}><span>{exitLabel[when]}</span><span className="loop-plan-port-dot" aria-hidden="true" /></button>
          })}
        </div>
      })}
      {!plan.nodes.length && <p className="loop-plan-help">添加模型步骤并设置回合入口。</p>}
    </div>
    {!readOnly && plan.nodes.length > 0 && <p className="loop-plan-help" role="status">
      {source ? feedback || '选择目标节点，按 Esc 取消。' : '拖动出口连线，也可在节点详情中选择目标。'}
    </p>}
  </div>
}

function ModelFields({ node, models, onChange }) {
  const instructionHint = useId()
  const route = node.route
  const providers = [...new Set(models.map(model => model.provider))]
  if (route && !providers.includes(route.provider)) providers.push(route.provider)
  const providerModels = models.filter(model => model.provider === route?.provider)
  const model = providerModels.find(model => model.id === route?.model)
  const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []

  function selectProvider(provider) {
    const first = models.find(model => model.provider === provider)
    if (!first) onChange({ route: undefined })
    else onChange({ route: { provider, model: first.id, maxTokens: route?.maxTokens } })
  }

  return <>
    <div className="loop-plan-field">
      <label className="loop-plan-field"><span>步骤指令</span><textarea rows="3" maxLength={MAX_NODE_INSTRUCTION} value={node.instruction}
        aria-describedby={instructionHint} onChange={event => onChange({ instruction: event.target.value })} /></label>
      <small id={instructionHint}>步骤指令会作为插件消息保留在会话历史中。</small>
    </div>
    <label className="loop-plan-field"><span>提供方</span><select aria-label="提供方" value={route?.provider || ''} onChange={event => selectProvider(event.target.value)}>
      <option value="">继承宿主选择</option>
      {providers.map(provider => <option key={provider} value={provider}>{provider}</option>)}
    </select></label>
    {route && <>
      <label className="loop-plan-field"><span>模型</span><select aria-label="模型" value={route.model}
        onChange={event => onChange({ route: { ...route, model: event.target.value, reasoningEffort: undefined } })}>
        {!model && <option value={route.model}>{route.model}</option>}
        {providerModels.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select></label>
      {(efforts.length > 0 || route.reasoningEffort) && <label className="loop-plan-field"><span>推理强度</span>
        <select aria-label="推理强度" value={route.reasoningEffort || ''} onChange={event => onChange({ route: { ...route, reasoningEffort: event.target.value || undefined } })}>
          <option value="">模型默认</option>
          {route.reasoningEffort && !efforts.some(effort => effort.id === route.reasoningEffort) && <option value={route.reasoningEffort}>{route.reasoningEffort}</option>}
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>)}
        </select>
      </label>}
      <label className="loop-plan-field"><span>输出 token 上限</span>
        <input type="number" min="1" step="1" placeholder="模型默认" value={route.maxTokens ?? ''}
          onChange={event => onChange({ route: { ...route, maxTokens: event.target.value === '' ? undefined : Number(event.target.value) } })} />
      </label>
    </>}
  </>
}

function NodeDetails({ node, plan, models, readOnly, issues, panelRef, onChange, onEntry, onRemove, onConnect }) {
  if (!node) return null
  const ports = Object.entries(targets[node.kind])
  return <aside ref={panelRef} className="loop-plan-details" aria-label="编排节点详情">
    <div className="loop-plan-heading"><h4>{nodeKind[node.kind]}</h4>
      {!readOnly && <button type="button" className="loop-plan-button loop-plan-remove" onClick={onRemove}>删除节点</button>}
    </div>
    <fieldset disabled={readOnly} className="loop-plan-fields">
      <label className="loop-plan-field"><span>节点名称</span><input type="text" maxLength={MAX_NODE_LABEL} value={node.label}
        aria-invalid={issues.some(issue => issue.code === 'invalid-label') || undefined}
        onChange={event => onChange({ label: event.target.value })} /></label>
      {node.kind === 'model' && <>
        {plan.entryNodeId !== node.id && !readOnly && <button type="button" className="loop-plan-button loop-plan-set-entry" onClick={onEntry}>设为回合入口</button>}
        <ModelFields node={node} models={models} onChange={onChange} />
      </>}
      {node.kind === 'tools' && <label className="loop-plan-field"><span>批次执行方式</span>
        <select aria-label="批次执行方式" value={node.execution} onChange={event => onChange({ execution: event.target.value })}>
          <option value="inherit">继承宿主配置</option><option value="sequential">依次执行</option>
        </select>
      </label>}
      {ports.length > 0 && <div className="loop-plan-exits">
        {ports.map(([when, kinds]) => {
          const edge = plan.edges.find(edge => edge.from === node.id && edge.when === when)
          const options = plan.nodes.filter(target => kinds.includes(target.kind))
          return <label key={when} className="loop-plan-field"><span>{exitLabel[when]}</span>
            <select aria-label={exitLabel[when]} value={edge?.to || ''} aria-invalid={issues.some(issue => issue.when === when) || undefined}
              onChange={event => onConnect(node.id, when, event.target.value)}>
              <option value="">{when === 'tools' ? '无 · 此步骤不提供工具' : '选择目标'}</option>
              {edge && !options.some(target => target.id === edge.to) && <option value={edge.to}>无效目标 · {edge.to}</option>}
              {options.map(target => <option key={target.id} value={target.id}>{nodeName(target)}{target.id === node.id ? '（此节点）' : ''}</option>)}
            </select>
          </label>
        })}
      </div>}
    </fieldset>
  </aside>
}

export function PresetPlanEditor({ plan, onChange, models = [], readOnly = false, issues = [] }) {
  const headingId = useId()
  const detailsRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const execution = plan?.mode === 'graph' ? plan : createNativeExecutionPlan()
  const graph = execution.mode === 'graph'
  const selected = execution.nodes.find(node => node.id === selectedId)
    || execution.nodes.find(node => node.id === execution.entryNodeId) || execution.nodes[0]
  const diagnostics = [...executionPlanIssues(execution), ...issues]
  const messages = new Set(diagnostics.map(issue => {
    if (typeof issue === 'string') return issue
    const node = execution.nodes.find(node => node.id === issue.nodeId)
    const message = issueText(issue)
    return node ? `${nodeName(node)} · ${message}` : message
  }).filter(Boolean))

  function change(next) {
    if (!readOnly) onChange(next)
  }

  function addNode(kind) {
    const id = newId(kind)
    const label = nodeKind[kind]
    const taken = new Set(execution.nodes.map(node => node.label))
    let name = label
    for (let index = 2; taken.has(name); index++) name = `${label} ${index}`
    const base = { id, label: name, kind }
    const node = kind === 'model' ? { ...base, instruction: '' } : kind === 'tools' ? { ...base, execution: 'inherit' } : base
    setSelectedId(id)
    change({ ...execution, nodes: [...execution.nodes, node] })
  }

  function editNode(patch) {
    const node = { ...selected, ...patch }
    if (node.route === undefined) delete node.route
    else node.route = Object.fromEntries(Object.entries(node.route).filter(([, value]) => value !== undefined))
    change({ ...execution, nodes: execution.nodes.map(current => current.id === node.id ? node : current) })
  }

  function removeNode() {
    const { id } = selected
    change({ ...execution, entryNodeId: execution.entryNodeId === id ? '' : execution.entryNodeId,
      nodes: execution.nodes.filter(node => node.id !== id), edges: execution.edges.filter(edge => edge.from !== id && edge.to !== id) })
  }

  function connect(nodeId, when, targetId) {
    const edge = execution.edges.find(edge => edge.from === nodeId && edge.when === when)
    if (edge?.to === targetId || !edge && !targetId) return
    if (!targetId) change({ ...execution, edges: execution.edges.filter(current => current !== edge) })
    else if (edge) change({ ...execution, edges: execution.edges.map(current => current === edge ? { ...edge, to: targetId } : current) })
    else change({ ...execution, edges: [...execution.edges, { id: newId('edge'), from: nodeId, to: targetId, when }] })
  }

  return <section className="loop-plan-editor" aria-labelledby={headingId}>
    <div className="loop-plan-heading"><h3 id={headingId}>连线编排</h3>
      {graph && !readOnly && <button type="button" className="loop-plan-button" onClick={() => change(createNativeExecutionPlan())}>恢复宿主顺序</button>}
    </div>
    {messages.size > 0 && <ul className="loop-plan-errors" aria-label="编排校验问题" role="status">
      {[...messages].map(message => <li key={message}>{message}</li>)}
    </ul>}
    {graph ? <>
      <div className="loop-plan-toolbar">
        {!readOnly && <div className="loop-plan-palette" role="group" aria-label="添加节点">
          {Object.entries(nodeKind).map(([kind, label]) => <button key={kind} type="button" className="loop-plan-button"
            aria-label={`添加${label}`} disabled={execution.nodes.length >= MAX_EXECUTION_NODES} onClick={() => addNode(kind)}>＋ {label}</button>)}
        </div>}
        <label className="loop-plan-field loop-plan-limit"><span>每回合模型请求上限</span>
          <input type="number" min="1" max={MAX_MODEL_STEPS} step="1" disabled={readOnly}
            aria-invalid={diagnostics.some(issue => issue.code === 'invalid-step-limit') || undefined}
            value={execution.maxModelSteps === 0 ? '' : execution.maxModelSteps ?? DEFAULT_MODEL_STEPS}
            onChange={event => change({ ...execution, maxModelSteps: Number(event.target.value) })} />
        </label>
      </div>
      <div className="loop-plan-layout">
        <PlanGraph plan={execution} selectedId={selected?.id} readOnly={readOnly}
          nodeIssues={new Set(diagnostics.map(issue => issue.nodeId))} onConnect={connect} onSelect={(id, reveal) => {
            setSelectedId(id)
            if (reveal) detailsRef.current?.scrollIntoView?.({ block: 'nearest' })
          }} />
        <NodeDetails node={selected} plan={execution} models={models} readOnly={readOnly} panelRef={detailsRef}
          issues={diagnostics.filter(issue => issue.nodeId === selected?.id)} onChange={editNode} onRemove={removeNode}
          onEntry={() => change({ ...execution, entryNodeId: selected.id })} onConnect={connect} />
      </div>
    </> : <div className="loop-plan-native"><p>使用 DSH 的执行顺序。</p>
      {!readOnly && <button type="button" className="loop-plan-button loop-plan-enable" onClick={() => change(createStarterExecutionPlan())}>启用连线编排</button>}
    </div>}
  </section>
}
