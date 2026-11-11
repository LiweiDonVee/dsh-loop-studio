import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { prepareStructureRuntime, redact, save, sourcePreset, structureProvider } from './native-structure-runtime.mjs'
import {
  caps, captureFailure, createVariant, description, editComposition, editPlanA, editPlanB, instruction, openBlankSession,
  openNativePage, openStructure, publishDraft, saveDraft, screenshotLayout, selectNativePreset, sendPrompt, showLoop, variantName,
} from './native-structure-ui.mjs'

const path = '/api/loop-studio/request'
const [archive, output] = process.argv.slice(2)
const run = await prepareStructureRuntime(archive, output)
const { directory, identity } = run
const report = { status: 'RUNNING', identity, cases: [], clientResources: [], pageErrors: [], consoleErrors: [],
  blockedBrowserRequests: [], externalModelCalls: 0, modelBoundary: 'One deterministic local DSH adapter and two synthetic tools.' }
const route = (model, maxTokens) => ({ provider: structureProvider, model, maxTokens })
const sourceMarkers = ['SOURCE_ALPHA', 'SOURCE_CONDITION']
const editedMarkers = ['EDITED_ALPHA', 'SOURCE_BETA', 'SOURCE_CONDITION']
const sourcePrompt = 'SOURCE_FIXTURE ORIGINAL'
const standardPrompt = 'ROUTING_FIXTURE STD_INITIAL'
const aPrompt = 'WORKFLOW_A_BROWSER'
const bPrompt = 'WORKFLOW_B_BROWSER'
const toolA = 'structure_fixture_a'
const toolB = 'structure_fixture_b'
let host, browser, activePage
const api = (action, sessionId, args = {}, options) => host.request(path, { action, sessionId, ...args }, options)
const inspect = sessionId => api('inspect', sessionId)
const draftOf = (sessionId, draftId) => api('readStructure', sessionId, { draftId })
const modelCalls = result => result.calls.filter(call => call.kind === 'model')
const signature = result => result.calls.map(call => call.kind === 'model' ? call.model : call.name)
const latestTurn = result => result.snapshot.events.slice(result.snapshot.events.findLastIndex(event => event.type === 'turn/start'))
const canonicalHeader = header => ({ ...header, delegationDepth: header.delegationDepth ?? 0 })
const documentOf = draft => ({ name: draft.name, description: draft.description, rows: draft.rows, execution: draft.execution })
const argsFor = draft => ({ draftId: draft.draftId, expectedRevision: draft.revision })
const runTurn = (sessionId, prompt) => host.probe('run', { sessionId, prompt })
const selectActive = async (page, publication) => {
  const blank = await openBlankSession(page, { newSession: true })
  assert.equal((await inspect(blank.sessionId)).selectedPresetId, 'standard')
  await selectNativePreset(page, blank.root)
  await expect.poll(async () => (await inspect(blank.sessionId)).selectedPresetId).toEqual(publication.presetId)
  return blank.sessionId
}

async function check(name, operation) {
  const receipt = { name, status: 'RUNNING' }
  report.cases.push(receipt)
  try {
    receipt.result = await operation()
    receipt.status = 'PASS'
    console.log('PASS ' + name)
    return receipt.result
  } catch (error) {
    receipt.status = 'FAIL'
    receipt.error = redact(error.stack)
    throw error
  } finally {
    await save(directory, 'acceptance.json', report)
  }
}

function assertNativeTurn(result, modelCount, end = 'completed') {
  const events = latestTurn(result)
  assert.ok(events.length, 'No native turn was recorded')
  assert.equal(events.filter(event => event.type === 'step/start').length, modelCount)
  assert.equal(events.filter(event => event.type === 'step/end').length, modelCount)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(events.find(event => event.type === 'turn/end').data.reason.kind, end)
  return events
}

function assertTool(result, expected = toolA) {
  assert.deepEqual(result.executed, [expected])
  const observed = result.calls.filter(call => call.kind === 'tool')
  assert.deepEqual(observed.map(call => [call.name, call.isError]), [[expected, false]])
  const events = latestTurn(result)
  const sent = events.filter(event => event.type === 'tool/call')
  const received = events.filter(event => event.type === 'tool/result')
  assert.equal(sent.length, 1)
  assert.equal(received.length, 1)
  assert.equal(sent[0].data.name, expected)
  assert.equal(received[0].data.message.toolCallId, sent[0].data.callId)
  assert.equal(received[0].data.message.isError, false)
}

async function assertGraph(result, sessionId, publication, order, { withTool = false } = {}) {
  const models = modelCalls(result)
  assert.deepEqual(models.map(call => call.model), order)
  assert.deepEqual(result.errors, [])
  assert.equal(result.snapshot.projections.values.agentPreset, publication.presetId)
  const events = assertNativeTurn(result, order.length)
  const headers = events.filter(event => event.type === 'request/header').map(event => event.data.header.config)
  assert.deepEqual(headers.filter(header => order.includes(header.model)).map(header => [header.model, header.maxTokens]),
    order.map(model => [model, caps[model]]))
  for (const call of models) {
    assert.equal(call.provider, structureProvider)
    assert.equal(call.maxTokens, caps[call.model])
    assert.deepEqual(call.requestConfig, route(call.model, caps[call.model]))
    assert.equal(call.instructions.at(-1), instruction(call.model))
    assert.deepEqual([...call.markers].sort(), [...editedMarkers].sort())
    if (call.model === 'draft') assert.ok(call.tools.includes(toolA))
    else assert.deepEqual(call.tools, [])
  }
  const loggedInstructions = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'loop-studio-execution')
  assert.deepEqual(loggedInstructions.map(event => event.data.content[0].text.match(/WORKFLOW_INSTRUCTION_[A-Z_]+/)?.[0]), order.map(instruction))
  assert.ok(loggedInstructions.every(event => event.data.source.version === publication.version))
  assert.deepEqual(signature(result), withTool ? [order[0], toolA, ...order.slice(1)] : order)
  if (withTool) assertTool(result)
  else assert.deepEqual(result.executed, [])
  const detail = await inspect(sessionId)
  assert.equal(detail.executionPublication.presetId, publication.presetId)
  assert.equal(detail.executionPublication.version, publication.version)
  assert.equal(detail.executionPublication.mode, 'graph')
  const turn = events[0].data.turn
  const requests = detail.trace.filter(item => item.turn === turn && item.type === 'request')
  assert.deepEqual(requests.map(item => item.model), order)
  for (const item of requests) {
    assert.equal(item.graphId, detail.graph.id)
    assert.equal(detail.graph.nodes.find(node => node.id === item.nodeId)?.configuredRoute.model, item.model)
  }
  return { requests, result }
}

async function assertFailure(action, sessionId, args, status, code) {
  const response = await api(action, sessionId, args, { allowError: true })
  assert.equal(response.status, status, JSON.stringify(response.body))
  assert.equal(response.body.error.code, code)
  return response
}

try {
  assert.ok(identity.members['dist/execution.js'], 'The exact archive must include the published execution module.')
  host = await run.start('warm')
  const initialPid = host.ready.pid
  assert.deepEqual(host.ready.providers, [structureProvider])
  assert.equal(host.ready.defaultPresetId, 'standard')
  await host.probe('workspace')
  const original = await host.probe('document', { preset: sourcePreset })
  const standard = await host.probe('document', { preset: 'standard' })
  const source = await host.probe('create', { preset: sourcePreset })
  const originalRun = await check('native-source-include-and-relative-assets', async () => {
    const result = await runTurn(source.sessionId, sourcePrompt)
    assert.deepEqual(signature(result), ['configured'])
    assert.deepEqual(modelCalls(result)[0].markers, sourceMarkers)
    assert.match(original.content, /disabled: !!js/)
    assert.match(original.content, /structureFixtureScope: true/)
    return result
  })

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const editorPage = await openNativePage(browser, host, report, identity)
  activePage = editorPage
  const editorSession = (await openBlankSession(editorPage)).sessionId
  const routing = await check('stock-standard-native-routing', async () => {
    const initial = await inspect(editorSession)
    assert.equal(initial.selectedPresetId, 'standard')
    assert.equal(initial.routingCapability, 'supported')
    const policy = { enabled: true, routes: { 'host.first': route('routed-first', 222), 'host.continuation': route('routed-continuation', 333) } }
    await api('savePolicy', editorSession, { scope: 'session', expectedRevision: initial.revision, policy })
    const result = await runTurn(editorSession, standardPrompt)
    await save(directory, 'standard-routing.json', result)
    assert.deepEqual(signature(result), ['routed-first', toolA, 'routed-continuation'], JSON.stringify(result.errors))
    assert.deepEqual(modelCalls(result).map(call => call.maxTokens), [222, 333])
    assertTool(result)
    return { policy, result }
  })

  await check('connection-and-session-authorization', async () => {
    const create = { sourcePresetId: sourcePreset, name: 'Forbidden fixture' }
    const noCookie = await api('createStructure', editorSession, create, { authenticated: false, allowError: true })
    const foreign = await api('createStructure', editorSession, create, { allowError: true, headers: { origin: 'https://fixture.invalid' } })
    assert.equal(noCookie.status, 401)
    assert.equal(foreign.status, 403)
    await assertFailure('createStructure', 'session-missing-structure-fixture', create, 404, 'not-found')
    assert.deepEqual((await api('listStructures', editorSession)).drafts, [])
    return { unauthenticatedStatus: noCookie.status, foreignOriginStatus: foreign.status }
  })

  // The native web welcome screen records its acknowledgement in the isolated profile.
  const configuration = await run.configurationHashes()
  let editor = await openStructure(editorPage)
  const created = await check('native-slot-copy-edit-save-and-readback', async () => {
    const draft = await createVariant(editorPage, editor)
    await editComposition(editorPage, editor)
    const saved = await saveDraft(editorPage, editor)
    assert.equal(saved.draftId, draft.draftId)
    assert.equal(saved.revision, draft.revision + 1)
    assert.equal(saved.name, variantName)
    assert.equal(saved.description, description)
    assert.deepEqual(saved.rows.map(row => row.id), ['fixture-group', 'qa-renamed', 'fixture-condition'])
    assert.deepEqual(saved.rows[0].isolate, { structureFixtureScope: true })
    assert.equal(saved.rows[0].config[0].config.marker, 'EDITED_ALPHA')
    assert.equal(saved.rows[1].name, 'cordis:group')
    assert.equal(saved.rows[1].config[0].id, 'fixture-beta')
    assert.notEqual(saved.rows[1].config[0].disabled, true)
    assert.deepEqual(saved.rows[2].disabled, { __jsExpr: 'false' })
    assert.deepEqual(documentOf(await draftOf(editorSession, saved.draftId)), documentOf(saved))
    return saved
  })

  await check('composition-only-publication-runs-the-native-loop', async () => {
    const published = await publishDraft(editorPage, editor)
    assert.equal(published.activation, 'ready')
    assert.equal(published.draft.execution.mode, 'native')
    const native = await host.probe('document', { preset: published.presetId })
    assert.doesNotMatch(native.content, /loop-studio-execution/)
    const { sessionId } = await host.probe('create', { preset: published.presetId })
    const result = await runTurn(sessionId, 'SOURCE_FIXTURE EDITED_NATIVE')
    assert.deepEqual(signature(result), ['configured'])
    assert.deepEqual([...modelCalls(result)[0].markers].sort(), [...editedMarkers].sort())
    assertNativeTurn(result, 1)
    assert.equal((await inspect(sessionId)).executionPublication, undefined)
    return { presetId: published.presetId, version: published.version, result }
  })

  const publicationA = await check('browser-publishes-first-actual-native-graph', async () => {
    await editPlanA(editor)
    const saved = await saveDraft(editorPage, editor)
    const published = await publishDraft(editorPage, editor)
    assert.equal(published.activation, 'ready')
    assert.equal(published.draft.draftId, created.draftId)
    assert.deepEqual(published.draft.execution, saved.execution)
    const roster = await host.probe('ready')
    assert.equal(roster.defaultPresetId, 'standard')
    assert.equal(roster.presets.find(preset => preset.id === published.presetId).broken, undefined)
    assert.equal((await inspect(editorSession)).selectedPresetId, 'standard')
    await assertFailure('selectStructure', editorSession, argsFor(published.draft), 409, 'preset-locked')
    return published
  })

  const usagePage = await openNativePage(browser, host, report, identity)
  activePage = usagePage
  const sessionA = await selectActive(usagePage, publicationA)
  assert.notEqual(sessionA, editorSession)
  await check('normal-native-picker-and-two-real-graph-branches', async () => {
    await sendPrompt(usagePage, aPrompt)
    const ordinary = await assertGraph(await host.probe('idle', { sessionId: sessionA }), sessionA, publicationA, ['draft', 'review', 'final'])
    const withTool = await assertGraph(await runTurn(sessionA, 'WORKFLOW_WITH_TOOL_A'), sessionA, publicationA, ['draft', 'final'], { withTool: true })
    return { sessionId: sessionA, ordinary, withTool }
  })

  await check('a-no-tools-stage-denies-an-agent-owned-tool', async () => {
    const { sessionId } = await host.probe('create', { preset: publicationA.presetId })
    assert.deepEqual(await host.probe('armScopedTool', { sessionId }), { registered: true, global: false })
    const result = await runTurn(sessionId, 'WORKFLOW_DENIED_TOOL')
    assert.deepEqual(modelCalls(result).map(call => call.model), ['draft', 'review'])
    assert.deepEqual(modelCalls(result)[1].tools, [])
    assert.deepEqual(result.executed, [])
    const events = assertNativeTurn(result, 2, 'error')
    const attempted = events.find(event => event.type === 'tool/call')
    const denied = events.find(event => event.type === 'tool/result')
    assert.equal(attempted.data.name, toolB)
    assert.equal(denied.data.message.toolCallId, attempted.data.callId)
    assert.equal(denied.data.message.isError, true)
    assert.ok(result.errors.some(error => error.code === 'unexpected-tool-calls'))
    return result
  })

  activePage = editorPage
  const publicationB = await check('pointer-and-keyboard-rewire-and-republish-native-graph', async () => {
    await editPlanB(editorPage, editor)
    const saved = await saveDraft(editorPage, editor)
    const oldEdge = publicationA.draft.execution.edges.find(edge => edge.from === 'model' && edge.when === 'no-tools')
    const newEdge = saved.execution.edges.find(edge => edge.from === 'model' && edge.when === 'no-tools')
    assert.equal(newEdge.id, oldEdge.id)
    assert.notEqual(newEdge.to, oldEdge.to)
    assert.equal(saved.execution.nodes.find(node => node.id === newEdge.to).route.model, 'alternate')
    const published = await publishDraft(editorPage, editor)
    assert.equal(published.presetId, publicationA.presetId)
    assert.equal(published.version, publicationA.version + 1)
    report.layout = await screenshotLayout(editorPage, directory)
    return published
  })

  const freshPage = await openNativePage(browser, host, report, identity)
  activePage = freshPage
  const sessionB = await selectActive(freshPage, publicationB)
  assert.notEqual(sessionB, sessionA)
  const liveVersions = await check('existing-live-session-keeps-version-and-fresh-session-uses-rewired-version', async () => {
    await sendPrompt(freshPage, bPrompt)
    const [old, fresh] = await Promise.all([
      runTurn(sessionA, 'WORKFLOW_A_RETAINED'),
      host.probe('idle', { sessionId: sessionB }),
    ])
    const retained = await assertGraph(old, sessionA, publicationA, ['draft', 'review', 'final'])
    const rewired = await assertGraph(fresh, sessionB, publicationB, ['draft', 'alternate', 'final'])
    const rewiredTool = await assertGraph(await runTurn(sessionB, 'WORKFLOW_WITH_TOOL_B'), sessionB, publicationB, ['draft', 'review', 'final'], { withTool: true })
    assert.equal((await inspect(sessionA)).executionPublication.latestVersion, publicationB.version)
    const oldLoop = await showLoop(usagePage)
    await expect(oldLoop.getByText('当前会话 · 编排 v' + publicationA.version, { exact: true })).toBeVisible()
    await expect(oldLoop.getByText('最新发布 v' + publicationB.version, { exact: true })).toBeVisible()
    return { retained, rewired, rewiredTool }
  })
  const warmA = liveVersions.retained.result.snapshot

  await check('stale-draft-invalid-edges-and-native-activation-rollback', async () => {
    const previous = publicationB.draft
    await assertFailure('saveStructure', editorSession, { ...argsFor(previous), expectedRevision: previous.revision - 1,
      document: documentOf(previous) }, 409, 'revision-conflict')
    const invalid = documentOf(structuredClone(previous))
    invalid.execution.edges[0].to = 'missing-fixture-node'
    await assertFailure('saveStructure', editorSession, { ...argsFor(previous), document: invalid }, 422, 'invalid-structure')
    assert.equal((await draftOf(editorSession, previous.draftId)).revision, previous.revision)
    const nativeFailure = documentOf(structuredClone(previous))
    nativeFailure.rows.push({ id: 'missing-fixture-module', name: './structure-module-does-not-exist.mjs' })
    const dirty = await api('saveStructure', editorSession, { ...argsFor(previous), document: nativeFailure })
    await assertFailure('publishStructure', editorSession, argsFor(dirty), 422, 'activation-failed')
    const roster = await host.probe('ready')
    assert.equal(roster.presets.find(preset => preset.id === publicationB.presetId).broken, undefined)
    assert.deepEqual((await draftOf(editorSession, dirty.draftId)).published, previous.published)
    const { sessionId } = await host.probe('create', { preset: publicationB.presetId })
    await assertGraph(await runTurn(sessionId, 'WORKFLOW_ROLLBACK'), sessionId, publicationB, ['draft', 'alternate', 'final'])
    const repaired = await api('saveStructure', editorSession, { ...argsFor(dirty), document: documentOf(previous) })
    assert.deepEqual(repaired.published, previous.published)
    assert.equal(repaired.hasUnpublishedChanges, false)
    return { draftId: repaired.draftId, revision: repaired.revision, activeVersion: publicationB.version }
  })

  await check('original-source-and-stock-policy-remain-usable', async () => {
    assert.deepEqual(await host.probe('document', { preset: sourcePreset }), original)
    assert.deepEqual(await host.probe('document', { preset: 'standard' }), standard)
    assert.deepEqual(await run.configurationHashes(), configuration)
    assert.deepEqual(modelCalls(await runTurn(source.sessionId, 'SOURCE_FIXTURE UNCHANGED')).map(call => call.markers), [sourceMarkers])
    assert.deepEqual((await inspect(editorSession)).policies.session, routing.policy)
    const result = await runTurn(editorSession, 'ROUTING_FIXTURE STD_AFTER_GRAPH')
    assert.deepEqual(signature(result), ['routed-first', toolA, 'routed-continuation'])
    assertTool(result)
    return { original: originalRun.snapshot.header.agentPreset, verifiedConfigurationFiles: configuration, result }
  })

  await Promise.all([editorPage.close(), usagePage.close(), freshPage.close()])
  activePage = undefined
  assert.deepEqual(await host.close(), { exitCode: 0, signal: null })
  host = await run.start('cold')
  assert.notEqual(host.ready.pid, initialPid)
  assert.deepEqual(host.ready.providers, [structureProvider])
  assert.equal(host.ready.defaultPresetId, 'standard')
  await check('cold-library-and-original-session-reopen-with-latest-publication', async () => {
    const sourceReadback = await host.probe('document', { preset: sourcePreset })
    assert.deepEqual(sourceReadback, original)
    const draft = await draftOf(editorSession, created.draftId)
    assert.deepEqual(draft.published, publicationB.draft.published)
    assert.deepEqual(documentOf(draft), documentOf(publicationB.draft))
    const coldA = await host.probe('snapshot', { sessionId: sessionA })
    assert.deepEqual(canonicalHeader(coldA.header), canonicalHeader(warmA.header))
    assert.deepEqual(coldA.events.slice(0, warmA.events.length), warmA.events)
    assert.equal(coldA.projections.values.agentPreset, publicationB.presetId)
    const page = await openNativePage(browser, host, report, identity)
    activePage = page
    await page.getByRole('treeitem', { name: /^WORKFLOW_A_BROWSER/ }).click()
    await expect(page.getByText(aPrompt, { exact: true }).first()).toBeVisible()
    const root = await showLoop(page)
    assert.equal(await root.getAttribute('data-loop-session'), sessionA)
    await expect.poll(async () => (await inspect(sessionA)).executionPublication?.version).toEqual(publicationB.version)
    await sendPrompt(page, 'WORKFLOW_COLD_B')
    const result = await host.probe('idle', { sessionId: sessionA })
    await assertGraph(result, sessionA, publicationB, ['draft', 'alternate', 'final'])
    assert.deepEqual(result.snapshot.events.slice(0, warmA.events.length), warmA.events)
    assert.deepEqual(await run.configurationHashes(), configuration)
    const coldFreshPage = await openNativePage(browser, host, report, identity)
    const fresh = await selectActive(coldFreshPage, publicationB)
    await assertGraph(await runTurn(fresh, 'WORKFLOW_COLD_PICKER'), fresh, publicationB, ['draft', 'alternate', 'final'])
    assert.deepEqual((await inspect(editorSession)).policies.session, routing.policy)
    return { processIds: [initialPid, host.ready.pid], sessionId: sessionA, selectedThroughNativePicker: fresh,
      durableEventPrefixLength: warmA.events.length, draft, result }
  })
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.consoleErrors, [])
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'
  report.error = redact(error.stack)
  await captureFailure(activePage, directory)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (host) report.finalExit = await host.close()
  if (report.status === 'PASS' && report.finalExit.exitCode !== 0) {
    report.status = 'FAIL'
    report.error = 'The isolated cold Host did not shut down normally.'
    process.exitCode = 1
  }
  await save(directory, 'acceptance.json', report)
  console.log('LOOP_STRUCTURE_NATIVE_' + report.status + ' ' + directory)
}
