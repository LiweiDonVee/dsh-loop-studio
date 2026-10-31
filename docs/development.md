# 开发、构建与验收

## 独立工作区

此仓库不引用 RP Studio 工作区包。开发使用 Node 24、pnpm 11.9，克隆后执行：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

`pnpm check` 运行零 warning lint、宿主/内核测试、React 组件测试和生产构建。`pnpm package` 构建 host ESM 与浏览器 ModuleLoader 入口，再生成 tgz 和 SHA256 校验文件。React 由 DSH 提供；发布包移除开发依赖，不要求安装源码工作区。

| 命令 | 用途 |
| --- | --- |
| `pnpm test:host` | Node 原生测试，覆盖策略、适配、权限与生命周期 |
| `pnpm test:ui` | Vitest/jsdom 组件与 API 测试 |
| `pnpm lint` | oxlint，warning 视为失败 |
| `pnpm build` | 构建原生 host/client |
| `pnpm package` | 生成 `artifacts/` 安装包与校验文件 |
| `pnpm smoke` | 使用已安装的官方 DSH 做隔离原生验收 |

CI 在 Ubuntu 与 Windows 上运行依赖冻结安装、check 和打包，安装包作为 CI artifact 留存。CI 不自动请求真实模型，也不在没有 DSH 安装时声称完成原生 smoke。

## 原生验收

先构建安装包，准备官方 DSH（本轮使用 0.2.1-rc.5）和 Playwright Chromium：

```powershell
pnpm exec playwright install chromium
pnpm package
pnpm smoke
```

默认从 Windows 的官方安装目录找 `dsh.cmd`。自定义位置或其他平台可设置 `DSH_BIN`。已有 Chromium 可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，不必重复下载。

脚本创建 `.runtime/loop-smoke-*` 下的新 DSH home，安装刚生成的包，并注册合成提供方。标准/自定义预设、显式/隐式模型、首步与续步不同路由、关闭恢复、实际 UI 选模型保存、装配后卸载边界、全屏与窄窗口都会检查。模型适配器是本地确定性 fixture，不发送付费请求或读取用户卡库。

脚本从本仓库 `package.json` 选择对应版本的 `artifacts/` 安装包，并读取实际 CLI 版本。结果和截图在 `.runtime/loop-evidence/`；`acceptance.json` 含受测包 SHA256 和实际宿主版本。支持范围与已验证结果见 [验收记录](acceptance.md)。

0.1.1 的组件回归还检查 Studio 注册/卸载时 header 与 hero 入口同时隐藏/恢复，以及订阅释放。与 RP Studio 1.5.0 联用的聚合菜单、390px 布局和 14px/20px 字体矩阵使用七包隔离原生验收，独立记录受测包与截图；不要用旧版原生记录代替新包证据。

## 维护边界

修改宿主适配时同时检查装配快照、真正 stream 开始、显式模型切换和卸载收尾。不要在 Session 事件发布回调中同步追加 Session 事件；不要把已准备的 header 当成实际模型请求。

公共 API 修改应同步更新 [架构文档](architecture.md)、现有调用方和对应测试。拓扑编辑需要单独设计执行语义，不能让图控件绕过宿主调度。

发布时更新版本和 `CHANGELOG.md`，使用干净 checkout 运行 check/package/smoke，再将 tgz 与 `SHA256SUMS.txt` 上传到对应 GitHub Release。不要提交 `.runtime`、`artifacts`、node_modules、用户会话或凭据。
