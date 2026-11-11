# 开发、构建与验收

## 构建

在仓库根使用 Node.js 24、pnpm 11.9。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

`pnpm check` 执行 lint、宿主与内核测试、React 组件测试和构建。`pnpm package` 生成 `artifacts/dsh-loop-studio-0.2.0.tgz` 和 `artifacts/SHA256SUMS.txt`。包中包含 Host ESM、原生浏览器 ModuleLoader 入口和预设执行标记模块。React 由 DSH 提供。

| 命令 | 用途 |
| --- | --- |
| `pnpm test:host` | Node 测试，覆盖策略、结构校验、发布回退、权限与生命周期 |
| `pnpm test:ui` | Vitest/jsdom 组件与 API 测试 |
| `pnpm lint` | oxlint，warning 视为失败 |
| `pnpm build` | 构建三个入口 |
| `pnpm test:native-routing` | 以指定 DSH runtime 检查原生模型路由与冷重开 |
| `pnpm smoke` | 与 `pnpm test:native-routing` 相同 |
| `pnpm smoke:legacy-rc2` | 0.1 系列的历史 rc.2 复现入口 |

CI 在 Ubuntu 和 Windows 上冻结安装依赖、运行 `check` 并留存安装包。原生验收需要下面的精确宿主，按受测包记录结果。 [GitHub Actions](https://github.com/LiweiDonVee/dsh-loop-studio/actions)

## 原生安装与编排验收

使用 **DSH 0.2.2-rc.1** 的 runtime 目录，其中包含 `node_modules/@deepseek-ai/dsh`。在仓库根执行以下命令，将路径换成自己的 runtime。

```powershell
$env:DSH_RUNTIME_DIR = 'C:/path/to/dsh-runtime'
pnpm exec playwright install chromium
pnpm package
node scripts/native-structure.mjs artifacts/dsh-loop-studio-0.2.0.tgz .runtime/native-structure
```

使用已有 Chromium 时可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。`DSH_NATIVE_NODE` 可指定运行宿主 CLI 的 Node 可执行文件，默认使用当前 Node。

脚本为每次验收创建独立的 `native-*` 目录、DSH home 与 profile，通过宿主管理命令安装指定 tgz。检查已安装入口、普通预设选择器、组件和相对资源解析、连线改动、真实模型步骤与工具结算，以及重启后的发布。模型使用本地确定性 fixture，DSH 负责请求、工具调度与 Session 持久化。

以输出目录的 `acceptance.json`、安装包哈希、宿主版本、进程记录和截图核对实际结果。独立 Web profile 的浏览器验收覆盖原生 DSH Client。Electron Desktop 客户端的验证应记录自己的 profile、版本和操作结果。

## 原有模型路由回归

同样设置 `DSH_RUNTIME_DIR`，构建后运行以下命令。

```powershell
pnpm build
$env:DSH_LOOP_EVIDENCE_ROOT = (Join-Path $PWD '.runtime/native-routing')
pnpm test:native-routing
```

这个入口使用 DSH 的 AgentLoop、SessionStore、JSONL 持久层与本地确定性模型，检查路由、重试、取消、卸载和模型默认输出上限的整进程冷恢复。默认读取 `dist/host.js`，也可通过 `DSH_LOOP_PRODUCT` 指向已解包的 Host 入口。原生安装和 Client 操作使用上一节的入口。

旧版证据与其安装包、宿主版本绑定。 [0.1.0 验收记录](acceptance.md) · [0.1.1 验收记录](acceptance-0.1.1.md)

## 维护与发布

修改结构时检查来源解析位置、条件字段、草稿 revision、激活回退和冷重启。修改编排时核对已提交的模型请求、工具结算、轮次与步骤的边界，并比较实时会话和最新发布使用的版本。`session/event` 负责观察，调度写入走对应的原生步骤与回合边界。

发布时更新版本和变更记录，构建 tgz 并用该包完成验收。GitHub Release 附安装包和同一产物的 `SHA256SUMS.txt`。验收日志和临时 profile 存放在工作区输出目录。 [架构与接入](architecture.md) · [更新记录](../CHANGELOG.md)
