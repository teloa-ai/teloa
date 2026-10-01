# Teloa · AI-Native Team Studio

Teloa 用于构建、协作和运行 AI 团队。**Teloa Free** 是面向个人、自行部署的版本：为 AI 员工配置职责、资料、技能和连接器，交办任务，跟进进度，并把成果关联到业务记录和看板。

本包提供 Free 版本的安装和维护命令，以及运行所需的应用。使用自己的模型服务和凭据。

[产品介绍](https://www.teloa.ai/) · [使用文档](https://docs.teloa.ai/) · [资源市场](https://market.teloa.ai/) · [源码](https://github.com/teloa-ai/teloa)

## 安装与启动

需要 Node.js **22.19+（22.x）或 24.x**、npm **11.12.1+（11.x）**，以及已启动的本机 Docker 引擎（用于独立 PostgreSQL 数据库）。

```sh
npm install -g --ignore-scripts @teloa/cli@0.2.0-alpha.7
teloa up
```

默认打开本机 Web 界面，首次进入后在设置中配置模型。在浏览器未自动打开时运行 `teloa open`。默认安装目录为 `~/.teloa`，Web 端口为 3100；新安装可通过 `teloa up --home <目录> --port <端口> --workspace <工作目录>` 指定。

已有 PostgreSQL 可通过 `--database-config <文件>` 提供包含 `connectionString` 的 JSON 文件，权限应为 `0600`。不要把连接凭据放入命令行、仓库或共享日志。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `teloa status` | 查看本安装的运行状态。 |
| `teloa doctor` | 检查环境和运行依赖，不修改数据。 |
| `teloa open` | 打开当前安装的 Web 界面。 |
| `teloa logs` | 查看脱敏日志。 |
| `teloa stop` | 空闲时停止本安装，保留数据。 |
| `teloa restart` | 重启；有运行中工作时拒绝。 |
| `teloa backup --output <新目录>` | 停止后备份数据库、会话与资料。 |
| `teloa restore --from <备份目录> --home <新目录>` | 恢复到新的安装目录。 |
| `teloa upgrade --to <确切版本>` | 停止后升级至指定版本。 |
| `teloa uninstall` | 注销服务，保留数据库、工作文件和配置。 |

运行 `teloa --help` 查看当前版本支持的参数。备份不包含模型凭据或工作目录中的文件；恢复后核对原工作目录，并重新配置凭据。备份文件本身未加密，应保存在受保护的位置。

## English

Teloa is an **AI-Native Team Studio** for building, collaborating with, and running an AI team. **Teloa Free** is its self-hosted personal edition. Give AI employees roles, knowledge, skills and connectors; assign tasks, follow progress, and keep results connected to business records and dashboards.

This package includes the Free application and its installation and maintenance CLI. Bring your own model service and credentials.

[Website](https://www.teloa.ai/en/) · [Documentation](https://docs.teloa.ai/en/) · [Resource market](https://market.teloa.ai/en/) · [Source](https://github.com/teloa-ai/teloa)

Use Node.js **22.19+ (22.x) or 24.x**, npm **11.12.1+ (11.x)**, and a running local Docker engine for the dedicated PostgreSQL database. Run the installation commands above, then configure your model in the Web interface. The default home is `~/.teloa` and the default Web port is 3100. A new installation accepts `--home`, `--port` and `--workspace`; `--no-open` suppresses the browser launch.

Use `status`, `doctor`, `open`, `logs`, `stop` and `restart` for daily maintenance. Stop the installation before backups or upgrades. Restore backups into a new home. Backups exclude model credentials and workspace files; reconfigure credentials and verify the original workspace before resuming. `uninstall` unregisters the service and preserves data. Consult `teloa --help` for version-specific arguments.

## License and support

Free source code is licensed under [Apache-2.0](https://github.com/teloa-ai/teloa/blob/main/LICENSE). See [third-party notices](https://github.com/teloa-ai/teloa/blob/main/THIRD_PARTY_NOTICES.md) for bundled dependencies and [trademark guidance](https://github.com/teloa-ai/teloa/blob/main/TRADEMARK.md) for the Teloa name.

Report ordinary problems through [GitHub Issues](https://github.com/teloa-ai/teloa/issues). For vulnerabilities with significant impact, contact **security@teloa.ai** privately; see the [security policy](https://github.com/teloa-ai/teloa/blob/main/SECURITY.md). Product support: **support@teloa.ai**.
