# Teloa Free CLI

Teloa Free 的本地安装与维护命令。当前源码版本见 `package.json`，此源码快照尚未发布到 npm。

从源码运行与测试，请按照仓库根 [README](../../README.md) 操作。用户安装与配置说明见 [Teloa 文档](https://docs.teloa.ai/)。

## 安装后的常用命令

```sh
teloa --help
teloa status
teloa doctor
teloa start
teloa stop
```

以对应版本的 `--help` 输出为准。维护、备份和升级前按命令提示停止宿主；升级保留用户数据，凭据不随备份导出。模型凭据在设置页填写，请勿放入仓库或共享日志。

请阅读仓库的 [安全政策](../../SECURITY.md)、[许可证](../../LICENSE) 和 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

## English

Teloa Free CLI manages a local installation. See `package.json` for the source version. This source snapshot has not been published to npm.

For source setup and tests, follow the repository README. For an installed CLI, use `teloa --help`, `status`, `doctor`, `start` and `stop`. Follow the version-specific help and maintenance prompts. Credentials are excluded from backups; configure model credentials in Settings and keep them out of repositories and shared logs.

See [documentation](https://docs.teloa.ai/en/), the repository security policy, license and third-party notices.
