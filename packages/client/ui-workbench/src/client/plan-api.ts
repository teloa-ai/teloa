import {readPlanWorkConfiguration,readPlanWorkDefinition,type PlanWorkDefinition,type PlanWorkConfiguration} from '@teloa/contract'
import {isRecord,readScheduleTrigger,readTaskCompletionPolicy,taskDefinition,type ScheduleTrigger,type TaskCompletionPolicy} from '@teloa/contract'
import type {ContinuousPlan} from './continuous-preview.ts'
import type {CollaborationScope} from './collaboration-preview.ts'
import {readPlanScheduleSummary} from './plan-schedule-summary.ts'
import {readPlanExecutionDirectoryPage,readPlanExecutionHistoryPage,type PlanExecutionHistoryCursor} from './plan-execution-history.ts'
import {readPlanSkipHistoryPage,type PlanSkipHistoryCursor} from './plan-skip-history.ts'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type PlanRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type PlanSource={kind:'manual'}|{kind:'market-content';contentId:string;contentHash:string;resourceId:string;resourceVersion:string}|{kind:'system-digest';roleId:string}
export type PlanNotificationPolicy='always'|'attention'|'failure'|'silent'
export type PlanFields={title:string;goal:string;scope:string;dataScope:string;delivery:string;roleId:string;trigger:ScheduleTrigger;notificationPolicy?:PlanNotificationPolicy;completionPolicy?:TaskCompletionPolicy}
export type PlanCreateFields=Omit<PlanFields,'notificationPolicy'>&{notificationPolicy:PlanNotificationPolicy;expectedRoleVersion:number}
export type SavedPlan=PlanFields&{workDefinition?:PlanWorkDefinition;id:string;ownerId:string;roleVersion:number;source:PlanSource;version:number;configVersion:number;state:'paused'|'active'|'archived';archivedReason:string|null;archivedAt:string|null;createdAt:string;updatedAt:string}
export type PlanAction='enable'|'pause'|'archive'
export type PlanUpdateFields=Pick<PlanFields,'title'|'goal'|'dataScope'|'delivery'|'trigger'|'notificationPolicy'|'completionPolicy'>
export type PlanWorkEditFields=Pick<PlanFields,'title'|'goal'|'dataScope'|'delivery'>
export type PlanExecutionRunState='prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed'|'not-started'
export type PlanExecutionDirectoryInput={limit:number;cursor?:PlanExecutionHistoryCursor;scope?:string;roleId?:string;query?:string;runState?:PlanExecutionRunState}
export type PlanTriggerResult={planId:string;claimId:string;taskId:string;runId:string}
export type PlanCommand=({kind:'create';requestId:string;fields:PlanCreateFields;source:PlanSource}|{kind:'change';planId:string;requestId:string;expectedVersion:number;action:PlanAction;note?:string}|{kind:'update';planId:string;requestId:string;expectedVersion:number;expectedConfigVersion:number;expectedState:SavedPlan['state'];fields:PlanUpdateFields})&{confirmed?:true}|{kind:'configure-work';planId:string;requestId:string;expectedVersion:number;expectedConfigVersion:number;configuration:PlanWorkConfiguration;fields?:PlanWorkEditFields;confirmed:true}|{kind:'trigger';planId:string;requestId:string;expectedVersion:number;expectedConfigVersion:number;now:string}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const date=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const notificationPolicy=(value:unknown):value is PlanNotificationPolicy=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('持续计划格式不正确。');return value}

function readSource(value:unknown):PlanSource{
 const row=exact(value,['kind','contentId','contentHash','resourceId','resourceVersion','roleId'])
 if(row.kind==='manual'){if(Object.keys(row).length!==1)throw Error('计划来源格式不正确。');return {kind:'manual'}}
 if(row.kind==='system-digest'){if(Object.keys(row).length!==2||!uuid(row.roleId))throw Error('计划来源格式不正确。');return {kind:'system-digest',roleId:row.roleId}}
 if(row.kind!=='market-content'||!uuid(row.contentId)||!hash(row.contentHash)||!stableId(row.resourceId)||!semver(row.resourceVersion))throw Error('计划来源格式不正确。')
 return {kind:'market-content',contentId:row.contentId,contentHash:row.contentHash,resourceId:row.resourceId,resourceVersion:row.resourceVersion}
}
function readWorkEdit(value:unknown):PlanWorkEditFields{const v=exact(value,['title','goal','dataScope','delivery']),base=taskDefinition({title:v.title,goal:v.goal,scope:'general'});if(Object.keys(v).length!==4||!text(v.dataScope,8000)||!text(v.delivery,8000))throw Error('长期工作目标格式不正确。');return {title:base.title,goal:base.goal,dataScope:v.dataScope.trim(),delivery:v.delivery.trim()}}
function readFields(value:unknown,creating:boolean):PlanFields|PlanCreateFields{
 const row=exact(value,['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy','completionPolicy',...(creating?['expectedRoleVersion']:[])])
 const base=taskDefinition({title:row.title,goal:row.goal,scope:row.scope}),trigger=readScheduleTrigger(row.trigger)
 if(!text(row.dataScope,8000)||!text(row.delivery,8000)||!uuid(row.roleId)||creating&&!positive(row.expectedRoleVersion)||creating&&!notificationPolicy(row.notificationPolicy)||!creating&&row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy))throw Error('持续计划字段格式不正确。')
 const fields:PlanFields={title:base.title,goal:base.goal,scope:base.scope,dataScope:row.dataScope.trim(),delivery:row.delivery.trim(),roleId:row.roleId,trigger,...(row.notificationPolicy===undefined?{}:{notificationPolicy:row.notificationPolicy as PlanNotificationPolicy}),...(row.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(row.completionPolicy)})}
 return creating?{...fields,notificationPolicy:row.notificationPolicy as PlanNotificationPolicy,expectedRoleVersion:row.expectedRoleVersion as number}:fields
}
function readUpdateFields(value:unknown):PlanUpdateFields{
 const row=exact(value,['title','goal','dataScope','delivery','trigger','notificationPolicy','completionPolicy'])
 const base=taskDefinition({title:row.title,goal:row.goal,scope:'general'}),trigger=readScheduleTrigger(row.trigger)
 if(!text(row.dataScope,8000)||!text(row.delivery,8000)||!notificationPolicy(row.notificationPolicy))throw Error('计划更新字段格式不正确。')
 return {title:base.title,goal:base.goal,dataScope:row.dataScope.trim(),delivery:row.delivery.trim(),trigger,notificationPolicy:row.notificationPolicy,...(row.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(row.completionPolicy)})}
}
function readChange(value:unknown):Extract<PlanCommand,{kind:'change'}>{
 const row=exact(value,['kind','planId','requestId','expectedVersion','action','note','confirmed'])
 if(row.confirmed!==undefined&&row.confirmed!==true||row.kind!=='change'||!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!['enable','pause','archive'].includes(String(row.action)))throw Error('计划状态请求格式不正确。')
 if(row.action==='archive'){if(!text(row.note,4000))throw Error('归档原因格式不正确。')}
 else if(Object.hasOwn(row,'note'))throw Error('此计划状态操作不能包含归档原因。')
 return {kind:'change',planId:row.planId,requestId:row.requestId,expectedVersion:row.expectedVersion,action:row.action as PlanAction,...(row.confirmed===true?{confirmed:true as const}:{}),...(row.action==='archive'?{note:(row.note as string).trim()}:{})}
}
function readUpdate(value:unknown):Extract<PlanCommand,{kind:'update'}>{
 const row=exact(value,['kind','planId','requestId','expectedVersion','expectedConfigVersion','expectedState','fields','confirmed'])
 if(row.confirmed!==undefined&&row.confirmed!==true||row.kind!=='update'||!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!positive(row.expectedConfigVersion)||!['paused','active'].includes(String(row.expectedState)))throw Error('计划更新请求格式不正确。')
 return {kind:'update',planId:row.planId,requestId:row.requestId,expectedVersion:row.expectedVersion,expectedConfigVersion:row.expectedConfigVersion,expectedState:row.expectedState as SavedPlan['state'],fields:readUpdateFields(row.fields),...(row.confirmed===true?{confirmed:true as const}:{})}
}
function readTrigger(value:unknown):Extract<PlanCommand,{kind:'trigger'}>{
 const row=exact(value,['kind','planId','requestId','expectedVersion','expectedConfigVersion','now'])
 if(row.kind!=='trigger'||!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!positive(row.expectedConfigVersion)||!date(row.now))throw Error('立即运行请求格式不正确。')
 return {kind:'trigger',planId:row.planId,requestId:row.requestId,expectedVersion:row.expectedVersion,expectedConfigVersion:row.expectedConfigVersion,now:row.now}
}
function readCommand(value:unknown):PlanCommand{
 const row=exact(value,['kind','requestId','fields','source','planId','expectedVersion','expectedConfigVersion','expectedState','action','note','now','confirmed','configuration'])
 if(row.kind==='configure-work'){const v=exact(row,['kind','planId','requestId','expectedVersion','expectedConfigVersion','configuration','confirmed','fields']);if(!uuid(v.planId)||!uuid(v.requestId)||!positive(v.expectedVersion)||!positive(v.expectedConfigVersion)||v.confirmed!==true)throw Error('长期工作确认请求格式不正确。');return {kind:'configure-work',planId:v.planId,requestId:v.requestId,expectedVersion:v.expectedVersion,expectedConfigVersion:v.expectedConfigVersion,configuration:readPlanWorkConfiguration(v.configuration),...(v.fields===undefined?{}:{fields:readWorkEdit(v.fields)}),confirmed:true}}
 if(row.kind==='change')return readChange(row)
 if(row.kind==='update')return readUpdate(row)
 if(row.kind==='trigger')return readTrigger(row)
 if(row.confirmed!==undefined&&row.confirmed!==true||row.kind!=='create'||Object.keys(row).some(key=>!['kind','requestId','fields','source','confirmed'].includes(key))||!uuid(row.requestId))throw Error('计划创建请求格式不正确。')
 return {kind:'create',requestId:row.requestId,fields:readFields(row.fields,true) as PlanCreateFields,source:readSource(row.source),...(row.confirmed===true?{confirmed:true as const}:{})}
}
function readTriggerResult(value:unknown,command:Extract<PlanCommand,{kind:'trigger'}>):PlanTriggerResult{
 try{
  const row=exact(value,['planId','claimId','taskId','runId'])
  if(row.planId!==command.planId||!uuid(row.claimId)||!uuid(row.taskId)||!uuid(row.runId))throw Error()
  return {planId:row.planId,claimId:row.claimId,taskId:row.taskId,runId:row.runId}
 }catch{throw Error('持续计划立即运行回执格式不正确。')}
}
export function readSavedPlan(value:unknown):SavedPlan{
 try{
  const row=exact(value,['id','ownerId','title','goal','scope','dataScope','delivery','roleId','roleVersion','trigger','notificationPolicy','completionPolicy','source','version','configVersion','state','archivedReason','archivedAt','createdAt','updatedAt','workDefinition'])
  const fields=readFields({title:row.title,goal:row.goal,scope:row.scope,dataScope:row.dataScope,delivery:row.delivery,roleId:row.roleId,trigger:row.trigger,...(Object.hasOwn(row,'notificationPolicy')?{notificationPolicy:row.notificationPolicy}:{}),...(Object.hasOwn(row,'completionPolicy')?{completionPolicy:row.completionPolicy}:{})},false) as PlanFields,source=readSource(row.source)
  if(fields.title!==row.title||fields.goal!==row.goal||fields.scope!==row.scope||fields.dataScope!==row.dataScope||fields.delivery!==row.delivery||!uuid(row.id)||!text(row.ownerId,128)||row.ownerId.trim()!==row.ownerId||!positive(row.roleVersion)||!positive(row.version)||!positive(row.configVersion)||row.version<row.configVersion||!['paused','active','archived'].includes(String(row.state))||!date(row.createdAt)||!date(row.updatedAt)||row.updatedAt<row.createdAt)throw Error()
  const archived=row.state==='archived'
  if(archived?(!text(row.archivedReason,4000)||row.archivedReason.trim()!==row.archivedReason||!date(row.archivedAt)||row.archivedAt!==row.updatedAt):(row.archivedReason!==null||row.archivedAt!==null))throw Error()
  const workDefinition=row.workDefinition===undefined?undefined:readPlanWorkDefinition(row.workDefinition);if(workDefinition&&(workDefinition.definitionVersion!==row.configVersion||JSON.stringify(workDefinition.completion)!==JSON.stringify(fields.completionPolicy)))throw Error()
  return {...fields,...(workDefinition?{workDefinition}:{}),id:row.id,ownerId:row.ownerId,roleVersion:row.roleVersion,source,version:row.version,configVersion:row.configVersion,state:row.state as SavedPlan['state'],archivedReason:archived?row.archivedReason as string:null,archivedAt:archived?row.archivedAt as string:null,createdAt:row.createdAt,updatedAt:row.updatedAt}
 }catch{throw Error('持续计划服务返回的内容格式不正确。')}
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b))
const fixed=(plan:SavedPlan)=>JSON.stringify({title:plan.title,goal:plan.goal,scope:plan.scope,dataScope:plan.dataScope,delivery:plan.delivery,roleId:plan.roleId,roleVersion:plan.roleVersion,trigger:plan.trigger,...(plan.notificationPolicy===undefined?{}:{notificationPolicy:plan.notificationPolicy}),...(plan.completionPolicy===undefined?{}:{completionPolicy:plan.completionPolicy}),source:plan.source,...(plan.workDefinition?{workDefinition:plan.workDefinition}:{}),configVersion:plan.configVersion,createdAt:plan.createdAt})
const fixedCreation=(fields:PlanCreateFields,source:PlanSource,createdAt:string)=>JSON.stringify({title:fields.title,goal:fields.goal,scope:fields.scope,dataScope:fields.dataScope,delivery:fields.delivery,roleId:fields.roleId,roleVersion:fields.expectedRoleVersion,trigger:fields.trigger,notificationPolicy:fields.notificationPolicy,...(fields.completionPolicy===undefined?{}:{completionPolicy:fields.completionPolicy}),source,configVersion:1,createdAt})
const clearable=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))

export type PlanApi=ReturnType<typeof createPlanApi>
export function createPlanApi(call:Call,journal?:PlanRequestJournal,newId=()=>crypto.randomUUID()){
 let pending:PlanCommand|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false,observedOwner:string|undefined
 try{const raw=journal?.read();if(raw){if(raw.length>30000)throw Error();const row=exact(JSON.parse(raw),['schema','request']);if(row.schema!=='teloa.plan-command/v1'&&row.schema!=='teloa.plan-command/v2')throw Error();pending=readCommand(row.request);if((pending.kind!=='trigger'&&pending.confirmed===true)!==(row.schema==='teloa.plan-command/v2'))throw Error()}}catch{recoveryError=recoveryStorageError()}
 const owned=(plans:readonly SavedPlan[])=>{const owners=new Set(plans.map(plan=>plan.ownerId));if(owners.size>1||observedOwner&&[...owners].some(owner=>owner!==observedOwner))throw Error('持续计划响应超出当前本人范围。');observedOwner??=plans[0]?.ownerId}
 const clear=()=>{journal?.clear();pending=undefined}
 const reject=async<T>(operation:()=>Promise<T>):Promise<T>=>{try{return await operation()}catch(error){if(clearable(error))clear();throw error}}
 const send=async<T extends SavedPlan|PlanTriggerResult=SavedPlan>():Promise<T>=>{
  if(recoveryError)throw recoveryError;if(busy)throw Error('持续计划请求正在核对。');if(!pending)throw Error('没有待核对的持续计划请求。')
  busy=true
  try{
   journal?.write(JSON.stringify({schema:pending.kind!=='trigger'&&pending.confirmed?'teloa.plan-command/v2':'teloa.plan-command/v1',request:pending}))
   if(pending.kind==='create'){
    const command=pending,result=readSavedPlan(await reject(()=>call(command.confirmed?'plans/create-confirmed':'plans/create',{requestId:command.requestId,fields:command.fields,source:command.source})))
    if(fixed(result)!==fixedCreation(command.fields,command.source,result.createdAt)||result.configVersion!==1)throw Error('计划创建响应与原请求不一致，已保留恢复请求。')
    owned([result])
    clear();return result as T
   }
   if(pending.kind==='configure-work'){
    const command=pending,receipt=readSavedPlan(await reject(()=>call('plans/configure-work-confirmed',{planId:command.planId,requestId:command.requestId,expectedVersion:command.expectedVersion,expectedConfigVersion:command.expectedConfigVersion,configuration:command.configuration,...(command.fields?{fields:command.fields}:{})})))
    const work=receipt.workDefinition
    if(!work||receipt.id!==command.planId||receipt.version!==command.expectedVersion+1||receipt.configVersion!==command.expectedConfigVersion+1||receipt.state!=='paused'||command.fields&&Object.entries(command.fields).some(([key,value])=>receipt[key as 'title']!==value)||!same(readPlanWorkConfiguration({completion:work.completion,triggers:work.triggers,budget:work.budget,overlap:work.overlap,missed:work.missed,safeRecovery:work.safeRecovery}),command.configuration))throw Error('长期工作定义回执与本人确认不一致，已保留恢复请求。')
    const current=readSavedPlan(await call('plans/get',{planId:command.planId}));if(current.id!==receipt.id||current.version<receipt.version||fixed(current)!==fixed(receipt))throw Error('长期工作刷新与原回执不一致。');owned([receipt,current]);clear();return current as T
   }
   if(pending.kind==='update'){
    const command=pending,receipt=readSavedPlan(await reject(()=>call(command.confirmed?'plans/change-confirmed':'plans/change',{planId:command.planId,requestId:command.requestId,expectedVersion:command.expectedVersion,expectedConfigVersion:command.expectedConfigVersion,action:'update',fields:command.fields})))
    const matches=receipt.title===command.fields.title&&receipt.goal===command.fields.goal&&receipt.dataScope===command.fields.dataScope&&receipt.delivery===command.fields.delivery&&JSON.stringify(receipt.trigger)===JSON.stringify(command.fields.trigger)&&receipt.notificationPolicy===command.fields.notificationPolicy&&(command.fields.completionPolicy===undefined||JSON.stringify(receipt.completionPolicy)===JSON.stringify(command.fields.completionPolicy))
    if(receipt.id!==command.planId||receipt.version!==command.expectedVersion+1||receipt.configVersion!==command.expectedConfigVersion+1||receipt.state!==command.expectedState||!matches||receipt.archivedReason!==null)throw Error('计划更新回执与原请求不一致，已保留恢复请求。')
    const current=readSavedPlan(await call('plans/get',{planId:command.planId}))
    if(current.id!==command.planId||current.version<receipt.version||fixed(current)!==fixed(receipt)||current.version===receipt.version&&JSON.stringify(current)!==JSON.stringify(receipt))throw Error('计划刷新结果与更新回执不一致，已保留恢复请求。')
    owned([receipt,current]);clear();return current as T
   }
   if(pending.kind==='trigger'){
    const command=pending,result=readTriggerResult(await reject(()=>call('plans/trigger',{planId:command.planId,requestId:command.requestId,expectedVersion:command.expectedVersion,expectedConfigVersion:command.expectedConfigVersion,now:command.now})),command)
    clear();return result as T
   }
   const command=pending,target=command.action==='enable'?'active':command.action==='pause'?'paused':'archived'
   const receipt=readSavedPlan(await reject(()=>call(command.confirmed?'plans/change-confirmed':'plans/change',{planId:command.planId,requestId:command.requestId,expectedVersion:command.expectedVersion,action:command.action,...(command.note?{note:command.note}:{})})))
   if(receipt.id!==command.planId||receipt.version!==command.expectedVersion+1||receipt.state!==target||receipt.archivedReason!==(command.action==='archive'?command.note!:null))throw Error('计划状态回执与原请求不一致，已保留恢复请求。')
   const current=readSavedPlan(await call('plans/get',{planId:command.planId}))
   if(current.id!==command.planId||current.version<receipt.version||fixed(current)!==fixed(receipt)||current.version===receipt.version&&JSON.stringify(current)!==JSON.stringify(receipt))throw Error('计划刷新结果与状态回执不一致，已保留恢复请求。')
   owned([receipt,current])
   clear();return current as T
  }finally{busy=false}
 }
 const prepareCreate=async(fields:PlanCreateFields,source:PlanSource,confirmed:boolean)=>{
   if(recoveryError)throw recoveryError
   const proposed:PlanCommand={kind:'create',requestId:pending?.kind==='create'?pending.requestId:newId(),fields:readFields(fields,true) as PlanCreateFields,source:readSource(source),...(confirmed?{confirmed:true as const}:{})}
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再创建其他计划。')
   pending??=proposed;return send()
 }
 const prepareChange=async(planId:string,expectedVersion:number,action:PlanAction,note:string|undefined,confirmed:boolean)=>{
   if(recoveryError)throw recoveryError
   const proposed=readChange({kind:'change',planId,requestId:pending?.kind==='change'?pending.requestId:newId(),expectedVersion,action,...(note===undefined?{}:{note}),...(confirmed?{confirmed:true as const}:{})})
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再执行其他计划操作。')
   pending??=proposed;return send()
 }
 const prepareUpdate=async(plan:SavedPlan,fields:PlanUpdateFields,confirmed:boolean)=>{
   if(recoveryError)throw recoveryError
   const proposed=readUpdate({kind:'update',planId:plan.id,requestId:pending?.kind==='update'?pending.requestId:newId(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,expectedState:plan.state,fields,...(confirmed?{confirmed:true as const}:{})})
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再更新其他持续计划。')
   pending??=proposed;return send()
 }

 return {
  pending:()=>pending?structuredClone(pending):undefined,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:()=>{if(pending?.kind==='trigger')throw Error('请在当前计划中核对立即运行请求。');return send()},
  recoverTrigger:async()=>{if(pending?.kind!=='trigger')throw Error('没有待核对的立即运行请求。');return await send<PlanTriggerResult>()},
  async list(){const value=await call('plans/list',{});if(!Array.isArray(value))throw Error('持续计划目录格式不正确。');const rows=value.map(readSavedPlan);if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('持续计划目录格式不正确：包含重复身份。');owned(rows);return rows},
  async get(planId:string){if(!uuid(planId))throw Error('持续计划身份格式不正确。');const result=readSavedPlan(await call('plans/get',{planId}));if(result.id!==planId)throw Error('持续计划详情与目标身份不一致。');owned([result]);return result},
  async schedule(planId:string){if(!uuid(planId))throw Error('持续计划身份格式不正确。');return readPlanScheduleSummary(await call('plans/schedule',{planId}),planId)},
  async executions(planId:string,limit=20,cursor?:PlanExecutionHistoryCursor){
   if(!uuid(planId))throw Error('持续计划身份格式不正确。')
   if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('持续计划执行历史分页参数不正确。')
   if(cursor&&(!date(cursor.claimedAt)||!uuid(cursor.claimId)))throw Error('持续计划执行历史分页参数不正确。')
   return readPlanExecutionHistoryPage(await call('plans/executions',{planId,limit,...(cursor?{cursor}:{})}),planId,{limit,...(cursor?{cursor}:{})})
  },
  async directory(input:PlanExecutionDirectoryInput){
   const query=input.query?.trim()
   if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50)throw Error('持续计划执行历史分页参数不正确。')
   if(input.cursor&&(!date(input.cursor.claimedAt)||!uuid(input.cursor.claimId)))throw Error('持续计划执行历史分页参数不正确。')
   if(input.scope!==undefined&&!/^[a-zA-Z0-9_-]{1,128}$/.test(input.scope)||input.roleId!==undefined&&!uuid(input.roleId)||query!==undefined&&query.length>240||input.runState!==undefined&&!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed','not-started'].includes(input.runState))throw Error('持续计划执行目录筛选参数不正确。')
   const payload={limit:input.limit,...(input.cursor?{cursor:input.cursor}:{}),...(input.scope?{scope:input.scope}:{}),...(input.roleId?{roleId:input.roleId}:{}),...(query?{query}:{}),...(input.runState?{runState:input.runState}:{})}
   return readPlanExecutionDirectoryPage(await call('plans/executions',payload),{limit:input.limit,...(input.cursor?{cursor:input.cursor}:{}),...(input.runState?{runState:input.runState}:{})})
  },
  async skips(planId:string,limit=20,cursor?:PlanSkipHistoryCursor){
   if(!uuid(planId))throw Error('持续计划身份格式不正确。')
   if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('持续计划跳过记录分页参数不正确。')
   if(cursor&&(!date(cursor.skippedAt)||!positive(cursor.configVersion)||cursor.configVersion>2147483647||typeof cursor.occurrenceId!=='string'||cursor.occurrenceId.length>100||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(cursor.occurrenceId)))throw Error('持续计划跳过记录分页参数不正确。')
   return readPlanSkipHistoryPage(await call('plans/skips',{planId,limit,...(cursor?{cursor}:{})}),planId,{limit,...(cursor?{cursor}:{})})
  },
  async configureWorkConfirmed(plan:SavedPlan,configuration:PlanWorkConfiguration,fields?:PlanWorkEditFields):Promise<SavedPlan>{
   if(recoveryError)throw recoveryError
   const proposed=readCommand({kind:'configure-work',planId:plan.id,requestId:pending?.kind==='configure-work'?pending.requestId:newId(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,configuration,...(fields?{fields}:{}),confirmed:true})
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原长期工作请求。');pending??=proposed;return send()
  },
  create:(fields:PlanCreateFields,source:PlanSource)=>prepareCreate(fields,source,false),
  createConfirmed:(fields:PlanCreateFields,source:PlanSource)=>prepareCreate(fields,source,true),
  change:(planId:string,expectedVersion:number,action:PlanAction,note?:string)=>prepareChange(planId,expectedVersion,action,note,false),
  changeConfirmed:(planId:string,expectedVersion:number,action:PlanAction,note?:string)=>prepareChange(planId,expectedVersion,action,note,true),
  update:(plan:SavedPlan,fields:PlanUpdateFields)=>prepareUpdate(plan,fields,false),
  updateConfirmed:(plan:SavedPlan,fields:PlanUpdateFields)=>prepareUpdate(plan,fields,true),
  async trigger(plan:SavedPlan,now:string):Promise<PlanTriggerResult>{
   if(recoveryError)throw recoveryError
   const proposed=readTrigger({kind:'trigger',planId:plan.id,requestId:pending?.kind==='trigger'?pending.requestId:newId(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now})
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再立即运行其他持续计划。')
   pending??=proposed
   return await send<PlanTriggerResult>()
  },
 }
}

export function projectSavedPlan(plan:SavedPlan):ContinuousPlan{
 // 业务范围已是空间内的标签（内置取值或模板 `domain`），不再是 `space-<id>`：只核对 1–80 的标签文本。
 if(typeof plan.scope!=='string'||!plan.scope.trim()||plan.scope.length>80)throw Error('持续计划包含当前界面无法识别的业务身份。')
 return {id:plan.id,version:plan.configVersion,revision:plan.version,fields:{title:plan.title,goal:plan.goal,scope:plan.scope as CollaborationScope,dataScope:plan.dataScope,delivery:plan.delivery,roleId:plan.roleId,trigger:{...plan.trigger},...(plan.notificationPolicy===undefined?{}:{notificationPolicy:plan.notificationPolicy}),...(plan.completionPolicy===undefined?{}:{completionPolicy:plan.completionPolicy})},enabled:plan.state==='active',archived:plan.state==='archived',history:[]}
}
