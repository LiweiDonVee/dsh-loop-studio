# 0.1.0 独立仓库验收

0.1.1 的独立仓检查与本轮原生验收状态另见 [0.1.1 验收记录](acceptance-0.1.1.md)。以下保留 0.1.0 的历史结果。

2026-10-24，Node 24 / pnpm 11.9 / Windows，官方 DSH 0.2.1-rc.2。独立项目从自己的根目录安装依赖、运行测试并构建，不引用 RP Studio 工作区。

| 检查 | 结果 |
| --- | --- |
| 宿主、策略、内核、接口与存储测试 | 48/48 |
| UI、配置冲突和 API 组件测试 | 15/15 |
| 零 warning lint、生产构建、安装包与 SHA256SUMS | 通过 |
| 官方 DSH 中的标准、自定义预设 | 通过 |
| 显式、隐式原模型的首步/续步路由 | 分别实际调用 cloud/fast 与 local/quality |
| 关闭接管与装配后卸载 | 原模型恢复；已捕获请求与提示词路由一致 |
| 原生 UI 保存模型配置 | 所选模型随后被实际适配器使用 |
| 侧栏、全屏、520px、关闭重开 | 通过，无运行错误或横向溢出 |
| 与独立 RP 包及 Studio 1.2 联用 | RP 迁移、热组装、正文三节点及实际路由通过 |

本次受测安装包 SHA256：`aee2ccb93b23795139ae8a6dbd2a8e7f3300542e589ea8f7530326030f37f566`。对应 `pnpm smoke` 的 `.runtime/loop-evidence/acceptance.json`。

独立工作区下，测试夹具放在自己的 server-only package 边界，避免 DSH 将它继承为第二个客户端入口；该问题在真实宿主验收中发现并修复，插件运行时代码未因此改变。

验收使用全新临时 DSH home、合成预设和确定性模拟模型，无真实付费请求或私有卡库。模拟调用证明路由和生命周期，不比较真实模型质量、服务价格或延迟。当前不验证自由编辑拓扑、未知自定义驱动接管或未声明的辅助调用。

双平台 CI 配置在 `.github/workflows/ci.yml`，其实际执行状态以 [GitHub Actions](https://github.com/LiweiDonVee/dsh-loop-studio/actions) 为准；CI 不包含需要本地官方 DSH 安装的原生 smoke。
