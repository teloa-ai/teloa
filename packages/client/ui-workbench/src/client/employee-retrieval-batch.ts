import type {LocalRetrievalApi} from './local-retrieval-api.ts'
import type {EmployeeKnowledgeGroup} from './resource-manager-presentation.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'
import {retrievalLimits} from '@teloa/contract'
import {retrievalEnrollmentOutcome} from './local-retrieval-api.ts'

export type RetrievalBatchItem={sourceId:string;title:string;state:'queued'|'sending'|'added'|'present'|'failed'|'unknown'|'cancelled'|'unattempted'|'unavailable';error?:unknown}
export type RetrievalBatchProgress={total:number;offset:number;remaining:number;priorCounts:Partial<Record<RetrievalBatchItem['state'],number>>}
export type RetrievalBatchSnapshot={progress?:RetrievalBatchProgress|undefined;batchId:string;roleId:string;roleName:string;items:readonly RetrievalBatchItem[];running:boolean;cancelRequested:boolean;reviewing:boolean;needsModel:boolean;restored:boolean;storageBlocked:boolean;storageError?:unknown;error?:unknown}
export type RetrievalBatchJournal={identity:string;read:()=>string|null;write:(raw:string)=>void}
type BatchApi=Pick<LocalRetrievalApi,'modelStatus'|'status'|'enroll'>
const empty:RetrievalBatchSnapshot={batchId:'',roleId:'',roleName:'',items:[],running:false,cancelRequested:false,reviewing:false,needsModel:false,restored:false,storageBlocked:false}
const schema='teloa.retrieval-batch/v1'
const chunkedSchema='teloa.retrieval-batch/v2'
const journalMaxBytes=1024*1024
const journalBytes=(raw:string)=>new TextEncoder().encode(raw).byteLength
const states:readonly RetrievalBatchItem['state'][]=['queued','sending','added','present','failed','unknown','cancelled','unattempted','unavailable']
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0
const recoveryError=()=>Object.assign(Error('Retrieval batch recovery unavailable'),{code:'teloa/storage-corrupt',origin:'browser-recovery'})
const errorCode=(error:unknown)=>record(error)&&typeof error.code==='string'?error.code:'teloa/unknown-error'
function readJournal(raw:string,identity:string):RetrievalBatchSnapshot{
 if(journalBytes(raw)>journalMaxBytes)throw recoveryError()
 const row:unknown=JSON.parse(raw)
 if(!record(row)||(row.schema!==schema&&row.schema!==chunkedSchema)||row.identity!==identity||!text(row.batchId)||!text(row.roleId)||!text(row.roleName)||!Array.isArray(row.items)||typeof row.cancelRequested!=='boolean'||typeof row.needsModel!=='boolean'||row.errorCode!==undefined&&!text(row.errorCode)||Object.keys(row).some(key=>!['schema','identity','batchId','roleId','roleName','items','cancelRequested','needsModel','errorCode','progress'].includes(key)))throw recoveryError()
 let progress:RetrievalBatchProgress|undefined
 if(row.schema===chunkedSchema){
  const p=row.progress,count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
  if(!record(p)||Object.keys(p).some(key=>!['total','offset','remaining','priorCounts'].includes(key))||!count(p.total)||!count(p.offset)||!count(p.remaining)||!record(p.priorCounts)||row.items.length>retrievalLimits.maxEnrollmentBatch||p.offset+row.items.length+p.remaining!==p.total||p.total===0)throw recoveryError()
  let prior=0
  for(const [state,n]of Object.entries(p.priorCounts)){if(!['added','present','failed','unavailable'].includes(state)||!count(n)||n>p.offset)throw recoveryError();prior+=n}
  if(prior!==p.offset)throw recoveryError()
  progress={total:p.total,offset:p.offset,remaining:p.remaining,priorCounts:p.priorCounts as RetrievalBatchProgress['priorCounts']}
 }else if(Object.hasOwn(row,'progress'))throw recoveryError()
 const seen=new Set<string>()
 const items:RetrievalBatchItem[]=row.items.map(value=>{
  if(!record(value)||!text(value.sourceId)||!text(value.title)||!states.includes(value.state as RetrievalBatchItem['state'])||value.errorCode!==undefined&&!text(value.errorCode)||Object.keys(value).some(key=>!['sourceId','title','state','errorCode'].includes(key))||seen.has(value.sourceId))throw recoveryError()
  seen.add(value.sourceId)
  const saved=value.state as RetrievalBatchItem['state'],state=saved==='sending'?'unknown':saved==='queued'?(row.cancelRequested?'cancelled':'unattempted'):saved
  return {sourceId:value.sourceId,title:value.title,state,...(value.errorCode===undefined?{}:{error:{code:value.errorCode}})}
 })
 return {...empty,...(progress?{progress}:{}),batchId:row.batchId,roleId:row.roleId,roleName:row.roleName,items,cancelRequested:row.cancelRequested,needsModel:row.needsModel,restored:true,...(row.errorCode===undefined?{}:{error:{code:row.errorCode}})}
}
function writeJournal(snapshot:RetrievalBatchSnapshot,identity:string){
 return JSON.stringify({schema:snapshot.progress?chunkedSchema:schema,...(snapshot.progress?{progress:snapshot.progress}:{}),identity,batchId:snapshot.batchId,roleId:snapshot.roleId,roleName:snapshot.roleName,cancelRequested:snapshot.cancelRequested,needsModel:snapshot.needsModel,items:snapshot.items.map(({sourceId,title,state,error})=>({sourceId,title,state,...(error===undefined?{}:{errorCode:errorCode(error)})})),...(snapshot.error===undefined?{}:{errorCode:errorCode(snapshot.error)})})
}

/** 取消仅停止尚未发出的加入请求；保留原在途 Promise，不调用索引取消或删除已加入项。 */
export function createEmployeeRetrievalBatch(api:BatchApi,journal?:RetrievalBatchJournal){
 let snapshot=empty,journalBatchId:string|undefined,journalOffset=0,unreadable=false
 try{const raw=journal?.read();if(raw!==null&&raw!==undefined){snapshot=readJournal(raw,journal!.identity);journalBatchId=snapshot.batchId;journalOffset=snapshot.progress?.offset??0}}
 catch{unreadable=true;snapshot={...empty,storageBlocked:true,storageError:recoveryError()}}
 const listeners=new Set<()=>void>()
 const update=(patch:Partial<RetrievalBatchSnapshot>)=>{
  snapshot={...snapshot,...patch};let saved=!unreadable
  if(journal&&!unreadable)try{
   // 另一页已写入新批次时，不允许旧页面回包覆盖它，也不擅自换一个身份重发。
   const raw=journal.read(),stored=raw!==null&&raw!==undefined?readJournal(raw,journal.identity):undefined
   if(stored?.batchId!==journalBatchId||(stored?.progress?.offset??0)!==journalOffset)throw recoveryError()
   const serialized=writeJournal(snapshot,journal.identity)
   if(journalBytes(serialized)>journalMaxBytes)throw recoveryError()
   journal.write(serialized);journalBatchId=snapshot.batchId;journalOffset=snapshot.progress?.offset??0
   snapshot={...snapshot,storageBlocked:false,storageError:undefined}
  }catch{saved=false;snapshot={...snapshot,storageBlocked:true,storageError:recoveryError()}}
  for(const listener of listeners)listener()
  return saved
 }
 const item=(sourceId:string,patch:Partial<RetrievalBatchItem>)=>update({items:snapshot.items.map(row=>row.sourceId===sourceId?{...row,...patch}:row)})
 const stopQueued=(state:'cancelled'|'unattempted')=>update({items:snapshot.items.map(row=>row.state==='queued'?{...row,state}:row)})
 const blocked=()=>snapshot.running||snapshot.reviewing||snapshot.storageBlocked||snapshot.items.some(row=>row.state==='unknown')
 return {
  getSnapshot:()=>snapshot,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
  blocked,
  cancel(){if(!snapshot.running||snapshot.cancelRequested)return;update({cancelRequested:true,items:snapshot.items.map(row=>row.state==='queued'?{...row,state:'cancelled'}:row)})},
  async start(group:Pick<EmployeeKnowledgeGroup,'roleId'|'roleName'|'resources'>,current:()=>boolean=()=>true){
   if(blocked()||!current())return
   const sources=new Map<string,RetrievalBatchItem>()
   for(const resource of group.resources){
    const prior=sources.get(resource.sourceId)
    if(prior){prior.title+=' / '+resource.title;if(resource.status==='active')prior.state='queued'}
    else sources.set(resource.sourceId,{sourceId:resource.sourceId,title:resource.title,state:resource.status==='active'?'queued':'unavailable'})
   }
   const all=[...sources.values()],size=retrievalLimits.maxEnrollmentBatch
   const progress=all.length>size?{total:all.length,offset:0,remaining:all.length-Math.min(size,all.length),priorCounts:{}}:undefined
   // 后续子批仅留在本次明确发起的内存中；刷新只恢复当前子批与总量，不自动恢复执行。
   // 明确清除上批错误；先保存完整原身份，再执行任何加入请求。
   if(!update({...empty,batchId:crypto.randomUUID(),roleId:group.roleId,roleName:group.roleName,items:all.slice(0,size),progress,running:true,error:undefined,storageError:undefined})){stopQueued('unattempted');update({running:false});return}
   const stopped=()=>snapshot.cancelRequested||!current()
   try{
    const model=await api.modelStatus()
    if(stopped()){stopQueued('cancelled');return}
    if(!model.enabled||!model.provider||!['ready','standby'].includes(model.provider.preparation.phase)){update({needsModel:true});stopQueued('unattempted');return}
    // 已加入的来源只读核对，不为再次点击批次按钮重发成功项目。
    const before=await api.status(),present=new Set(before.items.map(row=>row.sourceId))
    if(stopped()){stopQueued('cancelled');return}
    if(!update({items:snapshot.items.map(row=>row.state==='queued'&&present.has(row.sourceId)?{...row,state:'present'}:row)})){stopQueued('unattempted');return}
    let finished=false
    while(!finished){
     for(const planned of snapshot.items){
      if(stopped()){stopQueued('cancelled');break}
      if(snapshot.storageBlocked){stopQueued('unattempted');break}
      if(planned.state!=='queued')continue
      // 刷新后 sending 只能恢复为 unknown；保存失败时这一项尚未发送。
      if(!item(planned.sourceId,{state:'sending'})){item(planned.sourceId,{state:'unattempted'});stopQueued('unattempted');break}
      try{
       // 不传批次 AbortSignal：提交开始后，取消不能承诺回滚这一个请求。
       const receipt=await api.enroll(planned.sourceId)
       if(!receipt.items.some(row=>row.sourceId===planned.sourceId))throw Object.assign(Error('Missing enrollment in response'),{code:'teloa/invalid-host-response'})
       present.add(planned.sourceId)
       if(!item(planned.sourceId,{state:'added'})){stopQueued('unattempted');break}
      }catch(error){
       // 只有正常 API 已验证的事务结果可改变判定；普通 code 和任意 error flag 都无此权力。
       const outcome=retrievalEnrollmentOutcome(error)
       if(outcome==='committed'){present.add(planned.sourceId);if(!item(planned.sourceId,{state:'added'})){stopQueued('unattempted');break};continue}
       item(planned.sourceId,{state:outcome==='not-committed'?'failed':'unknown',error})
       if(outcome!=='not-committed'){stopQueued(snapshot.cancelRequested?'cancelled':'unattempted');break}
      }
     }
     // 已成功子批只保留计数；失败、不可用与未知项保留在当前子批供本人核对。
     const p=snapshot.progress
     if(stopped()||snapshot.storageBlocked||snapshot.items.some(row=>row.state==='unknown'||row.state==='failed'||row.state==='unavailable'||row.state==='unattempted'||row.state==='cancelled')||!p||p.remaining===0)finished=true
     else{
      const priorCounts={...p.priorCounts}
      for(const row of snapshot.items)priorCounts[row.state]=(priorCounts[row.state]??0)+1
      const offset=p.offset+snapshot.items.length,items=all.slice(offset,offset+size).map(row=>row.state==='queued'&&present.has(row.sourceId)?{...row,state:'present' as const}:row)
      if(!update({items,progress:{total:p.total,offset,remaining:p.total-offset-items.length,priorCounts}}))finished=true
     }
    }
   }catch(error){update({error});stopQueued(snapshot.cancelRequested?'cancelled':'unattempted')}
   finally{update({running:false})}
  },
  /** 当前登记只读核对，不重放 enroll。未找到不能证明原请求未提交，保持未知。 */
  async review(){
   if(unreadable||snapshot.running||snapshot.reviewing||!snapshot.items.some(row=>row.state==='unknown')&&!snapshot.storageBlocked)return
   update({reviewing:true,error:undefined})
   try{
    const status=await api.status(),present=new Set(status.items.map(row=>row.sourceId))
    update({items:snapshot.items.map(row=>row.state==='unknown'&&present.has(row.sourceId)?{...row,state:'present',error:undefined}:row)})
   }catch(error){update({error})}finally{update({reviewing:false})}
  },
 }
}
export type EmployeeRetrievalBatchController=ReturnType<typeof createEmployeeRetrievalBatch>

// 同一 API 身份下保留在途请求和结果；页面重挂不会重发。不同资料 API 身份严格隔离。
const batches=new WeakMap<LocalRetrievalApi,WeakMap<object,Map<string,EmployeeRetrievalBatchController>>>()
export function employeeRetrievalBatch(api:LocalRetrievalApi,identity:object,space:string,storage?:WorkbenchNavigationStorage){
 let owners=batches.get(api);if(!owners){owners=new WeakMap();batches.set(api,owners)}
 let spaces=owners.get(identity);if(!spaces){spaces=new Map();owners.set(identity,spaces)}
 let batch=spaces.get(space);if(!batch){
  const key=schema+'/'+space
  batch=createEmployeeRetrievalBatch(api,{identity:space,read:()=>{if(!storage)throw recoveryError();return storage.getItem(key)},write:raw=>{if(!storage)throw recoveryError();storage.setItem(key,raw)}})
  spaces.set(space,batch)
 }
 return batch
}
