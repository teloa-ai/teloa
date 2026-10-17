import type {PoolClient} from 'pg'
import {readBusinessWorkSourceRef,type BusinessWorkSourceRef} from '@teloa/contract'

export type BusinessWorkEventFacts={sourceVersion:string;basisHash:string;active:boolean;data:Record<string,unknown>;originRunId?:string}
export type BusinessWorkSourceReader=(db:PoolClient,owner:string,source:BusinessWorkSourceRef,version?:string)=>Promise<BusinessWorkEventFacts>
export type BusinessEventOriginProof={kind:'ordinary-conversation'}|{kind:'task-run';runId:string}
export type BusinessEventOrigin={sessionId:string;messageId:string;seq:number}
export type BusinessWorkEventProducers={
 object:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-object'}>,version:string,origin?:BusinessEventOrigin)=>Promise<unknown>
 sync:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-sync'}>,version:string)=>Promise<unknown>
}
type Sources={
 records:{workEventSourceInTransaction:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-object'}>,version?:string)=>Promise<BusinessWorkEventFacts>}
 sync:{workEventSourceInTransaction:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-sync'}>,version?:string)=>Promise<BusinessWorkEventFacts>}
}
/** 共用正式业务读取与声明校验，不从 UI、目录刷新或调用方 hash 制造事件。 */
export function businessWorkSourceReader(sources:Sources):BusinessWorkSourceReader{
 return (db,owner,value,version)=>{
  const source=readBusinessWorkSourceRef(value)
  return source.kind==='business-object'?sources.records.workEventSourceInTransaction(db,owner,source,version):sources.sync.workEventSourceInTransaction(db,owner,source,version)
 }
}
