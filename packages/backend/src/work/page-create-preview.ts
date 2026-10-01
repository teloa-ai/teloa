import type {Pool} from 'pg'
import {
 WorkError,pageCreateFieldRows,pageCreateLimits,readMarketPluginRegistrySource,readPageCreateBody,taskInput,
 type MarketPluginPermissionSummary,type PageCreateDraftPreview,type PageCreateEntity,
} from '@teloa/contract'
import {validateManifest} from '../market/content-store.ts'
import type {PageCreateActor,PageCreateDraftService,PageCreateReaders} from './page-create-drafts.ts'

type BusinessPreviewPort={preview:(actor:{ownerId:string;scopeIds:string[]},input:unknown,signal?:AbortSignal)=>Promise<unknown>}
type ExtensionPreviewPort={preview:(source:{registry:'npm';packageName:string;version:string},signal?:AbortSignal)=>Promise<{permissionSummary:MarketPluginPermissionSummary}>}

const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)
const unavailable=(message:string)=>new WorkError('teloa/dependency-unavailable',message)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

function actorValue(actor:PageCreateActor):void{
 if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)||scope==='general'))throw forbidden('需要有效的本人身份与业务范围。')
}

const next:Record<PageCreateEntity,{endpoint:string;consentKeys:string[]}>= {
 'business-definition':{endpoint:'business-definitions/apply',consentKeys:[]},
 'business-domain':{endpoint:'market-content/import-industry',consentKeys:[]},
 role:{endpoint:'roles/create',consentKeys:[]},
 skill:{endpoint:'market-content/import-atomic',consentKeys:[]},
 connector:{endpoint:'market-content/import-industry',consentKeys:['create.consequence.credential','create.consequence.egress']},
 extension:{endpoint:'industry-plugins/preview',consentKeys:['create.consequence.permission']},
}

/**
 * 页内新建的只读预览。实体永远由既有写路径在用户再次确认后创建；这里仅从已存草案生成
 * "要建什么 / 会带来什么 / 下一步"，并用数据库只读事务阻断任何意外写入。
 */
export class PageCreatePreviewService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly drafts:Pick<PageCreateDraftService,'draftInTransaction'>
 private readonly readers:PageCreateReaders
 private readonly businessPreview:BusinessPreviewPort|undefined
 private readonly extensionPreview:ExtensionPreviewPort|undefined
 constructor(pool:Pool,identity:{now:()=>string},drafts:Pick<PageCreateDraftService,'draftInTransaction'>,businessPreview?:BusinessPreviewPort,extensionPreview?:ExtensionPreviewPort,readers:PageCreateReaders={}){
  this.pool=pool;this.identity=identity;this.drafts=drafts;this.businessPreview=businessPreview;this.extensionPreview=extensionPreview;this.readers={manifest:validateManifest,...readers}
 }

 async preview(actor:PageCreateActor,input:unknown,signal?:AbortSignal):Promise<PageCreateDraftPreview>{
  actorValue(actor)
  const row=taskInput(input,['draftId'])
  if(!uuid(row.draftId))throw new WorkError('teloa/invalid-input','新建草案预览请求格式不正确。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const draft=await this.drafts.draftInTransaction(db,actor.ownerId,row.draftId as string)
   // 业务范围要加载后才登记；business-domain 与 directory/settle 同一口径，不核对「本人已获准范围」。
   if(draft.entity!=='business-domain'&&draft.scope!==undefined&&!actor.scopeIds.includes(draft.scope))throw forbidden('当前主体未获准预览此业务范围的新建草案。')
   if(draft.status!=='draft')throw conflict('新建草案已经落定，不再预览。')
   let body:unknown
   try{body=readPageCreateBody(draft.entity,JSON.parse(draft.body),this.readers)}catch(error){
    if(error instanceof WorkError&&error.code==='teloa/dependency-unavailable')throw error
    throw corrupt('新建草案「'+draft.id+'」的正文已损坏，无法预览。')
   }
   signal?.throwIfAborted()
   const fields=pageCreateFieldRows(body),fieldsTruncated=fields.length>pageCreateLimits.fieldRows
   const rule=next[draft.entity]
   let consequences=consequencesOf(draft.entity,body)
   if(draft.entity==='extension'){
    if(!this.extensionPreview)throw unavailable('扩展权限摘要尚不可用，不能省略权限预览。')
    const source=readMarketPluginRegistrySource(body)
    const result=await this.extensionPreview.preview(source,signal)
    consequences=[...result.permissionSummary.permissions.map(permission=>({kind:'permission' as const,id:permission.id,required:permission.required})),{kind:'impact' as const,id:'extension-enable',required:true}]
   }
   if(consequences.length>pageCreateLimits.consequences)throw corrupt('新建草案预览的影响项超出上限。')
   let businessPreview:PageCreateDraftPreview['businessPreview']|undefined
   if(draft.entity==='business-definition'){
    if(!this.businessPreview)throw unavailable('业务定制预览服务尚未接入。')
    businessPreview=await this.businessPreview.preview(actor,{draftId:draft.id,body:draft.body,scope:draft.scope},signal) as PageCreateDraftPreview['businessPreview']
   }
   await db.query('commit')
   return {
    schema:'teloa.page-create-draft-preview/v1',draft,
    fields:fields.slice(0,pageCreateLimits.fieldRows),fieldsTruncated,consequences,
    next:rule,computedAt:this.identity.now(),...(businessPreview===undefined?{}:{businessPreview}),
   }
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
}

function consequencesOf(entity:PageCreateEntity,body:unknown):PageCreateDraftPreview['consequences']{
 if(entity==='connector'){
  const resource=(body as {resource?:{sourceId?:string;serverName?:string}}).resource
  const id=resource?.sourceId??resource?.serverName
  return [{kind:'credential',id:'credential',required:true},{kind:'egress',id:id??'connector',required:true}]
 }
 const impact:Record<Exclude<PageCreateEntity,'connector'|'extension'>,string>={
  'business-definition':'business-definition-customization','business-domain':'business-scope-registration',role:'role-onboarding',skill:'skill-directory-only',
 }
 return [{kind:'impact',id:impact[entity as Exclude<PageCreateEntity,'connector'|'extension'>],required:true}]
}
