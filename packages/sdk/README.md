# Teloa SDK

调用本人 Teloa 社区版中的 AI 员工。HTTP、TypeScript/JavaScript SDK 和 MCP 共享同一工作服务；模型和工具仍使用原员工的授权与 BYOK。

在工作台设置的“员工对外调用”创建集成，明确选择员工、固定版本、业务范围、有效期和允许操作。凭据只显示一次，应存入业务系统服务端的密钥管理器。不要放进浏览器前端、会话或仓库。

```ts
import {TeloaClient} from '@teloa/sdk'

const client = new TeloaClient({baseUrl: 'http://127.0.0.1:3100', apiKey})
const {items: employees} = await client.listEmployees()
// 在业务数据库保存 requestId，再提交。丢失回包时使用同一 UUID 和同一正文重试。
const work = await client.startWork({employeeId: employees[0].id, input: '核对以下订单资料……'}, {requestId})
const current = await client.getWork(work.id)
// current.state 为 succeeded 后取固定结果；review 不等于业务审批或本人验收。
const result = await client.getResult(work.id)
```

- `startWork`/`continueWork`/`cancelWork` 必须传入调用方持久化的 UUID `requestId`。SDK 不自动更换请求身份或重试写操作。
- HTTP 契约在宿主 `/api/v1/openapi.json`；包内 [openapi.json](./openapi.json) 与共用请求定义同步生成。其他语言可直接使用 HTTP/OpenAPI。
- 新建与继续返回受理状态。轮询 `getWork`，或使用持久事件游标 `listEvents`、签名回调跟进。
- `waiting` 表示正在等待审批、本人恢复或处理阻断；由本人在工作台处理，API 和 MCP 不代替本人批准工具。
- `continueWork` 在当前轮结束后，以同一工作 ID 创建新一轮 Task/Run。提交完整的本轮要求；宿主附带上一轮固定结果最多1500字符作为上下文。旧结果仍可按版本读取。
- `cancel_requested` 表示已请求停止；`cancelled` 才表示已确认取消。终态取消是幂等的。
- `succeeded` 表示该轮运行正常结束、固定结果已保存，并且正式成果、关联任务结项和工作进展已在同一事务内完成。`review: accepted|unreviewed` 单独表示现有交付复核状态；均不替代业务系统或本人的最终验收。

### 权限模式与模型

`startWork` 与 `continueWork` 还接受两个可选字段：

```ts
const work = await client.startWork({
  employeeId,
  input: '核对以下资料并生成报告。',
  permissionMode: 'workspace-write',
  model: {provider: 'custom-provider', model: 'example-model', reasoningEffort: 'high'},
}, {requestId})
```

- `permissionMode` 取值 `danger-full-access`、`workspace-write`、`read-only`，对应宿主已配置的同名原生预设。新建未传时默认 `danger-full-access`；续办未传时继承该工作上一轮的显式或已解析选择。无效值与宿主缺少对应预设分别返回 `invalid_request`、`permission_mode_unavailable`，不会静默换档。
- `model.provider` 引用平台已保存的模型 provider（含自定义 provider），`model.model` 是该 provider 下的模型标识，可选 `reasoningEffort`。不接受密钥或地址。provider、模型或凭据不可用时返回 `model_unavailable`。
- 每轮选择随工作轮次保存，并在 `getWork`/状态事件中以 `permissionMode` 与 `model` 返回；显式选择只作用于该工作，不修改员工档案或平台默认模型。同一 `requestId` 不能通过重试更换权限模式或模型。
- `danger-full-access` 只改变原生执行沙箱与审批模式，不扩大集成绑定的员工、版本、业务范围或员工工具授权；员工工具授权与独立审批规则继续生效。
- 员工版本变化后需要本人重建授权。轮换密钥立即使旧密钥失效，保留同一集成的工作历史。撤销阻止新请求、未派发队列和后续回调；已接受的执行应从工作台另行停止。

MCP 使用宿主 `/mcp`、Streamable HTTP、`Authorization: Bearer <集成密钥>`。工具为 `teloa_list_employees`、`teloa_start_work`、`teloa_get_work`、`teloa_continue_work`、`teloa_cancel_work`、`teloa_get_result`、`teloa_list_work_events`，只公布已授予的操作。长任务返回工作 ID，不长时间占用工具请求；未声明 MCP Tasks 扩展或 A2A 支持。

回调地址由本人创建集成时固定；每次状态变化发送一个 CloudEvents 1.0 事件，只有工作状态、结果版本、权限模式与模型引用，不附输入、凭据、地址或结果正文。正文为 `application/cloudevents+json`，签名为 HMAC-SHA256(`timestamp + "." + rawBody`)。`teloa-webhook-id` 是稳定事件 ID，重试保留同一 ID；`teloa-webhook-timestamp` 和 `teloa-webhook-signature` 交给 `verifyWebhook`，通过后再解析 JSON。接收方持久保存事件 ID 去重，并按工作版本处理可能乱序的通知。

```ts
import {verifyWebhook} from '@teloa/sdk'
const valid = await verifyWebhook({body: rawBody, secret: signingSecret, timestamp, signature})
```

回调不跟随重定向，单次上限10秒，最多5次自动尝试；失败可在工作台查看并重新投递。CloudEvents 只规定信封，投递记录和重试由 Teloa 实现。重启恢复队列、游标、结果及待投递事件。远程服务使用 HTTPS；本机回环验收可用 HTTP。
