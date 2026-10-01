# Teloa SSH Headless profile 生成器

固定 DSH `0.1.7-rc.1`。官方 `dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh` 分别持有连接、文件、进程、沙箱行为。本包只将已确认的部署坐标写成独立 profile。

**这不是 Web bundle。** 包不声明 `dsh.bundle`，原生 Web 安装器会拒绝它。官方默认 Web workspace 尚假定可访问 Host 文件系统，不能通过更换这四个服务就支持远端。生成器只创建新的目录，拒绝覆盖已有 profile，不安装、不连接、不启动任何进程。

准备 `deployment.json`，其中是部署坐标而不是密钥：

```json
{
  "host": "teloa-acceptance",
  "node": "/opt/teloa-dsh/bin/node",
  "helper": "/opt/teloa-dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
  "helperHash": "替换为已部署官方helper文件的64位小写SHA256",
  "workspace": "/srv/teloa-acceptance",
  "mode": "workspace-write"
}
```

需要先由操作者在隔离 POSIX 主机安装匹配版本的 Node、已构建官方 `@deepseek-ai/dsh-ssh/helper` 入口及其依赖，确认该入口的 SHA-256。`host` 必须是已配置凭据和 known_hosts 的 OpenSSH alias；两端支持 Linux/macOS、连接复用与 Unix socket forwarding。远端 node/helper 必须在工作区、可写临时目录及沙箱替换目录之外；部署目录及其符号链接由操作者信任并保护。生成器不冒充部署器，不生成 host key，不复制凭据。

在已存在的专用 `DSH_HOME/profiles` 目录下生成一个尚不存在的子目录：

```sh
node packages/native-remote/bin.mjs --directory /absolute/isolated-dsh/profiles/remote < deployment.json
DSH_HOME=/absolute/isolated-dsh dsh plugin --profile remote install
DSH_HOME=/absolute/isolated-dsh dsh --profile remote --dump-config
DSH_HOME=/absolute/isolated-dsh dsh --profile remote --json "列出当前远端工作目录，读取验收样例，不修改任何文件。"
```

上述 install/start 命令应由验收编排者运行，确认依赖构建脚本后再继续，不使用正式 Teloa profile 或 3100。生成器需要 stdin JSON，错误不回显配置。重复目标返回非零并保留原文件。

profile 只选择官方 base+headless，所有 SSH 包版本固定。默认 `workspace-write`，可改 `read-only`；拒绝 `danger-full-access`、密码/私钥字段、Web 组合字段、根工作区、相对路径和无效摘要。`approval: never` 在官方语义中表示需要审批的操作拒绝；不是允许所有。生成组合移除 Full access 权限预设，关闭会话遥测和未部署远端 bootstrap 的 PTC/Workflow/Ralph，不改变 SSH provider 本身。

只读/写边界由远端官方沙箱执行；它不隔离网络或不可信远端 OS。断线后结果可能未确认，官方不自动重连重放。完整验收和 Headless 续接/JSON 要求见 [原生能力说明](https://docs.teloa.ai/guides/native-capabilities)。

## English

This package generates a new standalone official SSH Headless profile. It is deliberately not a Web bundle. Supply an existing OpenSSH alias, absolute remote Node/helper/workspace paths, and the deployed helper's SHA-256. The generator neither installs dependencies nor connects to a host and refuses existing output directories. Only read-only or workspace-write modes are accepted; approval-required operations fail closed. The default Web workspace is not compatible with remote paths. Real helper deployment, SSH cancellation, and Headless acceptance remain required.
