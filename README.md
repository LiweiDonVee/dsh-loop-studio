# DSH Loop Studio

在 DeepSeek Harness 内查看 Agent 的执行流程，并为不同模型节点选择不同的提供方和模型。适用于普通预设、工具型 Agent 和主动接入的插件；无需安装 RP 插件或另开客户端。

Native DSH plugin for inspecting agent loops and routing supported model stages independently.

[下载安装包](https://github.com/LiweiDonVee/dsh-loop-studio/releases/latest) · [使用指南](docs/usage.md) · [架构与接入 API](docs/architecture.md) · [开发与验证](docs/development.md) · [更新记录](CHANGELOG.md)

![DSH 原生 Loop Studio](docs/images/loop-studio.png)

## 它能做什么

- 展示当前预设声明的插件组成、主循环与实际请求记录。
- 为每轮的首个模型请求和后续请求分别选择模型；支持接入 DSH 的云端与本地提供方。
- 为其他插件声明的模型阶段配置路由，例如 RP 预设迁移、模块热组装、最终正文。
- 设置模型支持的推理强度和输出 token 上限，保存为会话覆盖或预设默认。
- 对照“当前配置”和“最近实际请求”，检查路由是否真正生效。

0.1 展示并配置已有执行流程，连线不能拖改。图内核、策略、轨迹和宿主适配分离，为后续流程编辑保留接口；本版没有自由编排执行器。程序和工具节点供观察，未识别的自定义驱动也保持观察。

## 安装

已验证宿主：**DSH 0.2.1-rc.2**。发布包自包含，不需要 Node、pnpm 或本仓库源码；宿主自带运行环境。

1. 在 [Releases](https://github.com/LiweiDonVee/dsh-loop-studio/releases/latest) 下载 `dsh-loop-studio-0.1.0.tgz`。
2. 完全退出 DSH，包括后台进程。在安装包目录打开终端：

```powershell
dsh plugin --profile desktop add ./dsh-loop-studio-0.1.0.tgz
```

3. 重启 DSH，进入会话，点击顶部的 **Loop**；空白会话的输入区上方也有入口。也可从右侧新增页签导航打开 **Loop Studio**。

使用 Web 模式时将 `desktop` 改为 `web`。插件支持宿主侧栏拉宽、全屏和关闭。

如果 Windows 提示找不到 `dsh`，默认安装可使用官方启动器：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-loop-studio-0.1.0.tgz
```

自定义安装位置请改为相应启动器路径。升级同样使用 `plugin add` 安装新版本，重启后生效。发布页附 `SHA256SUMS.txt`，可用 `Get-FileHash ./dsh-loop-studio-0.1.0.tgz -Algorithm SHA256` 核对。

## 第一次配置

1. 选择 **首个模型请求**，勾选 **启用模型接管**。
2. 选择提供方与模型，例如为首步选择响应快的模型。
3. 选择 **后续模型请求**，按需要配置工具结果处理所用的模型。
4. 选择保存范围：**当前会话** 或 **此预设的默认配置**，点击 **保存配置**。
5. 运行下一轮，在节点详情和实际执行记录中检查使用的模型。

配置在下次请求装配时生效，不会改变已经开始的请求。会话覆盖优先于预设默认；关闭会话接管会覆盖已启用的预设默认，**恢复继承** 则删除所选层的配置。模型列表来自 DSH，请先在 DSH 中完成提供方配置。

“首个／后续”按真实步骤区分，后续并不自动等同于“最终回答”。标题生成等辅助调用有自己的宿主机制；插件没有声明接管这些调用。更细的规划、复核或正文阶段，需要执行它们的插件显式接入。

## 与 RP 项目的关系

| 项目 | 负责什么 | 是否必装 |
| --- | --- | --- |
| **Loop Studio** | 通用执行图与节点模型配置 | 本仓库 |
| [RP 最后一步](https://github.com/LiweiDonVee/dsh-rp-last-step) | ST 迁移、热组装、最终正文 | 可选 |
| [RP Studio](https://github.com/LiweiDonVee/dsh-rp-studio) | 原生故事阅读、角色状态与档案 | 可选 |

RP 最后一步安装后会注册自己的三个模型阶段，Loop Studio 无需包含 RP 逻辑。所有模型都必须已经在 DSH 中可用，插件不复制密钥、不启动模型代理，也不在某个模型失败后暗中切换提供方。

## 数据与恢复

配置保存在 `$DSH_HOME/app-data/loop-studio/policies.json`；未设置 `DSH_HOME` 时使用 `~/.dsh`。原始预设和宿主全局模型默认值不会被写回。关闭 DSH 后可备份该目录。

界面中的“当前配置”与实际使用的模型可能在一次请求期间不同：已装配的请求使用冻结配置，下次装配才读取修改。若另一个窗口先保存，界面保留本地草稿并提示重新载入；不要通过反复点击保存覆盖版本冲突。

常见问题与卸载时的请求收尾见 [使用指南](docs/usage.md)。

## 从源码构建

需要 Node.js 24 和 pnpm 11.9；不需要 Electron。

```powershell
git clone https://github.com/LiweiDonVee/dsh-loop-studio.git
cd dsh-loop-studio
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

产物为 `artifacts/dsh-loop-studio-0.1.0.tgz` 和 `artifacts/SHA256SUMS.txt`。完整原生验收：`pnpm smoke`，另需已安装的官方 DSH 和 Playwright Chromium。说明见 [开发文档](docs/development.md)。

项目使用 MIT 许可证。最初实现源自 [RP Studio 的集成版本](https://github.com/LiweiDonVee/dsh-rp-studio/commit/f0c7cbba469b28b730b8b895ed2250c1d235fc77)，本仓库是 Loop Studio 后续开发与发布的主仓库。
