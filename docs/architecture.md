# 架构与插件接入

## 模块边界

| 文件 | 职责 |
| --- | --- |
| `src/core.mjs` | 版本化图、参与节点合并、策略校验和元数据投影 |
| `src/store.mjs` | 带 revision 的会话/预设策略持久化 |
| `src/host.mjs` | DSH 适配、装配与请求边界、可选参与服务 |
| `src/routes.mjs` | 经宿主 Connection 认证的精确 API 与 SSE |
| `src/LoopWorkspace.jsx`、`client.jsx` | 原生侧栏、执行图、模型控件和生命周期 |

宿主图的 `schemaVersion` 为 1。节点 ID、策略、轨迹和执行适配分离；图本身不调度工作。支持的内置驱动在提示词装配时捕获路由，再将同一选择用于匹配的实际请求，避免提示词中的模型信息和调用目标不一致。未知驱动保持观察。

策略只保存路由字段：

```json
{
  "enabled": true,
  "routes": {
    "host.first": {"provider": "configured-provider", "model": "configured-model"},
    "host.continuation": {"provider": "local-provider", "model": "local-model", "maxTokens": 4096}
  }
}
```

示例名称需要换成宿主中真实注册的提供方和模型。持久化文件是 `app-data/loop-studio/policies.json`，写入要求当前 revision；不回写预设文件。

## 给自己的插件接入阶段

通过可选 `loopStudio` 服务注册。插件仍拥有实际执行与原来的模型配置；没有安装 Loop Studio 时照常工作。

```js
const studio = ctx.get('loopStudio')
const unregister = studio?.registerParticipant({
  id: 'example',
  nodes: [{id: 'review', label: '复核', kind: 'model', control: 'route'}],
  edges: [{id: 'finish', from: 'review', to: 'host.end'}],
})

// 在自己真实的调用边界解析一次，并将结果用于该调用。
const route = studio?.resolveRoute({sessionId, nodeId: 'example.review'})
const selected = route ?? originalModelConfig
const startedAt = Date.now()
// 用 selected.provider / selected.model 等调用自己的模型执行代码。
// 完成后只报告元数据：
studio?.recordTrace({
  sessionId, nodeId: 'example.review',
  provider: selected.provider, model: selected.model,
  status: 'completed', durationMs: Date.now() - startedAt,
})

// 在插件卸载时调用 unregister；失败和取消也应报告对应状态。
```

`originalModelConfig` 与实际模型执行代码由接入方提供。需要处理动态服务安装/卸载的插件应通过宿主的可选注入生命周期注册和释放，而不是假设服务永远存在。

- 参与方 ID 使用小写字母、数字和连字符，不能占用 `host`。
- 节点 ID 自动加入参与方前缀；示例的最终 ID 为 `example.review`。
- 节点 kind 为 `model`、`tool` 或 `program`；只有模型节点能声明 `control: 'route'`。
- 连线可引用本参与方节点或已存在的 `host.*` 节点；不允许替换宿主节点。
- `resolveRoute` 返回冻结的有效配置或 `null`。执行方必须真正消费它；仅注册图不会改动模型调用。
- `recordTrace` 只接收已报告的模型/状态/用量等元数据；不要传入提示词、推理、工具参数或结果正文。

## 浏览器接口

原生 UI 使用 `POST api/loop-studio/request` 的 `inspect`、`savePolicy`、`resetPolicy` 三个动作，以及 `GET api/loop-studio/events?sessionId=...` 的更新通知。会话读取使用宿主 owner Remote 权限，路由不提供任意 URL 或任意 RPC 代理。

SSE 是失效通知，客户端重新读取快照；关闭页签、取消连接和卸载都释放订阅。实际轨迹由白名单投影生成，不复制模型或工具正文。API 属于 0.1 插件接口，接入前应对照 `src/routes.mjs` 和测试核对 DTO。
