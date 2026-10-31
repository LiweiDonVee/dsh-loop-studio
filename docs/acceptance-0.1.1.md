# 0.1.1 独立仓库验收

2026-10-31，Windows、Node 24.15.0、pnpm 11.9.0。独立仓以 `9496e874fdb92b96d97a0ba077d950efdf0f85b6` 为基线，同步 Studio 已审提交 `d1524e2e4463f43173610d6f2b4a08364a28c184` 的 Loop 入口与字体更新。依赖、构建和安装包均来自独立仓，没有引用 Studio 的 node_modules 或构建产物。

| 检查 | 本次结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；保留原 lockfile |
| `pnpm check`：零 warning lint | 通过 |
| `pnpm check`：宿主、策略、路由、接口与存储测试 | 48/48 |
| `pnpm check`：UI、冲突、API 与入口测试 | 16/16 |
| `pnpm check`：生产构建 | 通过 |
| `pnpm package`：独立安装包与 SHA256SUMS | 通过 |

新增 UI 回归同时渲染会话 header 与空白 hero，确认独立状态下两个入口都打开 `loop-studio`，Studio 注册后同时隐藏，卸载后同时恢复，并释放订阅。页面与表单的字体规则限制在 Loop 根下；模型路由及 Host 数据格式未改变。

安装包：`artifacts/dsh-loop-studio-0.1.1.tgz`。

SHA256：`8bb9eee5cd8fb0056956fffeb3c8ce9ef8802a928d187c9837eeed4841ca329c`，与同目录 `SHA256SUMS.txt` 一致。

本轮最终原生验收目标为官方 DSH 0.2.1-rc.5，将直接安装此独立仓包，与 RP Studio 1.5.0 及五个 owner 包一起检查真实入口、路由、窄屏与字体矩阵。在该实装结果归档前，本记录只确认上表检查，不把 0.1.0/rc.2 或 Studio 内嵌副本的历史结果算作此包的原生通过证据。CI 仍按独立仓自己的双平台配置运行，其结果以 GitHub Actions 为准。

原生 smoke 已改为从本仓 `package.json` 解析安装包版本，并从实际 DSH CLI 读取版本写入验收报告，避免误装 0.1.0 或写入固定 rc.2。原有模拟模型、路由和生命周期断言保持原样；没有真实付费模型调用。
