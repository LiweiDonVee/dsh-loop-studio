# 架构与插件接入

## 模块边界

| 文件 | 职责 |
| --- | --- |
| `src/core.mjs`、`src/routing.mjs`、`src/routing-journal.mjs` | 宿主观察图、路由校验、请求配置与模型归属恢复 |
| `src/structure-document.mjs`、`src/structures.mjs`、`src/store.mjs` | 原生预设读取与发布、结构校验、按 profile 保存草稿和发布 |
| `src/plan.mjs`、`src/plan-publication.mjs`、`src/plan-plugin.mjs` | 可执行图 schema、连线校验、发布版本标记 |
| `src/plan-runtime.mjs`、`src/host.mjs` | 原生 AgentLoop 与工具执行器适配、实际请求和轨迹 |
| `src/routes.mjs`、`src/api.js` | 经宿主 Connection 认证的会话操作与 SSE |
| `src/LoopWorkspace.jsx`、`src/PresetEditor.jsx`、`src/PresetPlanEditor.jsx` | 原生侧栏、组件树、连线、发布及执行查看 |

## 预设文档与发布

文档为 `{ name, description, rows, execution }`。`rows` 保留原生 Loader 行，包括 `id`、`name`、`group`、`config`、`disabled`、`inject`、`isolate`、`intercept` 与插件的附加字段。分组的 `config` 是有序子行，其他插件的 `config` 由插件解释。行 ID 在整棵树内唯一。Cordis `!!js` 条件以 `{ __jsExpr: '…' }` 表达，由宿主 Loader 在其上下文中解释。

通过 `agentPresets.readDocument` 读取声明，并用 Cordis YAML 规则解析。副本以精确匹配的来源声明或唯一的原生组成根作为模块解析基准。来源基准不明确时，编辑器提供只读视图。每个副本发布为 `loop-studio.<uuid>`，声明由 `agentPresets.register` 在来源的解析基准下挂载。

`structures.<profile哈希>.json` 记录各副本的草稿 revision 和最近一次成功发布。写入串行化，比较 revision，并通过临时文件重命名提交。`publishStructure` 先检查已保存草稿，再注册和解析原生定义。激活或提交失败时尝试恢复上次发布。Host 启动时从磁盘恢复已发布定义，卸载时释放注册。

选用通过 DSH 原生空白会话选择器完成。运行中的 Agent 由宿主保留实际装配的预设 generation。重启后重新装配会话时，使用该预设 ID 当前的发布版本。

## 可执行图

`execution.schemaVersion` 为 `1`。`mode: 'native'` 使用宿主调度，`nodes`、`edges` 为空，`entryNodeId` 为空字符串。`mode: 'graph'` 指定模型入口及以下节点与连线。

| 节点类型 | 字段与出口 |
| --- | --- |
| `model` | `id`、`label`、`instruction`、可选 `route`。`no-tools` 通向 `model` 或 `end`，可选 `tools` 通向 `tools`。 |
| `tools` | `id`、`label`、`execution`（`inherit` 或 `sequential`）。`next` 通向 `model`。 |
| `end` | `id`、`label`。到达后结束图调度。 |

连线为 `{ id, from, to, when }`。节点与连线 ID 在各自列表内唯一。每个节点均须从 `entryNodeId` 可达，且可到达结束节点。`maxModelSteps` 限制每回合模型步骤，默认 32，上限 256。图最多 256 个节点和 512 条连线。

发布时，图模式会加入包内 `dsh-loop-studio/execution` 入口提供的隔离 `loopStudioExecutionPlan` 服务。执行适配通过 `agentPresets.serviceFor(agent, ...)` 读取当前 Agent 持有的不可变发布标记。`inspect` 返回该会话的执行图、`executionPublication`、实际请求元数据及诊断。

调度使用原生 AgentLoop 边界。首次模型选择在原生请求捕获前准备，工具批次完成后确定下一节点，文本转移通过 `agent/turn-stopping` 安排后续步骤。步骤指令通过原生 `agent/pre-step` 记录为 Loop Studio 的阶段消息。`session/event` 回调只观察已发布的事件。

节点的 `route` 可指定 `provider`、`model`、`reasoningEffort`、`maxTokens`。图模式由发布的节点路由选择模型，空路由继承用户在宿主中的选择。`host.first`、`host.continuation` 用于宿主调度模式。路由 journal 记录控件的归属并在合适边界恢复宿主选择。

执行适配在 Agent 作用域装饰 DSH 的 NativeToolExecutor 或 PtcExecutor，调用仍由原执行器审批、运行和结算。缺少 `tools` 出口的模型步骤提供空工具列表，意外的工具调用通过宿主拒绝和结算。`sequential` 将外层工具批次的并行度设为 1，PTC 程序内部由 PTC 调度。完成、限额或宿主终止后，适配拦下本轮的额外请求，将已领取的外部输入放回宿主队列。

## 给自己的插件接入阶段

插件通过可选 `loopStudio` 服务注册独立模型阶段，实际模型调用由接入方执行。宿主调度模式的首步和续步路由也使用同样的路由字段。

```js
const studio = ctx.get('loopStudio')
const unregister = studio?.registerParticipant({
  id: 'example',
  nodes: [{ id: 'review', label: '复核', kind: 'model', control: 'route' }],
  edges: [{ id: 'finish', from: 'review', to: 'host.end' }],
})

const route = studio?.resolveRoute({ sessionId, nodeId: 'example.review' })
const selected = route ?? originalModelConfig
const startedAt = Date.now()
// 使用 selected 执行实际的模型调用。
studio?.recordTrace({
  sessionId, nodeId: 'example.review',
  provider: selected.provider, model: selected.model,
  status: 'completed', durationMs: Date.now() - startedAt,
})

// 插件卸载时调用 unregister，失败和取消也应报告相应状态。
```

- 参与方 ID 使用小写字母、数字和连字符，`host` 由宿主占用。节点 ID 自动加参与方前缀。
- 节点 kind 为 `model`、`tool` 或 `program`，路由控制只适用于 `model`。连线可引用本参与方节点和已有的 `host.*` 节点。
- `resolveRoute` 在接入方装配时返回冻结的有效配置或 `null`。`recordTrace` 接收模型、状态和用量等元数据。插件应按可选服务的生命周期注册并释放。

## 浏览器接口

原生 UI 调用 `POST /api/loop-studio/request`。每次操作携带 `action` 和 `sessionId`，由宿主验证会话所有者权限。原有 `inspect`、`savePolicy`、`resetPolicy` 提供执行读取和路由策略操作。

| 结构操作 | 其他请求字段 | 返回 |
| --- | --- | --- |
| `listStructures` | 无 | 来源、草稿列表和空白会话选择能力 |
| `readStructure` | `sourcePresetId` 或 `draftId` | 来源声明或草稿及组件目录。草稿包含 `baseDocument` 与发布元数据。 |
| `createStructure` | `sourcePresetId`、`name`、可选 `description` | 初始草稿 |
| `validateStructure` | `draftId`、`expectedRevision`、`document` | 文档校验的 `valid` 与问题位置 |
| `saveStructure` | `draftId`、`expectedRevision`、`document` | 保存后的草稿及 revision |
| `publishStructure` | `draftId`、`expectedRevision` | 原生激活与持久提交成功后的 `draft`、`presetId`、`version`、`activation: 'ready'` |
| `selectStructure` | `draftId`、`expectedRevision` | 通过 DSH 选择后的 `presetId` 与 `selected: true` |

版本冲突返回 `409 revision-conflict`，已开始会话的选用请求返回 `409 preset-locked`。结构无效、原生激活失败和驱动能力不足分别对应 `422 invalid-structure`、`422 activation-failed` 和 `422 unsupported-driver`。`GET /api/loop-studio/events?sessionId=…` 提供失效通知，客户端据此重新读取快照。问题详情、响应字段和 trace 白名单以当前实现为准。 [路由实现](../src/routes.mjs) · [客户端 API](../src/api.js)
