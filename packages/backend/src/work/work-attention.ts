import {createHash} from 'node:crypto'
import {WorkError,workAttentionPageLimit,type BusinessChangeSet,type BusinessSyncStatus,type BusinessWorkCursor,type BusinessWorkPage,type PageCreateDraft} from '@teloa/contract'
// 仅类型导入：契约运行时校验由宿主回读使用，后端不依赖 index 导出即可运行。
import type {WorkAttentionIncomplete,WorkAttentionItem,WorkAttentionKind,WorkAttentionPage,WorkAttentionReason,WorkAttentionSource,WorkAttentionTarget} from '@teloa/contract'
import type {TaskAttentionPage} from './task-attention.ts'

type Actor={ownerId:string;scopeIds:string[]}
/** 只注入现有真源的只读接口；不含任何批准、采用、拒绝、落定或停止能力。 */
export type WorkAttentionPorts={
 scopes:(ownerId:string,input:{scope?:string})=>Promise<{scopeIds:readonly string[];truncated:boolean}>
 tasks:{list:(ownerId:string,input:Record<string,never>)=>Promise<TaskAttentionPage>}
 changeSets:{listPage:(actor:Actor,input:{scope:string;cursor?:BusinessWorkCursor})=>Promise<BusinessWorkPage<BusinessChangeSet,BusinessWorkCursor>>}
 sync:{status:(actor:Actor,scope:string)=>Promise<BusinessSyncStatus[]>}
 drafts:{pendingForAttention:(actor:Actor)=>Promise<{drafts:PageCreateDraft[];truncated:boolean}>}
}
export type WorkAttentionQuery={scope?:string;cursor?:string;limit?:number}

const pageLimit=workAttentionPageLimit
/** 每个业务范围最多读 5 页业务修改（每页 20 条），超出显式标记不完整。 */
const changeSetPages=5
const priorities:Record<WorkAttentionKind,number>={approval:0,error:1,review:2}
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max

function item(id:string,kind:WorkAttentionKind,reason:WorkAttentionReason,title:string,scope:string|undefined,occurredAt:string,source:WorkAttentionSource,target:WorkAttentionTarget):WorkAttentionItem{
 return {id,kind,reason,title,...(scope===undefined?{}:{scope}),occurredAt,source,target,basisHash:hash([id,kind,reason,source])}
}

type Key=[number,string,string]
const keyOf=(row:WorkAttentionItem):Key=>[priorities[row.kind],row.occurredAt,row.id]
/** 优先级升序、发生时间降序、标识升序。 */
const compare=(a:Key,b:Key)=>a[0]-b[0]||b[1].localeCompare(a[1])||a[2].localeCompare(b[2])
const encodeCursor=(key:Key)=>Buffer.from(JSON.stringify(key)).toString('base64url')
function decodeCursor(value:unknown):Key{
 try{
  const key=JSON.parse(Buffer.from(String(value),'base64url').toString()) as unknown
  if(Array.isArray(key)&&key.length===3&&Object.values(priorities).includes(key[0])&&text(key[1],40)&&text(key[2],300))return key as Key
 }catch{/* 统一按无效游标处理 */}
 throw invalid('需要你目录的翻页位置无效，请从第一页重新读取。')
}

function readQuery(value:unknown):{scope?:string;cursor?:Key;limit:number}{
 if(typeof value!=='object'||value===null||Array.isArray(value)||Object.keys(value).some(key=>!['scope','cursor','limit'].includes(key)))throw invalid('需要你目录的查询格式不正确。')
 const row=value as Record<string,unknown>,limit=row.limit===undefined?pageLimit:row.limit
 if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>pageLimit)throw invalid('需要你目录每页条数必须在 1 到 '+pageLimit+' 之间。')
 if(row.scope!==undefined&&!text(row.scope,120))throw invalid('业务范围不正确。')
 return {...(row.scope===undefined?{}:{scope:row.scope as string}),...(row.cursor===undefined?{}:{cursor:decodeCursor(row.cursor)}),limit:Number(limit)}
}

/** 业务类读取错误（无权、损坏、依赖不可用）只让该来源显式不完整；程序错误继续抛出。 */
async function guarded<T>(incomplete:WorkAttentionIncomplete[],marker:WorkAttentionIncomplete,read:()=>Promise<T>):Promise<T|undefined>{
 try{return await read()}catch(error){if(error instanceof WorkError){incomplete.push(marker);return undefined}throw error}
}

function taskItems(page:TaskAttentionPage,ownerId:string,allowed:readonly string[]):WorkAttentionItem[]{
 const rows=new Map<string,WorkAttentionItem>()
 for(const {task,attention} of page.items){
  if(task.ownerId!==ownerId)throw new WorkError('teloa/storage-corrupt','任务待办的本人归属不一致。')
  if(task.scope!=='general'&&!allowed.includes(task.scope))continue
  if(!attention||rows.has(task.id))continue
  rows.set(task.id,item('task:'+task.id,attention.kind,attention.reason,task.title,task.scope,task.updatedAt,{kind:'task',taskId:task.id,version:task.version},{kind:'task',taskId:task.id}))
 }
 return [...rows.values()]
}

async function changeSetItems(ports:WorkAttentionPorts,actor:Actor,scope:string,incomplete:WorkAttentionIncomplete[]):Promise<WorkAttentionItem[]>{
 const rows:WorkAttentionItem[]=[]
 let cursor:BusinessWorkCursor|undefined
 for(let page=0;page<changeSetPages;page++){
  const result=await ports.changeSets.listPage(actor,{scope,...(cursor?{cursor}:{})})
  for(const row of result.items){
   // 列表已排除已采用/已拒绝；失效只按已记录的 stale 判定，不在这里调用会写回状态的 get。
   if(row.state==='applied'||row.state==='rejected')continue
   const stale=row.state==='stale'
   rows.push(item('business-change-set:'+row.id,stale?'error':'approval',stale?'business-change-stale':'business-change-review',row.id,row.scope,row.updatedAt,{kind:'business-change-set',scope:row.scope,changeSetId:row.id,revision:row.revision,digest:row.digest},{kind:'business-change-set',scope:row.scope,changeSetId:row.id}))
  }
  cursor=result.nextCursor
  if(!cursor)return rows
 }
 incomplete.push({source:'business-change-set',scope,reason:'page-limit'})
 return rows
}

function syncItems(scope:string,statuses:BusinessSyncStatus[]):WorkAttentionItem[]{
 // 只有最近一次真实失败的同步才需要本人处理；下次运行时间不是期限，不投影。
 return statuses.flatMap(row=>row.lastRun?.status==='failed'?[item('business-sync:'+scope+':'+row.mappingId,'error','business-sync-failed',row.mappingId,scope,row.lastRun.finishedAt,{kind:'business-sync',scope,mappingId:row.mappingId,runId:row.lastRun.id},{kind:'business-sync',scope,mappingId:row.mappingId})]:[])
}

function draftItems(drafts:PageCreateDraft[]):WorkAttentionItem[]{
 return drafts.filter(row=>row.status==='draft').map(row=>item('page-create-draft:'+row.id,'review','page-create-draft-pending',row.title,row.scope,row.updatedAt,{kind:'page-create-draft',entity:row.entity,...(row.scope===undefined?{}:{scope:row.scope}),draftId:row.id,bodyHash:row.bodyHash},{kind:'page-create-draft',draftId:row.id}))
}

/** 「需要你」只读聚合：沿现有真源读服务投影，不建总待办表、不建第二队列、不执行任何动作。 */
export class WorkAttentionService{
 private readonly ports:WorkAttentionPorts
 constructor(ports:WorkAttentionPorts){this.ports=ports}

 async listWorkAttention(ownerId:string,input:WorkAttentionQuery):Promise<WorkAttentionPage>{
  if(!text(ownerId,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const query=readQuery(input),directory=await this.ports.scopes(ownerId,query.scope===undefined?{}:{scope:query.scope}),allowed=[...directory.scopeIds]
  if(query.scope!==undefined&&query.scope!=='general'&&!allowed.includes(query.scope))throw new WorkError('teloa/forbidden','当前本人无权查看这个业务范围的待办。')
  const actor:Actor={ownerId,scopeIds:allowed},scopes=allowed.filter(scope=>scope!=='general'&&(query.scope===undefined||scope===query.scope))
  const incomplete:WorkAttentionIncomplete[]=[],items:WorkAttentionItem[]=[]
  if(directory.truncated)incomplete.push({source:'business-scope',reason:'page-limit'})
  const tasks=await guarded(incomplete,{source:'task',reason:'unavailable'},async()=>taskItems(await this.ports.tasks.list(ownerId,{}),ownerId,allowed))
  if(tasks)items.push(...tasks)
  for(const scope of scopes){
   items.push(...await guarded(incomplete,{source:'business-change-set',scope,reason:'unavailable'},()=>changeSetItems(this.ports,actor,scope,incomplete))??[])
   const statuses=await guarded(incomplete,{source:'business-sync',scope,reason:'unavailable'},()=>this.ports.sync.status(actor,scope))
   if(statuses)items.push(...syncItems(scope,statuses))
  }
  const drafts=await guarded(incomplete,{source:'page-create-draft',reason:'unavailable'},()=>this.ports.drafts.pendingForAttention(actor))
  if(drafts){items.push(...draftItems(drafts.drafts));if(drafts.truncated)incomplete.push({source:'page-create-draft',reason:'page-limit'})}
  const unique=new Map(items.map(row=>[row.id,row]))
  const sorted=[...unique.values()].filter(row=>query.scope===undefined||row.scope===query.scope).sort((a,b)=>compare(keyOf(a),keyOf(b)))
  const rest=query.cursor?sorted.filter(row=>compare(keyOf(row),query.cursor!)>0):sorted
  const page=rest.slice(0,query.limit),last=page.at(-1)
  return {schema:'teloa.work-attention/v1',items:page,...(rest.length>query.limit&&last?{nextCursor:encodeCursor(keyOf(last))}:{}),incomplete}
 }
}
