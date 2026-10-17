# Teloa SSH Headless profile 生成器

固定 DSH `0.2.1-rc.2`、SSH helper 协议 `2`。官方 `dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh` 分别持有连接、文件、进程、沙箱行为。本包只将已确认的部署坐标写成独立 profile。

**这不是 Web bundle。** 包不声明 `dsh.bundle`，原生 Web 安装器会拒绝它。官方默认 Web workspace 尚假定可访问 Host 文件系统，不能通过更换这四个服务就支持远端。生成器只创建新的目录，拒绝覆盖已有 profile，不安装、不连接、不启动任何进程。

准备 `deployment.json`，其中是部署坐标而不是密钥：

```json
{
  "host": "teloa-acceptance",
  "launch": {
    "kind": "node-script",
    "node": "/opt/teloa-dsh/bin/node"
  },
  "helper": "/opt/teloa-dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
  "helperHash": "替换为已部署官方helper文件的64位小写SHA256",
  "workspace": "/srv/teloa-acceptance",
  "mode": "workspace-write"
}
```

`node-script` 使用已部署的 Node 和匹配版本的官方 `@deepseek-ai/dsh-ssh/helper` 脚本及其依赖。若部署官方独立 helper 可执行文件，将 `launch` 改为 `{"kind":"executable"}`，`helper` 指向该可执行文件，`helperHash` 使用该文件摘要；不要再传 `node`。旧顶层 `node` 坐标仍接受，并只转换为 `launch:{kind:"node-script",node}`；同时提供旧 `node` 和新 `launch` 会拒绝，避免选择不明。

需要先由操作者在隔离 POSIX 主机部署匹配版本的运行文件，核对 helper 的 SHA-256。`host` 必须是已配置凭据和 known_hosts 的 OpenSSH alias；两端支持 Linux/macOS、连接复用与 Unix socket forwarding。远端 node/helper 必须在工作区、可写临时目录及沙箱替换目录之外；部署目录及其符号链接由操作者信任并保护。生成器拒绝常见 Linux/macOS 临时路径，但无法得知远端自定义 `TMPDIR`，操作者须另外核对实际临时目录。生成器只做坐标校验，不验证远端文件、部署 host key 或复制凭据。连接后的官方握手核对协议、启动类型和 helper 摘要，不匹配则拒绝就绪。

在已存在的专用 `DSH_HOME/profiles` 目录下生成一个尚不存在的子目录：

```sh
node "packages/native-remote/bin.mjs" --directory "/absolute/isolated-dsh/profiles/remote" < "deployment.json"
DSH_HOME=/absolute/isolated-dsh dsh plugin --profile remote install
DSH_HOME=/absolute/isolated-dsh dsh --profile remote --dump-config
DSH_HOME=/absolute/isolated-dsh dsh --profile remote --json "列出当前远端工作目录，读取验收样例，不修改任何文件。"
```

上述 install/start 命令应由验收编排者运行，确认依赖构建脚本后再继续，不使用正式 Teloa profile 或 3100。生成器需要 stdin JSON，错误不回显配置。重复目标返回非零并保留原文件。

profile 只选择官方 base+headless，所有 SSH 包版本固定。默认 `workspace-write`，可改 `read-only`；拒绝 `danger-full-access`、密码/私钥字段、Web 组合字段、根工作区、相对路径和无效摘要。`launch` 只接受上述两种官方形状，不接受额外启动参数。`approval: never` 在官方语义中表示需要审批的操作拒绝；不是允许所有。生成组合移除 Full access 权限预设，关闭会话遥测、PTC 和 Workflow；alpha3 已无旧 Ralph 条目，不再生成失配补丁。

`node-script` 可携带官方成对的 `launch.bootstrapPath` / `launch.bootstrapHash` 坐标，路径同样必须位于工作区和可写临时目录之外，摘要为 64 位小写 SHA-256；这只登记待握手核验的文件，**不会启用 PTC**。`executable` 使用其内置运行资源，拒绝额外 bootstrap 字段。

只读/写边界由远端官方沙箱执行。`read-only` 拒绝文件修改；`workspace-write` 的官方可写集合包含工作区及平台临时目录，读取仍沿官方文件提供方规则，不等同只读目录隔离。它不隔离网络或不可信远端 OS。断线后结果可能未确认，官方不自动重连重放。完整验收和 Headless 续接/JSON 要求见 [原生能力说明](https://docs.teloa.ai/guides/native-capabilities)。

本包测试使用真实官方 `Config` 与组合读取器，并直接启动本机官方 helper，以协议 2 RPC 验证握手、文件读取、只读拒写和工作区外非临时目录拒写。该测试没有建立 SSH 连接，不证明远端部署、连接转发、可执行文件载荷、取消或断线恢复已经通过。

## English

This package generates a new standalone official SSH Headless profile pinned to DSH 0.2.1-rc.2 and helper protocol 2. Supply an existing OpenSSH alias, absolute remote helper/workspace paths, the helper's SHA-256, and either `launch: {kind: "node-script", node: "/absolute/node"}` or `launch: {kind: "executable"}`. Legacy top-level `node` coordinates migrate to `node-script`; providing both forms is rejected. Optional script bootstrap coordinates must include both path and digest and do not enable PTC. Runtime files must remain outside the workspace and writable temporary roots. The generator rejects common Linux/macOS temporary paths; the operator must also check any custom remote `TMPDIR`.

The generator neither installs dependencies nor connects to a host and refuses existing output directories. Only read-only or workspace-write modes are accepted; approval-required operations fail closed. The official workspace-write policy also permits platform temporary directories, and does not confine reads or network access. PTC and Workflow remain disabled. The profile is not a Web bundle. Local tests exercise the official configuration reader and protocol-2 helper over local process streams, not SSH. Real remote deployment, executable payload, forwarding, cancellation and disconnection acceptance remain required.
