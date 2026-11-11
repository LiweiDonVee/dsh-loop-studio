# DSH Loop Studio

在 DeepSeek Harness 中查看 Agent 的实际模型和工具记录，复制并编辑原生预设，用连线安排每一步模型请求和工具批次。

Native DSH plugin for inspecting Agent loops, editing preset copies, and wiring executable model and tool steps.

[下载安装包](https://github.com/LiweiDonVee/dsh-loop-studio/releases/latest) · [使用指南](docs/usage.md) · [架构与接入 API](docs/architecture.md) · [开发与验证](docs/development.md) · [更新记录](CHANGELOG.md)

## 安装

0.2.0 的目标宿主为 **DSH 0.2.2-rc.1**。安装包包含宿主和客户端入口，由 DSH 自带的运行环境加载。

1. 下载 `dsh-loop-studio-0.2.0.tgz`。可用 `Get-FileHash ./dsh-loop-studio-0.2.0.tgz -Algorithm SHA256` 与发布页的 `SHA256SUMS.txt` 核对。 [Releases](https://github.com/LiweiDonVee/dsh-loop-studio/releases)
2. 完全退出 DSH，在安装包所在目录执行以下命令。Web 模式使用 `--profile web`。

   ```powershell
   dsh plugin --profile desktop add ./dsh-loop-studio-0.2.0.tgz
   ```

3. 启动 DSH，从会话顶部、空白会话输入区上方的 **Loop** 或右侧新增页签打开。搭配支持入口整合的 RP Studio 时，从 **RP ▾ → 流程与模型** 打开。

Windows 的默认安装带有官方 CLI 启动器。`dsh` 未加入 PATH 时，在安装包所在目录执行以下命令。自定义安装请使用对应路径。

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-loop-studio-0.2.0.tgz
```

升级同样通过 `plugin add` 安装新版本，随后启动 DSH。

## 创建和使用副本

1. 打开 **预设结构**，选择来源预设，点击 **创建可编辑副本**。副本拥有独立的 DSH 预设 ID。
2. 在 **组件** 编辑插件与分组。可移动、复制和调整声明顺序，也可编辑插件配置、停用条件和服务选项。
3. 要编排模型与工具，在 **执行编排** 点 **启用连线编排**。选中节点以设置步骤指令、提供方和连线目标。
4. **保存草稿** 后点击 **发布预设**，确认变更。随后在空白会话的 DSH 预设选择器中选用它，发送消息后到 **执行流程** 查看该会话的版本与实际请求。

使用自定义 Agent 驱动时，可以按宿主顺序运行编辑后的组成。连线编排使用 DSH 自带的 AgentLoop 驱动和兼容的工具执行器。带工具出口的模型步骤使用会话中已准入的工具，工具批次沿用宿主的审批与执行。完整的两次接线示例见 [使用指南](docs/usage.md#试一次不同的请求顺序)。

## 为宿主流程选择模型

按宿主顺序执行的会话可以在 **执行流程** 中分别配置 **首个模型请求** 和 **后续模型请求**。在对应节点启用模型接管，选择 DSH 已配置的提供方与模型，将配置保存到 **当前会话** 或 **此预设的默认配置**。下一次请求装配使用已保存的配置，实际提供方与模型会出现在执行记录中。

主动接入的插件可声明自己的独立模型阶段。例如 RP 最后一步可分别配置 ST 迁移、热组装和最终正文所用的模型。RP Studio 提供菜单入口整合。这两款插件均为可选安装。 [RP 最后一步](https://github.com/LiweiDonVee/dsh-rp-last-step) · [RP Studio](https://github.com/LiweiDonVee/dsh-rp-studio)

## 数据与恢复

草稿与上次成功发布保存在 `$DSH_HOME/app-data/loop-studio/` 下按 profile 区分的结构库文件。路由策略和路由归属也保存在该目录，未设置 `DSH_HOME` 时使用 `~/.dsh`。

已开始的会话在同一宿主进程内继续使用已装配的发布版本。新会话选用当前发布，重启后重新装配的会话也使用当前发布。保存、发布与会话选用的具体流程见 [使用指南](docs/usage.md)。

## 从源码构建

需要 Node.js 24 和 pnpm 11.9。

```powershell
git clone https://github.com/LiweiDonVee/dsh-loop-studio.git
cd dsh-loop-studio
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

产物为 `artifacts/dsh-loop-studio-0.2.0.tgz` 和 `artifacts/SHA256SUMS.txt`。原生安装、编排和冷重启的复现命令见 [开发文档](docs/development.md)。

项目使用 MIT 许可证。本仓库维护 Loop Studio 的独立版本。最初实现源自 [RP Studio 的集成版本](https://github.com/LiweiDonVee/dsh-rp-studio/commit/f0c7cbba469b28b730b8b895ed2250c1d235fc77)。
