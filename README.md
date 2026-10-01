# Teloa Free

[English](#english)

Teloa Free 是个人本地部署的 AI 团队工作台。可以创建 AI 员工、交办任务、查看进度和成果，并通过连接器、技能与业务看板组织工作。执行引擎使用 DeepSeek Harness（DSH）。

本仓库提供 Free 版本源码。当前快照版本见 `packages/cli/package.json`；此源码快照尚未发布到 npm。

## 从源码运行

需要 Node.js 22.19+ 或 24+、pnpm 11.7.0，以及用于本地 PostgreSQL 的 Docker。依赖版本由锁文件固定。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check:dsh
pnpm setup:database
pnpm setup:workspace
pnpm setup:dsh
pnpm dev:dsh
```

启动后按终端提示打开地址，在设置中配置模型。运行数据保存在 `.runtime/`，请勿提交数据库、凭据或会话数据。

## 测试与构建

```sh
pnpm typecheck
pnpm test:contract
pnpm test:bindings
pnpm test:repo
```

宿主与后端测试需要 Docker 和隔离数据库。
## 源码目录

| 目录 | 内容 |
| --- | --- |
| `packages/` | Free 客户端、后端、CLI、DSH 适配及随附扩展 |
| `config/` | 固定依赖基线 |
| `scripts/` | 启动、构建与资源校验工具 |
| `examples/industry/` | 使用合成数据的业务格式示例 |
| `tests/` | 构建与运行回归测试 |
| `third-party-licenses/` | 第三方许可证与来源说明 |

用户资料、模型授权和外部动作分别受权限控制。请阅读 [安全说明](SECURITY.md)。浏览器停止及远程执行仍受上游能力限制；停止会话不能保证所有外部请求立即中断。

[产品文档](https://docs.teloa.ai/) · [官网](https://www.teloa.ai/) · [资源市场](https://market.teloa.ai/)

采用 [Apache-2.0](LICENSE) 许可，第三方组件各自保留原许可；见 [NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [商标说明](TRADEMARK.md)。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## English

Teloa Free is a locally deployed AI team workspace for individuals. Create AI employees, assign work, follow task progress and results, and organize work with skills, connectors and business dashboards. The execution engine is DeepSeek Harness (DSH).

This repository contains the Free source code. See `packages/cli/package.json` for the snapshot version. This source snapshot has not been published to npm.

For source installation, use the commands above with Node.js 22.19+ or 24+, pnpm 11.7.0 and Docker for PostgreSQL. Open the URL printed at startup and configure a model in Settings. Runtime data stays under `.runtime/`; never commit credentials, databases or conversations.

Build and test commands are listed above. Backend and host tests need Docker and isolated databases.

See [documentation](https://docs.teloa.ai/en/), [security policy](SECURITY.md), [license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [contribution guide](CONTRIBUTING.md). Browser cancellation and remote execution remain subject to upstream limitations; stopping a conversation does not guarantee immediate cancellation of every external request.
