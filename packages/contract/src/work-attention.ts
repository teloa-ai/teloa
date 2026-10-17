import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {pageCreateEntities,type PageCreateEntity} from './page-create.ts'

/** 「需要你」只读聚合单页上限。 */
export const workAttentionPageLimit=50

/**
 * 待办的真源身份与真实依据。草稿没有修订号，依据是存储的正文摘要 bodyHash（与原计划写的 revision 不同，不另造版本）。
 * 工作进展并入原任务，不另成来源；安全案件沿用原 Attention，不进入此目录。
 */
export type WorkAttentionSource=
 |{kind:'task';taskId:string;version:number}
 |{kind:'business-change-set';scope:string;changeSetId:string;revision:number;digest:string}
 |{kind:'business-sync';scope:string;mappingId:string;runId:string}
 |{kind:'page-create-draft';entity:PageCreateEntity;scope?:string;draftId:string;bodyHash:string}

/** 只允许回到已知原对象的类型化路由；客户端不执行任何 URL。 */
export type WorkAttentionTarget=
 |{kind:'task';taskId:string}
 |{kind:'business-change-set';scope:string;changeSetId:string}
 |{kind:'business-sync';scope:string;mappingId:string}
 |{kind:'page-create-draft';draftId:string}

export type WorkAttentionKind='approval'|'error'|'review'
export const workAttentionReasons=['task-blocked','execution-failed','execution-configuration-failed','execution-completed','task-waiting','business-change-review','business-change-stale','business-sync-failed','page-create-draft-pending'] as const
export type WorkAttentionReason=typeof workAttentionReasons[number]

export type WorkAttentionItem={
 id:string;kind:WorkAttentionKind;reason:WorkAttentionReason;title:string
 /** 无业务范围的页内草稿（员工、技能、扩展、分享）缺省。 */
 scope?:string
 occurredAt:string;source:WorkAttentionSource;target:WorkAttentionTarget
 /** 来源身份与真实依据的摘要；依据改变才改变。 */
 basisHash:string
}

export type WorkAttentionSourceKind=WorkAttentionSource['kind']
/** 来源读不全时显式标出，不把截断或读取失败伪装成「没有待办」。 */
export type WorkAttentionIncomplete={source:WorkAttentionSourceKind|'business-scope';scope?:string;reason:'page-limit'|'unavailable'}

export type WorkAttentionPage={schema:'teloa.work-attention/v1';items:WorkAttentionItem[];nextCursor?:string;incomplete:WorkAttentionIncomplete[]}

const invalid=()=>new WorkError('teloa/invalid-host-response','需要你目录返回了无效待办或来源。')
const text=(value:unknown,max=240):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw invalid()
 return value
}

function readSource(value:unknown):WorkAttentionSource{
 const kind=isRecord(value)?value.kind:undefined
 if(kind==='task'){const row=exact(value,['kind','taskId','version']);if(!uuid(row.taskId)||!positive(row.version))throw invalid();return row as WorkAttentionSource}
 if(kind==='business-change-set'){const row=exact(value,['kind','scope','changeSetId','revision','digest']);if(!text(row.scope,120)||!text(row.changeSetId,128)||!positive(row.revision)||!digest(row.digest))throw invalid();return row as WorkAttentionSource}
 if(kind==='business-sync'){const row=exact(value,['kind','scope','mappingId','runId']);if(!text(row.scope,120)||!text(row.mappingId,128)||!text(row.runId,128))throw invalid();return row as WorkAttentionSource}
 if(kind==='page-create-draft'){const row=exact(value,['kind','entity','draftId','bodyHash'],['scope']);if(!pageCreateEntities.includes(row.entity as PageCreateEntity)||!uuid(row.draftId)||!digest(row.bodyHash)||(row.scope!==undefined&&!text(row.scope,120)))throw invalid();return row as WorkAttentionSource}
 throw invalid()
}

/** 目标必须与来源指向同一原对象，防止来源与路由被拼接错位。 */
function readTarget(value:unknown,source:WorkAttentionSource):WorkAttentionTarget{
 if(source.kind==='task'){const row=exact(value,['kind','taskId']);if(row.kind!=='task'||row.taskId!==source.taskId)throw invalid();return row as WorkAttentionTarget}
 if(source.kind==='business-change-set'){const row=exact(value,['kind','scope','changeSetId']);if(row.kind!==source.kind||row.scope!==source.scope||row.changeSetId!==source.changeSetId)throw invalid();return row as WorkAttentionTarget}
 if(source.kind==='business-sync'){const row=exact(value,['kind','scope','mappingId']);if(row.kind!==source.kind||row.scope!==source.scope||row.mappingId!==source.mappingId)throw invalid();return row as WorkAttentionTarget}
 const row=exact(value,['kind','draftId']);if(row.kind!==source.kind||row.draftId!==source.draftId)throw invalid();return row as WorkAttentionTarget
}

const sourceKinds:readonly WorkAttentionIncomplete['source'][]=['task','business-change-set','business-sync','page-create-draft','business-scope']

function assertSourcePresentation(source:WorkAttentionSource,item:Record<string,unknown>):void{
 if(source.kind!=='task'&&item.scope!==source.scope)throw invalid()
 const expectedKind:Partial<Record<WorkAttentionReason,WorkAttentionKind>>=source.kind==='task'
  ?{'task-blocked':'error','execution-failed':'error','execution-configuration-failed':'error','execution-completed':'review','task-waiting':'review'}
  :source.kind==='business-change-set'?{'business-change-review':'approval','business-change-stale':'error'}
  :source.kind==='business-sync'?{'business-sync-failed':'error'}
  :{'page-create-draft-pending':'review'}
 if(expectedKind[item.reason as WorkAttentionReason]!==item.kind)throw invalid()
}

/** 宿主回读：拒绝多余字段、重复待办、无依据摘要与错位目标。 */
export function readWorkAttentionPage(value:unknown):WorkAttentionPage{
 const page=exact(value,['schema','items','incomplete'],['nextCursor'])
 if(page.schema!=='teloa.work-attention/v1'||!Array.isArray(page.items)||page.items.length>workAttentionPageLimit||!Array.isArray(page.incomplete)||(page.nextCursor!==undefined&&!text(page.nextCursor,512)))throw invalid()
 const ids=new Set<string>()
 for(const value of page.items){
  const item=exact(value,['id','kind','reason','title','occurredAt','source','target','basisHash'],['scope'])
  const source=readSource(item.source);readTarget(item.target,source)
  if(!text(item.id,300)||ids.has(item.id)||!['approval','error','review'].includes(item.kind as string)||!workAttentionReasons.includes(item.reason as WorkAttentionReason)||!text(item.title)||!timestamp(item.occurredAt)||!digest(item.basisHash)||(item.scope!==undefined&&!text(item.scope,120)))throw invalid()
  assertSourcePresentation(source,item)
  ids.add(item.id)
 }
 for(const value of page.incomplete){const row=exact(value,['source','reason'],['scope']);if(!sourceKinds.includes(row.source as WorkAttentionSourceKind)||(row.reason!=='page-limit'&&row.reason!=='unavailable')||(row.scope!==undefined&&!text(row.scope,120)))throw invalid()}
 return page as WorkAttentionPage
}
