import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoopWorkspace } from '../../src/LoopWorkspace.jsx'

const original = {
  name: '标准模式', description: '测试来源', execution: { mode: 'native' },
  rows: [
    {
      id: 'existing', name: 'cordis:group', isolate: { tool: true },
      config: [{ id: 'keep', name: '@fixture/condition', disabled: { __jsExpr: '!ctx.feature' }, intercept: { tools: ['one'] } }],
    },
    { id: 'toggle', name: '@fixture/toggle', disabled: true, config: { limit: 1 }, extra: { preserved: true } },
  ],
}
const publishedId = 'loop-studio.fixture-copy'
const catalog = [
  { moduleName: '@fixture/condition', label: '条件插件', source: 'preset' },
  { moduleName: '@fixture/toggle', label: '可切换插件', source: 'preset' },
  { moduleName: '@fixture/extra', label: '附加插件', source: 'installed' },
]

function createClient() {
  let draft
  let preset = 'standard'
  let listener
  let routeRevision = 7
  const sources = [{ id: 'standard', name: '标准模式', editableCopy: true }]
  const source = { presetId: 'standard', name: original.name }
  const client = {
    inspect: vi.fn(async () => ({
      revision: routeRevision, selectedPresetId: preset,
      presets: [...sources, ...(draft?.published ? [{ id: publishedId, name: draft.name }] : [])],
      composition: [], graph: { nodes: [{ id: 'host.first', label: '首个模型请求', kind: 'model', control: 'route' }], edges: [] },
      models: [], diagnostics: [], trace: [], policies: {}, effectivePolicy: { enabled: false, routes: {} }, routingCapability: 'supported',
    })),
    subscribe: vi.fn((_id, onEvent) => { listener = onEvent; return () => { listener = undefined } }),
    listStructures: vi.fn(async () => ({
      sources, drafts: draft ? [{
        id: draft.draftId, name: draft.name, revision: draft.revision,
        publishedPresetId: draft.published?.presetId, publishedVersion: draft.published?.version,
        publishedActivation: draft.published?.activation,
      }] : [],
      capabilities: { canSelectCurrent: true, canExecuteGraph: true },
    })),
    readStructure: vi.fn(async (_id, input) => input.draftId ? draft : { ...original, source, catalog, readOnly: true }),
    createStructure: vi.fn(async (_id, input) => {
      draft = {
        ...original, name: input.name, description: input.description,
        source, catalog, readOnly: false, draftId: 'fixture-copy', revision: 0,
        hasUnpublishedChanges: true, baseDocument: original,
      }
      return draft
    }),
    saveStructure: vi.fn(async (_id, input) => {
      if (input.expectedRevision !== draft.revision) throw Object.assign(new Error('stale'), { code: 'revision-conflict' })
      draft = { ...draft, ...input.document, revision: draft.revision + 1, hasUnpublishedChanges: true }
      return draft
    }),
    validateStructure: vi.fn(async () => ({ valid: true, issues: [] })),
    publishStructure: vi.fn(async (_id, input) => {
      expect(input.expectedRevision).toBe(draft.revision)
      const version = (draft.published?.version ?? 0) + 1
      const { name, description, rows, execution } = draft
      draft = {
        ...draft, revision: draft.revision + 1, baseDocument: { name, description, rows, execution }, hasUnpublishedChanges: false,
        published: { presetId: publishedId, version, activation: 'ready' },
      }
      return { draft, presetId: publishedId, version, activation: 'ready' }
    }),
    selectStructure: vi.fn(async () => {
      preset = publishedId
      routeRevision++
      return { presetId: publishedId, selected: true }
    }),
    changeTrace() {
      routeRevision++
      listener?.({ type: 'changed', sessionId: 'session' })
    },
    updateExternally() {
      draft = { ...draft, name: '另一窗口的副本', revision: draft.revision + 1 }
    },
  }
  return client
}

beforeEach(() => {
  // jsdom provides the element but does not implement Chromium's dialog lifecycle.
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value() { this.setAttribute('open', '') } },
      close: { configurable: true, value() { this.removeAttribute('open') } },
    })
  }
})
afterEach(cleanup)

const button = (name, area = screen) => area.getByRole('button', { name, exact: true })
const row = id => document.querySelector(`[data-preset-row="${id}"]`)
const chooseRow = id => fireEvent.click(row(id).querySelector('.preset-row-select'))

async function openEditor(client) {
  const view = render(<LoopWorkspace sessionId="session" client={client} />)
  await screen.findByRole('button', { name: '首个模型请求' })
  const flow = screen.getByRole('tab', { name: '执行流程' })
  flow.focus()
  fireEvent.keyDown(flow, { key: 'ArrowRight' })
  const structure = screen.getByRole('tab', { name: '预设结构' })
  expect(structure).toHaveFocus()
  expect(structure).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('button', { name: '首个模型请求' })).not.toBeInTheDocument()
  await screen.findByRole('button', { name: '创建可编辑副本' })
  return view
}

async function createDraft() {
  fireEvent.click(button('创建可编辑副本'))
  const dialog = within(screen.getByRole('dialog', { name: '创建可编辑副本' }))
  fireEvent.change(dialog.getByLabelText('预设名称'), { target: { value: '我的预设' } })
  fireEvent.click(button('创建副本', dialog))
  await screen.findByText('可编辑副本已创建。')
}

describe('native preset structure editor', () => {
  it('edits a native copy without flattening groups, options, or conditions, then publishes and selects it', async () => {
    const client = createClient()
    await openEditor(client)
    expect(row('keep')).toHaveTextContent('条件启用')
    expect(screen.queryByRole('checkbox', { name: '启用 可切换插件' })).not.toBeInTheDocument()
    await createDraft()
    expect(client.createStructure).toHaveBeenCalledWith('session', {
      sourcePresetId: 'standard', name: '我的预设', description: '测试来源',
    }, expect.any(AbortSignal))

    fireEvent.click(button('添加分组'))
    const add = within(screen.getByRole('dialog', { name: '添加分组' }))
    expect(add.getByLabelText('添加到')).toHaveValue('')
    fireEvent.change(add.getByLabelText('分组名称'), { target: { value: 'qa-group' } })
    fireEvent.click(button('添加分组', add))
    fireEvent.change(screen.getByLabelText('分组名称'), { target: { value: 'qa-renamed' } })
    fireEvent.click(button('应用组件修改'))

    fireEvent.click(within(row('toggle')).getByRole('checkbox'))
    chooseRow('toggle')
    fireEvent.click(button('移动到…'))
    const move = within(screen.getByRole('dialog', { name: '移动组件' }))
    fireEvent.change(move.getByLabelText('移动到'), { target: { value: 'qa-renamed' } })
    fireEvent.click(button('移动', move))
    fireEvent.click(button('撤销'))
    expect(row('toggle')).toHaveTextContent('已启用')
    fireEvent.click(button('重做'))

    const config = screen.getByLabelText(/插件配置/)
    fireEvent.change(config, { target: { value: '{' } })
    fireEvent.click(button('应用组件修改'))
    expect(screen.getByRole('alert')).toHaveTextContent('插件配置需要有效的 JSON')
    expect(button('保存草稿')).toBeDisabled()
    fireEvent.change(config, { target: { value: '{"limit":8}' } })
    fireEvent.click(button('应用组件修改'))

    fireEvent.click(button('保存草稿'))
    await screen.findByText('草稿已保存。')
    const [sessionId, input] = client.saveStructure.mock.calls[0]
    expect(sessionId).toBe('session')
    expect(input.expectedRevision).toBe(0)
    expect(input.document.rows).toEqual([
      original.rows[0],
      { id: 'qa-renamed', name: 'cordis:group', group: true, config: [
        { ...original.rows[1], disabled: false, config: { limit: 8 } },
      ] },
    ])
    expect(client.publishStructure).not.toHaveBeenCalled()

    fireEvent.click(button('发布预设'))
    const review = within(await screen.findByRole('dialog', { name: '发布预设' }))
    expect(review.getByText('移动到其他分组 1 项')).toBeVisible()
    expect(review.getByText('新增 1 项')).toBeVisible()
    fireEvent.click(button('确认发布', review))
    await screen.findByText('已加入 DSH 预设列表')
    expect(client.publishStructure).toHaveBeenCalledWith('session', {
      draftId: 'fixture-copy', expectedRevision: 1,
    }, expect.any(AbortSignal))
    expect(client.selectStructure).not.toHaveBeenCalled()
    await waitFor(() => expect(button('在当前空白会话中使用')).toBeEnabled())
    fireEvent.click(button('在当前空白会话中使用'))
    await screen.findByText('当前空白会话已使用「我的预设」。')
    expect(client.selectStructure).toHaveBeenCalledWith('session', {
      draftId: 'fixture-copy', expectedRevision: 2,
    }, expect.any(AbortSignal))
    // Native blank selection can bind a later generation under the same preset ID.
    await waitFor(() => expect(button('在当前空白会话中使用')).toBeEnabled())
  })

  it('keeps pending fields when switching views and reloads a revision conflict only after explicit discard', async () => {
    const client = createClient()
    await openEditor(client)
    await createDraft()
    chooseRow('toggle')
    fireEvent.change(screen.getByLabelText(/插件配置/), { target: { value: '{"limit":9}' } })
    fireEvent.click(screen.getByRole('tab', { name: '执行流程' }))
    await act(async () => client.changeTrace())
    fireEvent.click(screen.getByRole('tab', { name: '预设结构' }))
    await waitFor(() => expect(button('应用组件修改')).toBeEnabled())
    expect(screen.getByLabelText(/插件配置/)).toHaveValue('{"limit":9}')
    fireEvent.click(button('应用组件修改'))

    client.updateExternally()
    fireEvent.click(button('保存草稿'))
    const conflict = await screen.findByRole('alert')
    expect(conflict).toHaveTextContent('当前修改已保留')
    expect(screen.getByLabelText(/插件配置/)).toHaveValue(JSON.stringify({ limit: 9 }, null, 2))
    fireEvent.click(button('重新载入草稿'))
    let dialog = within(screen.getByRole('dialog', { name: '重新载入草稿？' }))
    fireEvent.click(button('取消', dialog))
    expect(screen.getByLabelText(/插件配置/)).toHaveValue(JSON.stringify({ limit: 9 }, null, 2))
    fireEvent.click(button('重新载入草稿'))
    dialog = within(screen.getByRole('dialog', { name: '重新载入草稿？' }))
    fireEvent.click(button('丢弃修改并载入', dialog))
    await screen.findByRole('heading', { name: '另一窗口的副本' })
    chooseRow('toggle')
    expect(screen.getByLabelText(/插件配置/)).toHaveValue(JSON.stringify({ limit: 1 }, null, 2))
    expect(button('保存草稿')).toBeDisabled()
  })

  it('preserves a saved draft after a real activation error and allows a publish retry at its new revision', async () => {
    const client = createClient()
    await openEditor(client)
    await createDraft()
    fireEvent.click(within(row('toggle')).getByRole('checkbox'))
    client.publishStructure.mockRejectedValueOnce(Object.assign(new Error('验收插件激活失败'), {
      code: 'activation-failed', issues: [{ severity: 'error', code: 'activation-failed', rowId: 'toggle', message: '验收插件激活失败' }],
    }))

    fireEvent.click(button('发布预设'))
    let review = within(await screen.findByRole('dialog', { name: '发布预设' }))
    fireEvent.click(button('确认发布', review))
    expect(await review.findByRole('alert')).toHaveTextContent('验收插件激活失败')
    expect(review.getByText('草稿已保存。')).toBeVisible()
    expect(screen.queryByText('已加入 DSH 预设列表')).not.toBeInTheDocument()
    fireEvent.click(button('返回编辑', review))
    expect(row('toggle')).toHaveTextContent('1 项问题')
    expect(button('保存草稿')).toBeDisabled()

    fireEvent.click(button('发布预设'))
    review = within(await screen.findByRole('dialog', { name: '发布预设' }))
    fireEvent.click(button('确认发布', review))
    await screen.findByText('已加入 DSH 预设列表')
    expect(client.saveStructure).toHaveBeenCalledTimes(1)
    expect(client.publishStructure.mock.calls.map(call => call[1].expectedRevision)).toEqual([1, 1])
  })
})
