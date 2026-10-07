# @teloa/im-gateway

Teloa 内置消息通道（飞书 / Lark / Telegram / Slack），随平台默认加载，无需从市场安装或启用插件。用户在 设置 · IM 通道 添加并启用具体渠道后才建立连接；未配置时不连接外部消息服务。

- **内置加载**：源码准备、CLI、桌面和容器启动都加载固定随附来源；插件管理不能停用或移除 IM，本地中文检索仍为可选扩展。
- **渠道管理**：在设置中配置凭据、配对用户、绑定员工或工作群，暂停或移除具体渠道。插件默认加载不自动启用渠道，不改变旧渠道、绑定或凭据。
- **来源核对**：profile 依赖及 node_modules 只能指向本程序的随附目录；未知或替换来源拒绝准入。
- **旧安装**：启动补齐默认组合，旧 `im-gateway-optional-v1` 标记不再决定是否加载；原配置、审计及旧标记文件保留。

## 职责边界

- 只做渠道协议翻译、统一消息模型、配对／绑定／群绑定文件存储、命令与路由、群缓冲、审批／提问旁路 answerer、审计。
- 一切 Teloa 写操作经 harness-dsh 提供的进程内服务 `ctx.teloaWork`（`invoke` 直达 `dispatchTeloaEndpoint`，不登记 pending request，接口约束）；会话经 `conversations/create`，注入经 `ctx.sessionController.prompt`，群经 `groups/messages/send`。
- 凭据只经 `ctx.credentials`（`credentialKey('im-gateway',channelId)`）；任何回包、日志、审计不含凭据值与配对码值。
- 常驻方式：cordis 4.0.4 无 `ready` 事件，`apply` 内直接启动，资源经 `ctx.effect` 释放。

## 本机存储（`<runtimeRoot>/im-gateway/`，目录 0o700、文件 0o600）

| 文件 | 模块 | 内容 |
| --- | --- | --- |
| `channels.json` | `src/core/channels-config.ts` | 渠道种类、启用状态、创建时间（不含凭据） |
| `im-bindings.json` | `src/core/bindings.ts` | 绑定主键 `(channelId,imUserId)`、默认对象、会话指向；一期每渠道上限 1 人 |
| `im-groups.json` | `src/core/bindings.ts` | 群绑定主键 `(channelId,chatId)`；一个 Teloa 群只绑一个 IM 群 |
| `im-audit.jsonl` | `src/core/audit.ts` | 只增审计；配对行码数字遮蔽为 `*`；凭据形态（已知令牌前缀、`key=value` 中的 token/secret/password 值、≥32 位高熵串）拒写 |
| `instance.lock` | `src/instance-lock.ts` | 实例锁；被占用时对外 `teloa/dependency-unavailable` 固定文案 |

配对码（`src/core/pairing.ts`）只在内存：6 位数字 CSPRNG、10 分钟、一次性、同渠道新码作废旧码、群内出现即作废、同一 `(channelId,imUserId)` 连续错 5 次锁 15 分钟、同一有效码跨账号累计错 20 次即作废（审计记 `pair-rejected`/`code-exhausted`，不含码值）；`peek` 只回到期时间。

## 渠道管理与端点

- `src/core/channel-manager.ts`：保存凭据（`modifyRecord` 写 `{kind:'api-key',env}`，只读源 → `teloa/dependency-unavailable`；飞书与 Lark 先受管安装 SDK，失败不写凭据）、启用／停用／删除、`startEnabled`（单渠道失败只记 `status.error`）、`stopAll`；`credentialsSaved` 只看 `describeRecord`，适配器 `env()` 每次连接按次 `readRecord`。
- `src/server.ts`：`im/*` 12 个端点经 `teloaWork.attachExtension` 挂接；入参过契约白名单，回包只含摘要。实例锁未持有时写端点 → `teloa/dependency-unavailable`，三个 list 端点照常可读。
- `src/index.ts`：`apply` 内组装存储 → manager → `attachExtension` → `void manager.startEnabled()`，`ctx.effect` 释放时撤端点并停全部渠道。

## 飞书与 Lark（飞书国际版）

- 两个独立渠道种类 `feishu` 与 `lark`，共用 `src/channels/feishu.ts` 一份实现（`createFeishuAdapter({...,brand})`）：只按种类切换 SDK 官方域名常量（`Domain.Feishu` → `open.feishu.cn`，`Domain.Lark` → `open.larksuite.com`）、凭据键（`FEISHU_*`／`LARK_*`）与显示名。域名不来自任何输入；`loadFeishuSdk` 加载时核对 `Domain` 恰为官方两值，否则按开发包损坏处理。
- 两平台的应用、账号、租户互不相通，因此是两个渠道而不是一个选项：可同时启用，凭据按 `channelId` 分别存于 `credentialKey('im-gateway','feishu'|'lark')`，绑定、群绑定、配对码、审批旁路与审计均按 `channelId` 隔离。已有飞书渠道数据不迁移。

## 依赖

- `@deepseek-ai/*` 全部钉 `0.1.7-rc.1`（`pnpm check:dsh`）。
- 飞书 SDK `@larksuiteoapi/node-sdk` **不在**任何 package.json 依赖字段：添加飞书或 Lark 渠道时（两者共用同一配方与安装目录，不重复安装）经 `teloaWork.packages.install(feishuSdkRecipe)` 按随附完整 lock（含全部传递依赖 integrity）`npm ci --ignore-scripts` 装到临时目录、逐条核对后改名到 `<runtime>/packages/`（接口约束；harness-dsh 侧包名白名单、串行队列），适配器经 `loadFeishuSdk(安装目录)` 加载（`src/channels/feishu-sdk.ts`，Teloa 自有文件）。

## 已知限制

- 审批卡批准口径（`src/core/approval.ts`、`src/core/audit.ts`）：除只存待确认草案的 `teloa_create_draft`、`teloa_business_definitions_draft` 外，一律按命令类处理——参数有任何遮蔽，或含完整码位白名单（ASCII 可打印字符与 `\t \n`、汉字、平假名、片假名、韩文音节、常用中日韩标点）以外的码位，IM 卡片只给「拒绝」并提示「含已遮蔽的凭据，请到工作台查看并批准」。已知残余：汉字「一」在白名单内（极常用，形态明显长于 `-`），`rm 一i a.txt` 这类写法仍可在 IM 批准。

- 实例锁（`src/instance-lock.ts`）回收陈旧锁时，若三个及以上宿主在同一瞬间竞争同一把陈旧锁，极小概率出现两个宿主都认为自己持锁（放回被挪走的锁与第三方新落地的锁交错）；两宿主同时竞争不受影响。一期按「同一运行目录只开一个宿主」使用，不做进一步加固。

## 第三方来源

`src/channels/{telegram,slack}.ts`、`src/channels/feishu.ts`、`src/core/{split,format}.ts`、`src/instance-lock.ts` 搬运自 [zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway)（commit `c907dd5`，MIT）。许可全文见 `licenses/dsh-im-gateway.LICENSE`，逐文件记录见仓库根 `provenance/dsh-im-gateway.md`，本包声明见 `THIRD_PARTY_NOTICES.md`。

## 测试

```sh
pnpm --filter @teloa/im-gateway test
```
