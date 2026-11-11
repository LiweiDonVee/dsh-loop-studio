import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { redact, save, sha, structureProvider } from './native-structure-runtime.mjs'

const requestPath = '/api/loop-studio/request'
export const sourceName = '结构验收源预设'
export const variantName = '结构与连线验收'
export const description = 'Synthetic acceptance preset with native tools and local model fixtures.'
export const doneText = 'STRUCTURE_FIXTURE_DONE'
export const stageLabels = { draft: '验收起草', review: '验收复核', alternate: '验收替代', final: '验收定稿' }
export const caps = { draft: 121, review: 133, alternate: 144, final: 155 }
export const instruction = model => 'WORKFLOW_INSTRUCTION_' + model.toUpperCase()

const button = (root, name) => root.getByRole('button', { name, exact: true })
const tab = (root, name) => root.getByRole('tab', { name, exact: true })
const select = (root, name) => root.getByRole('combobox', { name, exact: true })
const row = (root, id) => root.locator('li[data-preset-row="' + id + '"]')
const panel = page => page.locator('[data-loop-session]').filter({ visible: true })
const workspace = 'workspace'

export async function openNativePage(browser, host, report, identity) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => report.pageErrors.push(redact(error.message)))
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(redact(message.text()))
  })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === host.base || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue()
    report.blockedBrowserRequests.push({ origin: url.origin, path: url.pathname })
    return route.abort()
  })
  const moduleResponse = page.waitForResponse(response => response.url().includes('dsh-loop-studio/client.js')
    && !response.url().includes('dsh-loop-studio/client.js.map') && response.ok())
  // Observe the executable module delivered to Chromium. DSH can append combo framing and source map comments.
  await page.goto(host.url, { waitUntil: 'networkidle' })
  const preview = button(page, '继续')
  if (await preview.isVisible()) await preview.click()
  await page.getByRole('treeitem', { name: workspace, exact: true }).waitFor()
  const response = await moduleResponse
  const bytes = await response.body()
  const source = (await readFile(join(identity.installed, 'dist', 'client.js'), 'utf8'))
    .replace(/(?:\r?\n)?\/\/# sourceURL=[^\r\n]+(?:\r?\n)?$/, '')
    .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]+(?:\r?\n)?$/, '').trimEnd()
  assert.ok(bytes.includes(Buffer.from(source)), 'Chromium module response differs from the installed executable source')
  report.clientResources.push({ hostPid: host.ready.pid, status: response.status(), sha256: sha(bytes) })
  return page
}

async function chooseWorkspace(page) {
  const composer = page.locator('[data-composer-input][contenteditable=true]').filter({ visible: true })
  if (await composer.count() === 0) {
    await button(page, '选择工作区').click()
    await page.getByRole('menuitem', { name: workspace, exact: true }).click()
  }
  await composer.waitFor()
}

export async function showLoop(page) {
  const root = panel(page)
  if (!await root.isVisible()) await button(page, '打开 Loop Studio').click()
  await root.waitFor()
  return root
}

export async function openBlankSession(page, { newSession = false } = {}) {
  if (newSession) await button(page, '新建会话').filter({ visible: true }).first().click()
  await chooseWorkspace(page)
  await button(page, '标准模式').waitFor()
  const root = await showLoop(page)
  const sessionId = await root.getAttribute('data-loop-session')
  assert.ok(sessionId, 'The real Loop Studio slot did not receive the active session')
  return { root, sessionId }
}

export async function selectNativePreset(page, root) {
  const collapse = button(page, '收起右侧边栏')
  if (await collapse.isVisible()) await collapse.click()
  else await root.getByRole('tab', { name: '执行流程', exact: true }).click()
  await button(page, '标准模式').click()
  const item = page.getByRole('menuitem', { name: new RegExp('^' + variantName) })
  await item.click()
  await expect(button(page, variantName)).toBeEnabled()
}

export async function sendPrompt(page, prompt) {
  const before = await page.getByText(doneText, { exact: true }).count()
  await page.locator('[data-composer-input][contenteditable=true]').filter({ visible: true }).fill(prompt)
  await button(page, '发送消息').click()
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible()
  await expect.poll(() => page.getByText(doneText, { exact: true }).count()).toBeGreaterThan(before)
}

async function responseTo(page, action, operation) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === requestPath
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action)
  await operation()
  const response = await pending
  const result = await response.json()
  assert.ok(response.ok(), action + ': ' + JSON.stringify(result))
  return result
}

export async function openStructure(page) {
  const root = await showLoop(page)
  await tab(root, '预设结构').click()
  const editor = root.getByRole('tabpanel', { name: '预设结构', exact: true })
  await select(editor, '预设来源与副本').waitFor()
  return editor
}

export async function createVariant(page, editor) {
  await select(editor, '预设来源与副本').selectOption({ label: sourceName })
  await expect(row(editor, 'fixture-condition')).toContainText('条件启用')
  await expect(row(editor, 'fixture-beta')).toContainText('已停用')
  await button(editor, '创建可编辑副本').click()
  const dialog = page.getByRole('dialog', { name: '创建可编辑副本', exact: true })
  await dialog.getByLabel('预设名称', { exact: true }).fill(variantName)
  await dialog.getByLabel(/^说明/).fill(description)
  const created = await responseTo(page, 'createStructure', () => button(dialog, '创建副本').click())
  await expect(dialog).toBeHidden()
  return created
}

export async function editComposition(page, editor) {
  await button(editor, '添加分组').click()
  const add = page.getByRole('dialog', { name: '添加分组', exact: true })
  await add.getByLabel('分组名称', { exact: true }).fill('qa-branch')
  await button(add, '添加分组').click()
  await expect(row(editor, 'qa-branch')).toBeVisible()
  await row(editor, 'qa-branch').locator('.preset-row-select').click()
  await editor.getByLabel('分组名称', { exact: true }).fill('qa-renamed')
  await button(editor, '应用组件修改').click()
  await expect(row(editor, 'qa-renamed')).toBeVisible()

  await row(editor, 'fixture-beta').getByRole('checkbox').check()
  await row(editor, 'fixture-beta').locator('.preset-row-select').click()
  await button(editor, '移动到…').click()
  const move = page.getByRole('dialog', { name: '移动组件', exact: true })
  await select(move, '移动到').selectOption('qa-renamed')
  await button(move, '移动').click()
  await row(editor, 'fixture-alpha').locator('.preset-row-select').click()
  const config = editor.getByLabel(/^插件配置/)
  await config.fill('{broken')
  await button(editor, '应用组件修改').click()
  await expect(editor.getByText('插件配置需要有效的 JSON。', { exact: true })).toBeVisible()
  await expect(button(editor, '保存草稿')).toBeDisabled()
  await config.fill(JSON.stringify({ marker: 'EDITED_ALPHA', resource: './structure-source-resource.txt' }))
  await button(editor, '应用组件修改').click()

  await row(editor, 'qa-renamed').locator('.preset-row-select').click()
  await button(editor, '上移').click()
  const rowIds = () => editor.locator('li[data-preset-row]').evaluateAll(elements => elements.map(element => element.dataset.presetRow))
  const edited = ['fixture-group', 'fixture-alpha', 'qa-renamed', 'fixture-beta', 'fixture-condition']
  await expect.poll(rowIds).toEqual(edited)
  await button(editor, '撤销').click()
  await expect.poll(rowIds).toEqual(['fixture-group', 'fixture-alpha', 'fixture-condition', 'qa-renamed', 'fixture-beta'])
  await button(editor, '重做').click()
  await expect.poll(rowIds).toEqual(edited)
}

export async function saveDraft(page, editor) {
  return responseTo(page, 'saveStructure', () => button(editor, '保存草稿').click())
}

export async function publishDraft(page, editor) {
  await button(editor, '发布预设').click()
  const dialog = page.getByRole('dialog', { name: '发布预设', exact: true })
  await expect(dialog).toBeVisible()
  const published = await responseTo(page, 'publishStructure', () => button(dialog, '确认发布').click())
  await expect(dialog).toBeHidden()
  await expect(editor.getByText(/已加入 DSH 预设列表/)).toBeVisible()
  return published
}

const nodeButton = (editor, label) => editor.locator('.loop-plan-node-title').filter({ hasText: label })
const selectNode = (editor, label) => nodeButton(editor, label).click()
const planInspector = editor => editor.getByRole('complementary', { name: '编排节点详情' })
async function modelNode(editor, model, existing = false) {
  if (!existing) await button(editor, '添加模型步骤').click()
  const inspector = planInspector(editor)
  await inspector.getByLabel('节点名称', { exact: true }).fill(stageLabels[model])
  await inspector.getByLabel('步骤指令', { exact: true }).fill(instruction(model))
  await select(inspector, '提供方').selectOption(structureProvider)
  await select(inspector, '模型').selectOption(model)
  await inspector.getByLabel('输出 token 上限', { exact: true }).fill(String(caps[model]))
  return editor.locator('[data-plan-node][data-selected=true]').getAttribute('data-plan-node')
}

export async function editPlanA(editor) {
  await tab(editor, '执行编排').click()
  await button(editor, '启用连线编排').click()
  await modelNode(editor, 'draft', true)
  const review = await modelNode(editor, 'review')
  await expect(editor.getByRole('status', { name: '编排校验问题' })).toContainText('选择目标')
  const final = await modelNode(editor, 'final')
  const inspector = planInspector(editor)
  await select(inspector, '未调用工具').selectOption('end')
  await selectNode(editor, stageLabels.review)
  await select(inspector, '未调用工具').selectOption(final)
  await selectNode(editor, stageLabels.draft)
  await select(inspector, '未调用工具').selectOption(review)
  await selectNode(editor, '执行工具')
  await select(inspector, '工具完成后').selectOption(final)
  await select(inspector, '批次执行方式').selectOption('sequential')
  await expect(editor.getByRole('status', { name: '编排校验问题' })).toHaveCount(0)
}

async function fullscreen(page) {
  const expand = button(page, '全屏')
  if (await expand.isVisible()) await expand.click()
  await expect.poll(() => panel(page).evaluate(element => element.clientWidth)).toBeGreaterThan(1000)
}

export async function editPlanB(page, editor) {
  await fullscreen(page)
  await tab(editor, '执行编排').click()
  const alternate = await modelNode(editor, 'alternate')
  const final = await nodeButton(editor, stageLabels.final).locator('..').getAttribute('data-plan-node')
  const review = await nodeButton(editor, stageLabels.review).locator('..').getAttribute('data-plan-node')
  const inspector = planInspector(editor)
  await select(inspector, '未调用工具').selectOption(final)

  // Drag from the actual connector dot, then check the new target in the keyboard-accessible inspector.
  await editor.locator('.loop-plan-layout').evaluate(element => element.scrollIntoView({ block: 'start' }))
  const dot = button(editor, '连接 ' + stageLabels.draft + ' · 未调用工具').locator('.loop-plan-port-dot')
  const destination = button(editor, '连接到 ' + stageLabels.alternate)
  await expect(dot).toBeInViewport()
  await expect(destination).toBeInViewport()
  const from = await dot.boundingBox()
  const to = await destination.boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 14 })
  await page.mouse.up()
  await expect(select(inspector, '未调用工具')).toHaveValue(alternate)

  const output = button(editor, '连接 执行工具 · 工具完成后')
  await output.focus()
  await output.press('Enter')
  const target = button(editor, '连接到 ' + stageLabels.review)
  await target.focus()
  await target.press('Enter')
  await expect(select(inspector, '工具完成后')).toHaveValue(review)
  await expect(editor.getByRole('status', { name: '编排校验问题' })).toHaveCount(0)
}

export async function screenshotLayout(page, directory) {
  const layout = async name => {
    const root = panel(page)
    const metrics = await root.evaluate(element => {
      const areas = ['.preset-scroll', '.loop-plan-layout', '.loop-plan-canvas', '.loop-plan-details']
      return { width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth,
        viewportWidth: element.ownerDocument.defaultView.innerWidth, areas: areas.map(selector => {
          const area = element.querySelector(selector)
          return { selector, width: area.clientWidth, scrollWidth: area.scrollWidth }
        }) }
    })
    assert.ok(metrics.width > 280 && metrics.height > 250, JSON.stringify(metrics))
    assert.ok(metrics.scrollWidth <= metrics.width + 1, JSON.stringify(metrics))
    assert.ok(metrics.areas.every(area => area.width > 0 && area.scrollWidth <= area.width + 1), JSON.stringify(metrics))
    await root.locator('.preset-scroll').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: join(directory, name + '.png') })
    return metrics
  }
  await fullscreen(page)
  const wide = await layout('native-editor-wide')
  const root = panel(page)
  await selectNode(root, stageLabels.draft)
  await root.locator('.loop-plan-layout').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(directory, 'native-editor-wide-graph.png') })
  await page.setViewportSize({ width: 390, height: 860 })
  try {
    const narrow = await layout('native-editor-narrow')
    assert.ok(narrow.width <= 390)
    const graphTab = tab(root, '执行编排')
    await graphTab.click()
    await expect(graphTab).toBeFocused()
    await expect(root.locator('[data-plan-node="model"]')).toBeInViewport({ ratio: 0.8 })
    await page.screenshot({ path: join(directory, 'native-editor-narrow-graph.png') })
    return { wide, narrow }
  } finally {
    await page.setViewportSize({ width: 1440, height: 980 })
  }
}

export async function captureFailure(page, directory) {
  if (!page || page.isClosed()) return
  await save(directory, 'failure-dom.json', await page.locator('body').ariaSnapshot().catch(() => ''))
  await page.screenshot({ path: join(directory, 'failure.png'), timeout: 4000 }).catch(() => {})
}
