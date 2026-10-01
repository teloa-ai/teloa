import {businessObjectReference,type BusinessObjectReference} from '@teloa/contract'
import { initialBusinessSpaces,type BusinessScopeLabel } from './business-directory.ts'
import { newApproval, type ApprovalRecord, type LocalizedText } from './approval-preview.ts'
import type { CollaborationScope } from './collaboration-preview.ts'
import type {TeloaTranslate} from './i18n/index.js'

// 正式 UI 的页面内演示模型；不读取外部系统，不授予实际权限。
export type ObjectRef={scope:CollaborationScope;type:string;id:string;version:number;title:string;snapshotHash?:string}
export type BusinessObject=ObjectRef&{typeTitle:string;source:string;observedAt:string;receivedAt:string;quality:'complete'|'missing';summary:string;fields:{label:string;value:string}[]}
/**
 * `dashboardId` 只在 `section==='dashboards'` 时出现，与 `objectType` 互斥（导航恢复复用同一段存放）。
 * `match` 只在 `section==='data'` 且有 `objectType` 时出现：对象清单只看字段 `field` 等于 `value` 的对象（组件下钻，`_id` 是对象标识）。
 */
export type BusinessTarget={recordReference?:BusinessObjectReference;scope:CollaborationScope;section:'overview'|'projects'|'data'|'work'|'analysis'|'execution'|'dashboards';id?:string;objectType?:string;dashboardId?:string;match?:{field:string;value:string}}
export type ProjectConversationRef={id:string;title:string;projectId:string;relation:'main'}|{id:string;title:string;projectId:string;taskId:string;relation:'task'}
export type ProjectTaskRef={id:string;title:string;state:'ready'|'running'|'completed';owner:string;projectId:string;conversations:Extract<ProjectConversationRef,{relation:'task'}>[]}
export type ProjectRelationRef={id:string;title:string;projectId:string;detail:string}
export type ProjectPreview={
 id:string;scope:CollaborationScope;typeId:'general.project'|'security.audit_project'|'design.project';typeName:string;title:string;goal:string;state:'planning'|'running'|'review';owner:string;period:string
 mainConversation:Extract<ProjectConversationRef,{relation:'main'}>;tasks:ProjectTaskRef[];groups:ProjectRelationRef[];plans:ProjectRelationRef[];resources:ProjectRelationRef[];artifacts:ProjectRelationRef[]
}
export type ProjectRelationshipSection={kind:'main-conversation'|'tasks'|'groups'|'plans'|'resources'|'artifacts';count:number;childCount?:number}
export type DataQuery={scope:CollaborationScope;text:string;source:string;quality:'all'|'complete'|'missing';period:'all'|'30m'}
export type AnalysisRun={id:string;flowId:string;batchId:string;scope:CollaborationScope;title:string;inputs:ObjectRef[];state:'completed'|'stale'|'failed';findings:number;result:string;method:string;createdAt:string;taskId?:string}
export const operationStates={pending:'task.detail.operation.pending',approved:'task.detail.operation.approved',rejected:'task.detail.operation.rejected',changes:'task.detail.operation.changes',stale:'task.detail.operation.stale',executing:'task.detail.operation.executing',unknown:'task.detail.operation.unknown',partial:'task.detail.operation.partial',verified:'task.detail.operation.verified'} as const
export const targetStates={pending:'business.target.state.pending',accepted:'business.target.state.accepted',unknown:'business.target.state.unknown',failed:'business.target.state.failed',verified:'business.target.state.verified'} as const
export type BusinessWorkEntry=({message:LocalizedText;text?:never}|{message?:never;text:string})&{at:string}
export type OperationTarget={id:string;name:string;state:keyof typeof targetStates;attempts:{id:string;at:string;receipts:BusinessWorkEntry[]}[]}
export type BusinessOperation={id:string;scope:CollaborationScope;title:string;version:number;state:keyof typeof operationStates;inputs:ObjectRef[];goal:string;parameters:string;risk:string;targets:OperationTarget[];approval?:ApprovalRecord;policy?:{id:string;version:number;source:string;scope:string;criterion:string};taskId?:string;history:BusinessWorkEntry[]}
export type BusinessPreview={spaces:BusinessScopeLabel[];loaded:boolean;projects:ProjectPreview[];objects:BusinessObject[];flows:{id:string;scope:CollaborationScope;title:string;paused:boolean}[];runs:AnalysisRun[];operations:BusinessOperation[]}
export const emptyBusinessPreview=():BusinessPreview=>({spaces:initialBusinessSpaces(),loaded:false,projects:[],objects:[],flows:[],runs:[],operations:[]})
export function projectTypeLabel(scope:string,t?:TeloaTranslate):string{
 const key=scope==='AppSec'?'project.type.audit':'project.type.general'
 return t?t(key):scope==='AppSec'?'审计项目':'项目'
}
export function projectRelationshipSections(project:ProjectPreview):ProjectRelationshipSection[]{return [
 {kind:'main-conversation',count:1},
 {kind:'tasks',count:project.tasks.length,childCount:project.tasks.reduce((total,task)=>total+task.conversations.length,0)},
 {kind:'groups',count:project.groups.length},
 {kind:'plans',count:project.plans.length},
 {kind:'resources',count:project.resources.length},
 {kind:'artifacts',count:project.artifacts.length},
]}

function projectExamples():ProjectPreview[]{
 type ProjectSeed=Omit<ProjectPreview,'mainConversation'|'tasks'|'groups'|'plans'|'resources'|'artifacts'>&{main:[id:string,title:string];tasks:Array<[id:string,title:string,ProjectTaskRef['state'],string,Array<[id:string,title:string]>]>;groups:Array<[string,string,string]>;plans:Array<[string,string,string]>;resources:Array<[string,string,string]>;artifacts:Array<[string,string,string]>}
 const create=(input:ProjectSeed):ProjectPreview=>{
  const relation=(row:[string,string,string]):ProjectRelationRef=>({id:row[0],title:row[1],projectId:input.id,detail:row[2]})
  const {main,tasks,groups,plans,resources,artifacts,...project}=input
  return {...project,mainConversation:{id:main[0],title:main[1],projectId:input.id,relation:'main'},tasks:tasks.map(([id,title,state,owner,conversations])=>({id,title,state,owner,projectId:input.id,conversations:conversations.map(([conversationId,conversationTitle])=>({id:conversationId,title:conversationTitle,projectId:input.id,taskId:id,relation:'task'}))})),groups:groups.map(relation),plans:plans.map(relation),resources:resources.map(relation),artifacts:artifacts.map(relation)}
 }
 return [
  create({id:'project-product-launch',scope:'general',typeId:'general.project',typeName:'项目',title:'新产品发布',goal:'在三个月内完成需求、研发、测试和发布准备，并保留每项决定与验收依据。',state:'running',owner:'Max',period:'2026-09-01 — 2026-12-01',main:['launch-main','新产品发布 · 主会话'],tasks:[['launch-requirements','确认发布范围与完成判据','completed','本人',[['launch-requirements-session','范围与判据核对']]],['launch-delivery','推进研发、测试与发布材料','running','产品协作岗',[['launch-delivery-session','交付推进'],['launch-release-review','发布前核对']]]],groups:[['launch-group','产品发布协作群','本人、产品协作岗、研发与运营']],plans:[['launch-weekly','每周发布进度核对','每周一 09:00 · 已暂停']],resources:[['launch-brief','产品发布说明 v3','项目采用的固定范围与发布约定']],artifacts:[['launch-checklist','发布检查清单 v2','任务结果与验收记录']]}),
  create({id:'project-code-audit',scope:'AppSec',typeId:'security.audit_project',typeName:'审计项目',title:'2026 年度代码审计',goal:'完成核心服务年度代码审计，固定审计范围、证据版本和修复验收结果。',state:'running',owner:'AppSec 负责人',period:'2026-01-15 — 2026-12-15',main:['audit-main','年度代码审计 · 主会话'],tasks:[['audit-scope','确认仓库、版本与审计判据','completed','本人',[['audit-scope-session','审计范围核对']]],['audit-gateway','审计 gateway 服务','running','AppSec 审计岗',[['audit-gateway-session','gateway 审计执行'],['audit-gateway-review','gateway 修复复核']]],['audit-report','汇总年度审计报告','ready','本人',[['audit-report-session','报告结构与证据汇总']]]],groups:[['audit-group','年度代码审计协作群','本人、AppSec 审计岗、修复建议岗']],plans:[['audit-weekly','每周审计进度与新增仓库核对','每周五 17:00 · 已启用']],resources:[['audit-criteria','代码审计判据 v4','固定范围、风险判定与证据要求'],['audit-inventory','核心仓库清单 v7','本项目采用的仓库与版本范围']],artifacts:[['audit-findings','审计发现清单 v5','已核对发现与修复状态'],['audit-report-draft','年度审计报告 v2','当前汇总稿与来源说明']]}),
  create({id:'project-brand-entry',scope:'general',typeId:'design.project',typeName:'设计项目',title:'品牌入口改版',goal:'完成品牌入口的研究、设计、评审和交付，并保留授权素材的固定版本。',state:'review',owner:'设计负责人',period:'2026-09-01 — 2026-10-20',main:['design-main','品牌入口改版 · 主会话'],tasks:[['design-research','用户与品牌约束研究','completed','研究助理',[['design-research-session','研究与来源核对']]],['design-review','视觉方案与评审','running','设计助理',[['design-concept-session','方案设计'],['design-review-session','评审意见处理']]]],groups:[['design-group','品牌入口评审群','本人、设计助理、品牌负责人']],plans:[['design-review-plan','每周设计评审提醒','每周三 15:00 · 已启用']],resources:[['design-guideline','品牌规范 v6','项目采用的品牌与可访问性要求']],artifacts:[['design-prototype','交互原型 v3','当前评审稿与设计说明']]}),
 ]
}
export const objectRef=({scope,type,id,version,title}:ObjectRef):ObjectRef=>({scope,type,id,version,title})
/**
 * 业务对象引用 → 打开它的导航目标。
 * `objectType` 与 `id` 一起才定得下看哪一类对象，少一个就落到另一个列表上；
 * 会话关联区、任务详情的固定输入、分析与执行的来源列表共用这一把钥匙。
 */
export const objectRefTarget=(ref:ObjectRef):BusinessTarget=>({scope:ref.scope,section:'data',id:ref.id,objectType:ref.type,...(ref.snapshotHash===undefined?{}:{recordReference:businessObjectReference({scope:ref.scope,type:ref.type,id:ref.id,version:ref.version,snapshotHash:ref.snapshotHash})})})
export const objectKey=(ref:ObjectRef)=>JSON.stringify([ref.scope,ref.type,ref.id,ref.version])
export const sameObject=(a:ObjectRef,b:ObjectRef)=>a.scope===b.scope&&a.type===b.type&&a.id===b.id
export const currentObject=(state:BusinessPreview,ref:ObjectRef)=>state.objects.find(item=>sameObject(item,ref))
export const inputsCurrent=(state:BusinessPreview,refs:ObjectRef[])=>refs.length>0&&refs.every(ref=>currentObject(state,ref)?.version===ref.version)
export function queryObjects(objects:BusinessObject[],query:DataQuery,now:string){
  const text=query.text.trim().toLocaleLowerCase(),time=Date.parse(now)
  return objects.filter(item=>item.scope===query.scope&&(query.source==='all'||item.source===query.source)&&(query.quality==='all'||item.quality===query.quality)&&(query.period==='all'||(Date.parse(item.observedAt)<=time&&Date.parse(item.observedAt)>=time-1800000))&&[item.title,item.id,item.type,item.summary].some(value=>value.toLocaleLowerCase().includes(text)))
}
export function businessAttention(state:BusinessPreview):{id:string;title:string;scope:CollaborationScope;kind:'approval'|'dispatch'|'error';detail:string;target:BusinessTarget}[]{
  return [
    ...state.runs.filter(run=>run.state==='failed'||run.state==='completed'&&run.findings>0&&!run.taskId).map(run=>({id:'analysis:'+run.id,title:run.title,scope:run.scope,kind:run.state==='failed'?'error' as const:'dispatch' as const,detail:run.result,target:{scope:run.scope,section:'analysis' as const,id:run.id}})),
    ...state.operations.filter(op=>['pending','unknown','partial','changes','stale'].includes(op.state)).map(op=>({id:'operation:'+op.id,title:op.title,scope:op.scope,kind:op.state==='pending'?'approval' as const:'error' as const,detail:operationStates[op.state],target:{scope:op.scope,section:'execution' as const,id:op.id}})),
  ]
}

export function businessExamples(now:string):BusinessPreview{
  const ago=(minutes:number)=>new Date(Date.parse(now)-minutes*60000).toISOString()
  const objects:BusinessObject[]=[
    {scope:'SOC',type:'alert',typeTitle:'告警',id:'evt-1842',version:1,title:'prod-03 异常脚本与外联',source:'EDR',observedAt:ago(5),receivedAt:ago(4),quality:'complete',summary:'脚本执行与异常网络连接时间相近，需要关联账号与维护窗口后调查。',fields:[{label:'资产',value:'prod-03'},{label:'责任人',value:'生产运维组'},{label:'影响范围',value:'两台应用主机'}]},
    {scope:'SOC',type:'alert',typeTitle:'告警',id:'evt-1843',version:1,title:'prod-04 同源进程行为',source:'EDR',observedAt:ago(8),receivedAt:ago(7),quality:'complete',summary:'来自同批告警，暂未确认攻击结论。',fields:[{label:'资产',value:'prod-04'},{label:'责任人',value:'生产运维组'}]},
    {scope:'SOC',type:'asset',typeTitle:'资产',id:'asset-file-02',version:1,title:'file-02 资产资料待补齐',source:'CMDB',observedAt:ago(40),receivedAt:ago(39),quality:'missing',summary:'资产责任人缺失，不能据此自动降级或处置。',fields:[{label:'资产',value:'file-02'},{label:'责任人',value:'待补齐'}]},
    {scope:'SOC',type:'alert',typeTitle:'告警',id:'evt-maint',version:1,title:'测试环境维护事件',source:'EDR',observedAt:ago(12),receivedAt:ago(11),quality:'complete',summary:'维护单、账号和时间窗口一致，仅标记与归并，不执行隔离。',fields:[{label:'环境',value:'测试'},{label:'维护单',value:'MAINT-107 v3'}]},
    {scope:'AppSec',type:'repository',typeTitle:'代码仓库',id:'gateway',version:1,title:'gateway 服务依赖变更',source:'GitHub',observedAt:ago(15),receivedAt:ago(14),quality:'complete',summary:'记录代码审计输入版本，审计结论与发布操作分别管理。',fields:[{label:'分支',value:'main'},{label:'提交',value:'demo-4c8f1a'},{label:'负责团队',value:'网关组'}]},
    {scope:'general',type:'design',typeTitle:'设计稿',id:'gateway',version:1,title:'gateway 品牌入口设计',source:'设计资源库',observedAt:ago(20),receivedAt:ago(19),quality:'missing',summary:'设计稿已提交，品牌授权证明待补充。',fields:[{label:'文件',value:'品牌入口 v1'},{label:'授权依据',value:'待补齐'}]},
    {scope:'general',type:'document',typeTitle:'文档',id:'research-01',version:1,title:'工作台产品研究资料',source:'团队知识库',observedAt:ago(10),receivedAt:ago(9),quality:'complete',summary:'公共研究资料示例，可交办来源复核或单独撰写方案。',fields:[{label:'可见范围',value:'通用工作示例'},{label:'资料类型',value:'研究文档'}]},
  ]
  const inputs=objects.slice(0,2).map(objectRef),maintenance=[objectRef(objects[3]!)]
  const runs:AnalysisRun[]=[
    {id:'run-investigate',flowId:'soc-triage',batchId:'batch-104',scope:'SOC',title:'异常脚本与外联关联分析',inputs,state:'completed',findings:1,result:'发现一条待调查线索。未形成攻击定论，也未发起生产处置。',method:'告警关联判据 v3 · 账号、资产与时间窗口',createdAt:now},
    {id:'run-normal',flowId:'soc-triage',batchId:'batch-105',scope:'SOC',title:'维护事件归并',inputs:maintenance,state:'completed',findings:0,result:'维护窗口、账号与资产范围相符，归并并保留记录，无需调查任务。',method:'维护归并判据 v3',createdAt:now},
    {id:'run-error',flowId:'soc-triage',batchId:'batch-106',scope:'SOC',title:'资产关联查询失败',inputs:[objectRef(objects[2]!)],state:'failed',findings:0,result:'CMDB 示例连接认证过期，未使用旧缓存作结论。',method:'资产补全 v1',createdAt:now},
  ]
  const makeOperation=(id:string,title:string):BusinessOperation=>{
    const goal='在本人批准后隔离固定两台演示主机，保留管理通道；每台分别核验。',parameters='动作 isolate_host；目标 prod-03、prod-04；保留管理通道；最长 30 分钟。'
    return {id,scope:'SOC',title,version:1,state:'pending',inputs:inputs.map(objectRef),goal,parameters,risk:'高风险 · 可能中断业务连接',targets:['prod-03','prod-04'].map(name=>({id:name,name,state:'pending',attempts:[]})),approval:newApproval('approval-'+id,{subjectVersion:1,subjectLabel:'操作提议',title,goal,object:'prod-03、prod-04',result:parameters,evidence:inputs.map(ref=>ref.title+' · '+ref.id+' v'+ref.version),risk:'高风险 · 可能中断业务连接',effect:'批准仅覆盖以上目标、参数和来源版本；受理与效果分别核验。'},now),history:[{text:'提出固定目标与参数，等待本人审批。',at:now}]}
  }
  const contain=makeOperation('op-contain','隔离两台异常主机'),unknown=makeOperation('op-unknown','核对隔离操作的未知效果')
  unknown.approval={...unknown.approval!,version:2,status:'approved',decision:{kind:'approved',actorId:'self',note:'示例历史：允许固定范围内隔离。',at:now}}
  unknown.state='unknown';unknown.targets=unknown.targets.map(target=>({...target,state:'unknown',attempts:[{id:unknown.id+':'+target.id+':1',at:now,receipts:[{at:now,text:'示例下游已受理，效果回执中断。'}]}]}));unknown.history.push({text:'示例历史：本人批准后下游受理，当前效果未知。',at:now})
  const auto:BusinessOperation={id:'op-auto',scope:'SOC',title:'按维护判据标记与归并',version:1,state:'verified',inputs:maintenance,goal:'归并维护事件，不修改资产或生产配置。',parameters:'标记 maintenance；关联维护单 MAINT-107 v3。',risk:'低影响 · 仅维护标记',policy:{id:'maintenance-merge',version:3,source:'组织维护归并判据 · MAINT-107 v3',scope:'测试环境、已登记账号、维护窗口内；仅标记与归并',criterion:'资产、账号、时间窗口与有效维护单完全匹配'},targets:[{id:'evt-maint',name:'维护事件',state:'verified',attempts:[{id:'op-auto:evt-maint:1',at:now,receipts:[{at:now,text:'演示标记已写入并核对，未创建任务。'}]}]}],history:[{text:'演示判据匹配；在固定范围内完成低影响标记。',at:now}]}
  return {spaces:initialBusinessSpaces(),loaded:true,projects:projectExamples(),objects,flows:[{id:'soc-triage',scope:'SOC',title:'告警关联与维护归并',paused:false}],runs,operations:[contain,unknown,auto]}
}
