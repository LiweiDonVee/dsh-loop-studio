import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LoopWorkspace } from '../../src/LoopWorkspace.jsx'
import { PresetPlanEditor } from '../../src/PresetPlanEditor.jsx'
import { createNativeExecutionPlan, createStarterExecutionPlan, executionPlanIssues } from '../../src/plan.mjs'

const models = [
  { provider: 'fixture', id: 'quick', name: 'Quick' },
  { provider: 'fixture', id: 'precise', name: 'Precise', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
]

function openEditor(initial = createNativeExecutionPlan(), readOnly = false) {
  const changes = vi.fn()
  function Draft() {
    const [plan, setPlan] = useState(initial)
    return <PresetPlanEditor plan={plan} models={models} readOnly={readOnly} onChange={next => {
      changes(next)
      setPlan(next)
    }} />
  }
  render(<Draft />)
  return changes
}

afterEach(cleanup)

it('switches between the native source summary and a valid editable starter graph', () => {
  const changes = openEditor({ mode: 'native' })
  expect(screen.queryByRole('group', { name: '连线画布' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '启用连线编排' }))
  expect(changes).toHaveBeenLastCalledWith(createStarterExecutionPlan())
  expect(screen.getByRole('group', { name: '连线画布' })).toBeVisible()
  expect(screen.getByLabelText('未调用工具')).toHaveValue('end')
  expect(screen.getByLabelText('调用了工具')).toHaveValue('tools')
  fireEvent.click(screen.getByRole('button', { name: '恢复宿主顺序' }))
  expect(changes).toHaveBeenLastCalledWith(createNativeExecutionPlan())
})

it('edits a model and rewires a typed outcome using both the selector and graph handles', () => {
  const changes = openEditor(createStarterExecutionPlan())
  fireEvent.click(screen.getByRole('button', { name: '添加模型步骤' }))
  const added = changes.mock.lastCall[0].nodes.at(-1)
  expect(screen.getByText('模型步骤 · 请为「未调用工具」选择目标。')).toBeVisible()
  expect(screen.getByLabelText('未调用工具')).toHaveAttribute('aria-invalid', 'true')
  expect(within(screen.getByLabelText('未调用工具')).queryByRole('option', { name: '执行工具' })).toBeNull()
  expect(within(screen.getByLabelText('调用了工具')).queryByRole('option', { name: '回合结束' })).toBeNull()

  fireEvent.change(screen.getByLabelText('节点名称'), { target: { value: '复核结果' } })
  fireEvent.change(screen.getByLabelText('步骤指令'), { target: { value: '核对上一条回复。' } })
  fireEvent.change(screen.getByLabelText('提供方'), { target: { value: 'fixture' } })
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'precise' } })
  fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } })
  fireEvent.change(screen.getByLabelText('输出 token 上限'), { target: { value: '512' } })
  fireEvent.change(screen.getByLabelText('未调用工具'), { target: { value: 'end' } })
  expect(screen.getByText('复核结果 · 从回合入口无法到达此节点。')).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: '连接 模型请求 · 未调用工具' }))
  const count = changes.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '连接到 执行工具' }))
  expect(changes.mock.calls).toHaveLength(count)
  expect(screen.getByText('请选择此出口标出的可连接节点。')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '连接到 复核结果' }))

  const plan = changes.mock.lastCall[0]
  expect(plan.edges.find(edge => edge.id === 'model-end')).toEqual({ id: 'model-end', from: 'model', when: 'no-tools', to: added.id })
  expect(plan.nodes.at(-1)).toEqual({ ...added, label: '复核结果', instruction: '核对上一条回复。',
    route: { provider: 'fixture', model: 'precise', reasoningEffort: 'high', maxTokens: 512 } })
  expect(executionPlanIssues(plan)).toEqual([])
  expect(screen.getByLabelText('未调用工具')).toHaveValue(added.id)
})

it('updates the entry, removes attached wires and shows an invalid step limit', () => {
  const changes = openEditor(createStarterExecutionPlan())
  fireEvent.click(screen.getByRole('button', { name: '添加模型步骤' }))
  const replacement = changes.mock.lastCall[0].nodes.at(-1).id
  fireEvent.click(screen.getByRole('button', { name: '设为回合入口' }))
  expect(changes.mock.lastCall[0].entryNodeId).toBe(replacement)
  fireEvent.click(screen.getByRole('button', { name: '删除节点' }))
  expect(changes.mock.lastCall[0].entryNodeId).toBe('')
  expect(screen.getByText('请选择一个模型步骤作为回合入口。')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '执行工具 工具批次' }))
  fireEvent.click(screen.getByRole('button', { name: '删除节点' }))
  expect(changes.mock.lastCall[0].edges.map(edge => edge.id)).toEqual(['model-end'])
  fireEvent.change(screen.getByLabelText('每回合模型请求上限'), { target: { value: '257' } })
  expect(screen.getByLabelText('每回合模型请求上限')).toHaveAttribute('aria-invalid', 'true')
})

it('keeps a read-only plan inspectable and disables rewiring', () => {
  const changes = openEditor(createStarterExecutionPlan(), true)
  expect(screen.queryByRole('button', { name: '添加模型步骤' })).toBeNull()
  expect(screen.getByRole('button', { name: '连接 模型请求 · 未调用工具' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '执行工具 工具批次' }))
  expect(screen.getByLabelText('工具完成后')).toHaveValue('model')
  expect(screen.getByLabelText('工具完成后')).toBeDisabled()
  expect(changes).not.toHaveBeenCalled()
})

it('displays the bound live publication and keeps independent participant controls', async () => {
  const plannedId = 'host.execution.review'
  const activeGraphId = 'loop-studio:fixture:1:published:3'
  const detail = {
    revision: 2, selectedPresetId: 'loop-studio.fixture', presets: [{ id: 'loop-studio.fixture', name: 'Fixture' }],
    executionPublication: { presetId: 'loop-studio.fixture', version: 3, latestVersion: 4, mode: 'graph' },
    graph: { id: activeGraphId, entryNodeId: plannedId, nodes: [
      { id: plannedId, executionNodeId: 'review', label: '复核结果', kind: 'model', source: 'host', control: 'observe',
        configuredRoute: { provider: 'fixture', model: 'precise' } },
      { id: 'rp.stage', label: 'RP 独立步骤', kind: 'model', source: 'rp', control: 'route' },
    ], edges: [] },
    trace: [
      { id: 'matching', nodeId: plannedId, graphId: activeGraphId, provider: 'fixture', model: 'actual', status: 'completed' },
      { id: 'other-version', nodeId: plannedId, graphId: 'loop-studio:fixture:1:published:2', provider: 'old', model: 'different' },
    ],
    models, routingCapability: 'supported', policies: { session: null, preset: null },
  }
  const client = { inspect: vi.fn(async () => detail), subscribe: vi.fn(() => () => {}) }
  render(<LoopWorkspace sessionId="fixture" client={client} />)
  expect(await screen.findByText('当前会话 · 编排 v3')).toBeVisible()
  expect(screen.getByText('最新发布 v4')).toBeVisible()
  const inspector = within(screen.getByRole('complementary', { name: '节点详情' }))
  expect(inspector.getByLabelText('当前配置')).toHaveTextContent('fixture / precise')
  expect(inspector.getByLabelText('最近实际请求')).toHaveTextContent('fixture / actual')
  expect(inspector.queryByRole('checkbox', { name: '启用模型接管' })).toBeNull()
  expect(inspector.getByRole('button', { name: '编辑执行编排' })).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'RP 独立步骤' }))
  expect(inspector.getByRole('checkbox', { name: '启用模型接管' })).toBeEnabled()
})
