import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {openResourceDatabase} from '../packages/backend/src/capabilities/database.ts'
import {markdownKnowledgeReferenceId} from '../packages/backend/src/capabilities/markdown-knowledge-catalog.ts'

const actor={ownerId:'local:teloa-owner',kind:'human',scopeIds:['general']}
const identity={id:randomUUID,now:()=>new Date().toISOString()}
// 与 `准备本机工作目录.mjs` 同一个变量：不设时仍是正式运行目录，设了就跟着走（验收宿主用它指到临时 schema）。
const database=await openResourceDatabase(resolve(process.env.TELOA_RUNTIME_ROOT||'.runtime/teloa','database.json'),identity)

const examples=[
  {
    title:'安全工作空间导览',category:'business-context',topics:['安全','工作空间'],
    markdown:`# 安全工作空间导览

安全工作空间把日常工作组织为一套可追溯的协作闭环：数字员工接收目标，读取获准资料，使用岗位能力完成分析；需要人判断或授权时，工作回流到「需要你」。

## 工作如何流转

1. 从会话或工作台交办目标。
2. 选择业务空间与负责的数字员工。
3. 数字员工形成调查结论、证据和建议。
4. 高风险动作进入人工核对，低风险动作按授权执行。
5. 成果、判断和修订沉淀为可复用知识。

## 三个工作面

- **业务面**：任务、案件、协作与审批。
- **数据面**：告警、资产、代码、日志和外部业务数据。
- **执行面**：通知、阻断、修复、建单及其他可产生业务影响的动作。

## 使用原则

知识用于提供业务背景和成熟方法；Skill 用于复用稳定能力；权限决定数字员工可以读取什么、执行什么。没有现成 Skill 时，Agent Harness 仍可在授权边界内自主完成工作。
`,
  },
  {
    title:'SOC 告警调查 SOP',category:'sop',topics:['SOC','告警调查'],
    markdown:`# SOC 告警调查 SOP

## 目标

在保留证据链的前提下确认告警是否真实、影响范围多大，以及下一步是否需要处置。

## 调查步骤

1. 核对告警来源、规则版本和首次发生时间。
2. 识别关联用户、资产、进程、网络连接与历史事件。
3. 区分已知正常行为、配置偏差和真实攻击活动。
4. 记录支持结论的证据，也记录仍无法解释的矛盾点。
5. 给出结论、置信度、影响范围和建议动作。

## 回流条件

- 缺少关键日志或资产负责人信息。
- 建议动作涉及隔离、封禁、删除或生产变更。
- 证据互相冲突，无法达到处置判据。

## 交付物

调查摘要、证据清单、影响对象、处置建议、待补资料及审批项。
`,
  },
  {
    title:'AppSec 代码审计判据',category:'criteria',topics:['AppSec','代码审计'],
    markdown:`# AppSec 代码审计判据

## 有效发现

一个代码安全发现至少需要包含：可定位的代码路径、可复现的输入路径、成立前提、影响说明和修复建议。

## 风险判断

| 维度 | 核对内容 |
| --- | --- |
| 可利用性 | 攻击者是否能控制输入并到达危险操作 |
| 影响 | 是否影响机密性、完整性或可用性 |
| 暴露面 | 是否位于公网、跨信任边界或高权限服务 |
| 缓解措施 | 是否已有认证、校验、隔离或运行时防护 |

## 不应直接判定为漏洞

- 仅命中危险函数但输入不可控。
- 只存在理论路径，实际构建或运行配置不可达。
- 缺少调用上下文，无法确认边界条件。

审计结论应明确区分事实、推断和待验证项。
`,
  },
  {
    title:'GRC 安全例外审批制度',category:'policy',topics:['GRC','例外审批'],
    markdown:`# GRC 安全例外审批制度

安全例外用于处理短期内无法满足既定控制要求的业务情形，不等同于永久豁免。

## 申请必须说明

- 对应控制要求及无法满足的原因。
- 涉及的系统、数据、用户和业务范围。
- 风险评估、补偿控制和验证方式。
- 明确的负责人、到期时间和退出计划。

## 审批原则

例外范围应尽可能小，期限应尽可能短。涉及敏感数据、生产写入或不可逆动作时，必须由人完成最终审批。

## 到期处理

到期前重新核对风险和整改进度；未续期的例外自动失效，并回流给负责人处理。
`,
  },
  {
    title:'证据记录规范',category:'policy',topics:['通用','证据'],
    markdown:`# 证据记录规范

证据记录必须帮助另一位协作者复核同一结论。

## 最小字段

- 来源系统与稳定对象标识
- 采集或观察时间
- 原始内容摘要与固定版本
- 与当前结论的关系
- 采集人或数字员工身份

## 记录要求

原始事实与分析结论分开书写。引用在线文档、告警或代码时保留稳定链接；内容可能变化时固定版本或摘要哈希。敏感内容按最小范围授权，不在普通会话中扩散。
`,
  },
]

try{
  const current=await database.service.list(actor)
  const obsolete=current.resources.filter(row=>row.status==='active'&&(row.title==='岗位知识验收'||/^首页资料引用/.test(row.title)||/^\[E2E\]/.test(row.title)))
  for(const row of obsolete)await database.service.withdraw(actor,{resourceId:row.id,expectedVersion:row.version})

  const items=await database.knowledge.list(actor,{})
  const existing=new Set(items.map(item=>item.title))
  const created=[]
  for(const example of examples){
    if(existing.has(example.title))continue
    const knowledge=await database.knowledge.createPaste(actor,{requestId:randomUUID(),title:example.title,category:example.category,topics:example.topics,scopeIds:['general'],markdown:example.markdown})
    const draft=await database.service.create(actor,{requestId:randomUUID(),title:example.title,sourceId:markdownKnowledgeReferenceId(knowledge.item.id),sourceVersion:knowledge.version.contentHash,scopeIds:['general']})
    const resource=await database.service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
    created.push({title:resource.title,resourceId:resource.id,knowledgeId:knowledge.item.id})
  }
  console.log(JSON.stringify({withdrawn:obsolete.map(row=>row.title),created},null,2))
}finally{
  await database.pool.end()
}
