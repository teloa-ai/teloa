import {WorkError,isRecord} from './index.ts'
import {isBusinessScopeKey} from './business-scopes.ts'

export type BusinessRuntimeState={scope:string;managed:boolean;syncEnabled:boolean;revision:number}
export type BusinessRuntimeSetSyncInput={scope:string;enabled:boolean;expectedRevision:number;requestId:string}
const invalid=()=>new WorkError('teloa/invalid-input','业务同步运行状态或启停请求格式不正确。')
const scope=(value:unknown):value is string=>isBusinessScopeKey(value)&&value!=='general'
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw invalid()
 return value
}
/** 未受管范围保留旧同步语义；不能伪装成有修订的受管状态。 */
export function readBusinessRuntimeState(value:unknown):BusinessRuntimeState{
 const row=exact(value,['scope','managed','syncEnabled','revision'])
 if(!scope(row.scope)||typeof row.managed!=='boolean'||typeof row.syncEnabled!=='boolean'||
  (row.managed?!positive(row.revision):row.syncEnabled!==true||row.revision!==0))throw invalid()
 return {scope:row.scope,managed:row.managed,syncEnabled:row.syncEnabled,revision:row.revision as number}
}
export function readBusinessRuntimeSetSyncInput(value:unknown):BusinessRuntimeSetSyncInput{
 const row=exact(value,['scope','enabled','expectedRevision','requestId'])
 if(!scope(row.scope)||typeof row.enabled!=='boolean'||!positive(row.expectedRevision)||!uuid(row.requestId))throw invalid()
 return {scope:row.scope,enabled:row.enabled,expectedRevision:row.expectedRevision,requestId:row.requestId.toLowerCase()}
}
