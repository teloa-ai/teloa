import {
 pageCreateEntities,pageCreateLimits,readPageCreateBody,
 type BusinessDefinitionPreview,type PageCreateDraft,type PageCreateDraftDirectory,type PageCreateDraftPreview,type PageCreateEntity,
} from '@teloa/contract'
import {validateIndustryManifest} from './industry-manifest.ts'
import {catalogs} from './i18n/messages.ts'

type Call=(method:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

export type PageCreateDirectoryRequest={entity:PageCreateEntity;scope?:string}
export type PageCreateSettleRequest={requestId:string;draftId:string;expectedBodyHash:string;outcome:'applied'|'discarded';appliedRef?:string}
/** 尚未装配的 Skill 正文与第二期预览只能由真实读取器接入，缺省时不作强制类型转换。 */
export type PageCreateResponseReaders={
 skill?:(value:unknown)=>unknown
 businessPreview?:(value:unknown)=>BusinessDefinitionPreview
}

/** 回包读不出来只说一句「形状不一致」：内部错误码与原始 message 都不进界面（与 `business-ledger-api.ts` 同一条）。 */
function invalid(message='页内新建草案的回包形状不一致。'):Error{return Object.assign(Error(message),{code:'teloa/invalid-host-response'})}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
/** 缺一个必填键、多一个没约定的键都算读不出来：回包键集只认契约里写下的那一套。 */
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!isRecord(value))throw invalid()
 if(required.some(key=>!Object.hasOwn(value,key)))throw invalid()
 if(Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw invalid()
 return value
}
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const scopeName=(value:unknown):value is string=>text(value,120)&&value!=='general'
const consequenceKinds=['permission','egress','credential','impact'] as const
/** 逐字的既有端点名，形如 `roles/create`：回包里出现别的形状说明这一块不是本期算的。 */
const endpointName=/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/
/** 词条键形态，形如 `create.next.consent`：`consentKeys` 只回词条键（规格 §五第 5 条）。 */
const messageKey=/^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/

/**
 * 一条草案。`bodyHash` 这里不重算：摘要口径归后端那一层（本期 T2），客户端重算一份迟早与它漂开。
 * 能核的照核到底——正文必须是能解析的 JSON 且不超上限，两态与 `appliedRef` 必须一致：
 * `status:'draft'` 带着 `appliedRef` 说明写库那一侧把「草案」与「已落地」混成了一态。
 */
function draft(value:unknown,readers:PageCreateResponseReaders):PageCreateDraft{
 const row=exact(value,['id','ownerId','requestId','entity','body','bodyHash','title','status','createdAt','updatedAt'],['scope','appliedRef'])
 if(!text(row.id,200)||!text(row.ownerId,200)||!text(row.requestId,200))throw invalid()
 if(!(pageCreateEntities as readonly string[]).includes(String(row.entity)))throw invalid()
 if(row.scope!==undefined&&!scopeName(row.scope))throw invalid()
 if(typeof row.body!=='string'||!row.body.trim()||new TextEncoder().encode(row.body).byteLength>pageCreateLimits.bodyBytes)throw invalid()
 try{readPageCreateBody(row.entity as PageCreateEntity,JSON.parse(row.body),{manifest:validateIndustryManifest,...(readers.skill?{skill:readers.skill}:{})})}catch{throw invalid()}
 if(!hash(row.bodyHash)||!text(row.title,240))throw invalid()
 if(row.status!=='draft'&&row.status!=='applied'&&row.status!=='discarded')throw invalid()
 if(!stamp(row.createdAt)||!stamp(row.updatedAt)||String(row.updatedAt)<String(row.createdAt))throw invalid()
 if(row.appliedRef!==undefined&&!text(row.appliedRef,200))throw invalid()
 if((row.status==='applied')!==(row.appliedRef!==undefined))throw invalid()
 return {
  id:row.id,ownerId:row.ownerId,requestId:row.requestId,entity:row.entity as PageCreateEntity,
  ...(row.scope===undefined?{}:{scope:row.scope as string}),
  body:row.body,bodyHash:row.bodyHash,title:row.title,status:row.status as PageCreateDraft['status'],
  createdAt:row.createdAt,updatedAt:row.updatedAt,
  ...(row.appliedRef===undefined?{}:{appliedRef:row.appliedRef as string}),
 }
}

/**
 * 一份草案目录。`expected` 给了就逐字比对实体与范围：一份混着别的实体的目录不是这一页要读的那份，
 * 与其在界面上摆几条不属于这里的草案，不如整条拒收（规格 §五第 7 条）。
 */
export function readPageCreateDraftDirectory(value:unknown,expected?:PageCreateDirectoryRequest,readers:PageCreateResponseReaders={}):PageCreateDraftDirectory{
 const row=exact(value,['schema','entity','readAt','drafts'],['scope'])
 if(row.schema!=='teloa.page-create-drafts/v1')throw invalid()
 if(!(pageCreateEntities as readonly string[]).includes(String(row.entity)))throw invalid()
 if(row.scope!==undefined&&!scopeName(row.scope))throw invalid()
 if(expected&&(row.entity!==expected.entity||row.scope!==expected.scope))throw invalid()
 if(!stamp(row.readAt))throw invalid()
 if(!Array.isArray(row.drafts)||row.drafts.length>pageCreateLimits.draftsPerEntity)throw invalid()
 const drafts=row.drafts.map(value=>draft(value,readers))
 if(new Set(drafts.map(item=>item.id)).size!==drafts.length)throw invalid()
 if(drafts.some(item=>item.entity!==row.entity||item.scope!==row.scope))throw invalid()
 return {
  schema:'teloa.page-create-drafts/v1',entity:row.entity as PageCreateEntity,
  ...(row.scope===undefined?{}:{scope:row.scope as string}),
  readAt:row.readAt,drafts,
 }
}

/**
 * 预览三块。第二期预览复用注入的真实读取器；尚未接入时明确拒收，不能把只有 schema 的对象伪装成完整预览。
 */
export function readPageCreateDraftPreview(value:unknown,readers:PageCreateResponseReaders={}):PageCreateDraftPreview{
 const row=exact(value,['schema','draft','fields','fieldsTruncated','consequences','next','computedAt'],['businessPreview'])
 if(row.schema!=='teloa.page-create-draft-preview/v1')throw invalid()
 const record=draft(row.draft,readers)
 if(!Array.isArray(row.fields)||row.fields.length>pageCreateLimits.fieldRows||typeof row.fieldsTruncated!=='boolean')throw invalid()
 const fields=row.fields.map(item=>{
  const field=exact(item,['path','value'])
  // 叶子取值是 `JSON.stringify` 的输出（契约注释），因此允许空串之外的一切文本，但不许有控制字符。
  if(!text(field.path,400)||!text(field.value,pageCreateLimits.bodyBytes,true))throw invalid()
  return {path:field.path,value:field.value}
 })
 if(new Set(fields.map(field=>field.path)).size!==fields.length)throw invalid()
 if(!Array.isArray(row.consequences)||row.consequences.length>pageCreateLimits.consequences)throw invalid()
 const consequences=row.consequences.map(item=>{
  const entry=exact(item,['kind','id','required'])
  if(!(consequenceKinds as readonly string[]).includes(String(entry.kind))||!text(entry.id,200)||typeof entry.required!=='boolean')throw invalid()
  return {kind:entry.kind as typeof consequenceKinds[number],id:entry.id,required:entry.required}
 })
 if(new Set(consequences.map(entry=>entry.kind+'\0'+entry.id)).size!==consequences.length)throw invalid()
 const next=exact(row.next,['endpoint','consentKeys'])
 if(!text(next.endpoint,200)||!endpointName.test(next.endpoint))throw invalid()
 if(!Array.isArray(next.consentKeys)||next.consentKeys.length>pageCreateLimits.consequences)throw invalid()
 if(next.consentKeys.some(key=>!text(key,200)||!messageKey.test(key)||!Object.hasOwn(catalogs['zh-CN'],key)))throw invalid()
 if(new Set(next.consentKeys as string[]).size!==next.consentKeys.length)throw invalid()
 if(!stamp(row.computedAt))throw invalid()
 if(record.entity==='business-definition'&&row.businessPreview===undefined)throw invalid()
 let businessPreview:BusinessDefinitionPreview|undefined
 if(row.businessPreview!==undefined){
  if(record.entity!=='business-definition'||!readers.businessPreview)throw invalid()
  try{businessPreview=readers.businessPreview(row.businessPreview)}catch{throw invalid()}
 }
 return {
  schema:'teloa.page-create-draft-preview/v1',draft:record,fields,fieldsTruncated:row.fieldsTruncated,consequences,
  next:{endpoint:next.endpoint,consentKeys:[...next.consentKeys as string[]]},
  ...(businessPreview===undefined?{}:{businessPreview}),
  computedAt:row.computedAt,
 }
}

/** 只提交契约白名单字段：多一个键都不往宿主递。`general` 不是本人已登记范围，一律不提交。 */
function directoryInput(input:PageCreateDirectoryRequest):PageCreateDirectoryRequest{
 if(!(pageCreateEntities as readonly string[]).includes(String(input.entity)))throw Error('需要明确的新建对象类别。')
 if(input.scope!==undefined&&!scopeName(input.scope))throw Error('业务范围不合法。')
 return {entity:input.entity,...(input.scope===undefined?{}:{scope:input.scope})}
}

/**
 * 落定入参。`expectedBodyHash` 必须是预览回包里那一个（`createConfirmGuard` 给的），
 * 丢弃则不许带 `appliedRef`——丢弃没有落地物，带着它说明调用方把两条路混了。
 */
function settleInput(input:PageCreateSettleRequest):PageCreateSettleRequest{
 if(!text(input.requestId,200)||!text(input.draftId,200)||!hash(input.expectedBodyHash))throw Error('落定草案的入参不合法。')
 if(input.outcome!=='applied'&&input.outcome!=='discarded')throw Error('落定草案的结果只有已建好与已丢弃两种。')
 if(input.appliedRef!==undefined&&!text(input.appliedRef,200))throw Error('落地物标识不合法。')
 if(input.outcome==='applied'&&input.appliedRef===undefined)throw Error('已建好的草案必须带落地物标识。')
 if(input.outcome==='discarded'&&input.appliedRef!==undefined)throw Error('丢弃草案不带落地物标识。')
 return {
  requestId:input.requestId,draftId:input.draftId,expectedBodyHash:input.expectedBodyHash,outcome:input.outcome,
  ...(input.appliedRef===undefined?{}:{appliedRef:input.appliedRef}),
 }
}

/**
 * 三个端点的客户端一侧。`settle` 只管草案状态、不担保生效（D8）：既有写路径成功之后才调它，
 * 那条写路径失败时草案留在 `draft`，这一点不许被当成第二道生效闸。
 */
export function createPageCreateApi(call:Call,readers:PageCreateResponseReaders={}){
 return {
  async directory(input:PageCreateDirectoryRequest,signal?:AbortSignal):Promise<PageCreateDraftDirectory>{
   const payload=directoryInput(input)
   return readPageCreateDraftDirectory(await call('page-create-drafts/directory',payload,signal),payload,readers)
  },
  async preview(input:{draftId:string},signal?:AbortSignal):Promise<PageCreateDraftPreview>{
   if(!text(input.draftId,200))throw Error('需要明确的草案标识。')
   const value=readPageCreateDraftPreview(await call('page-create-drafts/preview',{draftId:input.draftId},signal),readers)
   if(value.draft.id!==input.draftId)throw invalid()
   return value
  },
  async settle(input:PageCreateSettleRequest,signal?:AbortSignal):Promise<PageCreateDraftDirectory>{
   return readPageCreateDraftDirectory(await call('page-create-drafts/settle',settleInput(input),signal),undefined,readers)
  },
 }
}

export type PageCreateApi=ReturnType<typeof createPageCreateApi>
