import type {PoolClient} from 'pg'
import {WorkError,readBusinessWorkSourceRef,type BusinessWorkSourceRef} from '@teloa/contract'

export type BusinessWorkEventFacts={sourceVersion:string;basisHash:string;active:boolean;data:Record<string,unknown>;originRunId?:string}
export type BusinessWorkSourceReader=(db:PoolClient,owner:string,source:BusinessWorkSourceRef,version?:string)=>Promise<BusinessWorkEventFacts>
export type BusinessEventOriginProof={kind:'ordinary-conversation'}|{kind:'task-run';runId:string}
export type BusinessEventOrigin={sessionId:string;messageId:string;seq:number}
export type BusinessWorkEventProducers={
 object:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-object'}>,version:string,origin?:BusinessEventOrigin)=>Promise<unknown>
 sync:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-sync'}>,version:string)=>Promise<unknown>
}
type ObjectSource=Extract<BusinessWorkSourceRef,{kind:'business-object'}>
type Sources={
 records:{workEventSourceInTransaction:(db:PoolClient,owner:string,source:ObjectSource,version?:string)=>Promise<BusinessWorkEventFacts>}
 sync:{
  workEventSourceInTransaction:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-sync'}>,version?:string)=>Promise<BusinessWorkEventFacts>
  /** 已核对同步归属（`teloa_business_sync_object_ids`）对象的固定快照读口；缺省时同步对象仍按本地记录口径拒绝。 */
  objectEventSourceInTransaction?:(db:PoolClient,owner:string,source:ObjectSource,version?:string)=>Promise<BusinessWorkEventFacts>
  /** 类型级订阅只核对对象类型声明生效；它不是事件本体。 */
  objectTypeSourceInTransaction?:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-object-type'}>)=>Promise<BusinessWorkEventFacts>
 }
}
/**
 * 共用正式业务读取与声明校验，不从 UI、目录刷新或调用方 hash 制造事件。
 * 对象级来源按持久归属分流：本地记录头存在 → 本地记录读口；否则 → 已核对同步归属的固定快照读口。两者都核对 hash 与连续历史。
 */
export function businessWorkSourceReader(sources:Sources):BusinessWorkSourceReader{
 return async(db,owner,value,version)=>{
  const source=readBusinessWorkSourceRef(value)
  if(source.kind==='business-sync')return sources.sync.workEventSourceInTransaction(db,owner,source,version)
  if(source.kind==='business-object-type'){
   if(!sources.sync.objectTypeSourceInTransaction)throw new WorkError('teloa/source-unavailable','业务对象类型订阅的宿主读口尚未就绪。')
   return sources.sync.objectTypeSourceInTransaction(db,owner,source)
  }
  const heads=(await db.query("select to_regclass('teloa_business_record_heads') as relation")).rows[0]?.relation
  const local=heads?(await db.query('select 1 from teloa_business_record_heads where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[owner,source.scope,source.type,source.id])).rowCount:0
  if(local||!sources.sync.objectEventSourceInTransaction)return sources.records.workEventSourceInTransaction(db,owner,source,version)
  return sources.sync.objectEventSourceInTransaction(db,owner,source,version)
 }
}
