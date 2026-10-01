import {WorkError,isRecord,isBusinessScopeKey} from './index.ts'
export type BusinessRecordFieldValue={name:string;value:string}
export type BusinessRecordTarget={scope:string;type:string}
export type BusinessRecordCreate=BusinessRecordTarget&{requestId:string;title:string;summary:string;fields:BusinessRecordFieldValue[]}
export type BusinessRecordEdit=BusinessRecordTarget&{id:string;expectedVersion:number;requestId:string;title?:string;summary?:string;fields:BusinessRecordFieldValue[]}
export type BusinessRecordArchive=BusinessRecordTarget&{id:string;expectedVersion:number;requestId:string}
export type BusinessRecordGet=BusinessRecordTarget&{id:string;version?:number}
export type BusinessRecordList=BusinessRecordTarget&{limit:number;cursor?:string}
const invalid=()=>new WorkError('teloa/invalid-input','本地业务记录参数不正确。')
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&v===v.trim()&&(empty||v.length>0)&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
const version=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
function exact(value:unknown,keys:string[]):Record<string,unknown>{if(!isRecord(value)||Object.keys(value).some(k=>!keys.includes(k)))throw invalid();return value}
function target(row:Record<string,unknown>):BusinessRecordTarget{if(!isBusinessScopeKey(row.scope)||row.scope==='general'||!text(row.type,80))throw invalid();return {scope:row.scope,type:row.type}}
/** 单选、多选与回包共用记录身份边界，不从显示名称猜测或修正身份。 */
export function isBusinessRecordId(value:unknown):value is string{return text(value,200)&&/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]*$/u.test(value)}
function id(row:Record<string,unknown>):string{if(!isBusinessRecordId(row.id))throw invalid();return row.id}
function fields(value:unknown):BusinessRecordFieldValue[]{
 if(!Array.isArray(value)||value.length>50)throw invalid()
 const result=value.map(v=>{const row=exact(v,['name','value']);if(!text(row.name,80)||!text(row.value,2000,true))throw invalid();return {name:row.name,value:row.value}})
 if(new Set(result.map(f=>f.name)).size!==result.length)throw invalid()
 return result.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
}
export function readBusinessRecordReceipt(value:unknown):{requestId:string}{const row=exact(value,['requestId']);if(!uuid(row.requestId))throw invalid();return {requestId:row.requestId.toLowerCase()}}
export function readBusinessRecordCreate(value:unknown):BusinessRecordCreate{
 const row=exact(value,['scope','type','requestId','title','summary','fields'])
 if(!text(row.title,240)||!text(row.summary,4000,true))throw invalid()
 return {...target(row),...readBusinessRecordReceipt({requestId:row.requestId}),title:row.title,summary:row.summary,fields:fields(row.fields)}
}
export function readBusinessRecordEdit(value:unknown):BusinessRecordEdit{
 const row=exact(value,['scope','type','id','expectedVersion','requestId','title','summary','fields'])
 if(!version(row.expectedVersion)||(row.title!==undefined&&!text(row.title,240))||(row.summary!==undefined&&!text(row.summary,4000,true)))throw invalid()
 return {...target(row),id:id(row),expectedVersion:Number(row.expectedVersion),...readBusinessRecordReceipt({requestId:row.requestId}),...(row.title===undefined?{}:{title:row.title as string}),...(row.summary===undefined?{}:{summary:row.summary as string}),fields:fields(row.fields)}
}
export function readBusinessRecordArchive(value:unknown):BusinessRecordArchive{
 const row=exact(value,['scope','type','id','expectedVersion','requestId']);if(!version(row.expectedVersion))throw invalid()
 return {...target(row),id:id(row),expectedVersion:Number(row.expectedVersion),...readBusinessRecordReceipt({requestId:row.requestId})}
}
export function readBusinessRecordGet(value:unknown):BusinessRecordGet{
 const row=exact(value,['scope','type','id','version']);if(row.version!==undefined&&!version(row.version))throw invalid()
 return {...target(row),id:id(row),...(row.version===undefined?{}:{version:Number(row.version)})}
}
export function readBusinessRecordList(value:unknown):BusinessRecordList{
 const row=exact(value,['scope','type','limit','cursor']);if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>100||(row.cursor!==undefined&&!text(row.cursor,2048)))throw invalid()
 return {...target(row),limit:Number(row.limit),...(row.cursor===undefined?{}:{cursor:row.cursor as string})}
}

/** 浏览器与宿主共用固定快照的结构边界；摘要字节核对仍由存储服务负责。 */
export function readBusinessRecordSnapshot(value:unknown,scope?:string):import('./business-data.ts').BusinessObjectSnapshot{
 const bad=()=>new WorkError('teloa/invalid-host-response','本地业务记录回包不一致。')
 const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
 if(!isRecord(value))throw bad()
 // tombstone保留原observedAt/receivedAt，只追加归档时刻；两者不要求同时发生。
 const r=value,keys=['scope','type','id','version','snapshotHash','title','source','observedAt','receivedAt','quality','summary','fields']
 if(keys.some(k=>!Object.hasOwn(r,k))||Object.keys(r).some(k=>!keys.includes(k)&&k!=='deletedAt')||!isBusinessScopeKey(r.scope)||r.scope==='general'||scope!==undefined&&r.scope!==scope||!text(r.type,80)||!isBusinessRecordId(r.id)||!version(r.version)||typeof r.snapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(r.snapshotHash)||!text(r.title,240)||!text(r.source,120)||!stamp(r.observedAt)||!stamp(r.receivedAt)||r.receivedAt<r.observedAt||!['complete','missing'].includes(String(r.quality))||!text(r.summary,4000,true)||!Array.isArray(r.fields)||r.fields.length>50||Object.hasOwn(r,'deletedAt')&&!stamp(r.deletedAt))throw bad()
 const labels:string[]=[]
 for(const field of r.fields){if(!isRecord(field)||Object.keys(field).length!==2||!text(field.label,120)||!text(field.value,2000,true))throw bad();labels.push(field.label)}
 if(new Set(labels).size!==labels.length)throw bad()
 return r as import('./business-data.ts').BusinessObjectSnapshot
}
export function readBusinessRecordPage(value:unknown,scope:string):import('./business-data.ts').BusinessDataPage{
 const bad=()=>new WorkError('teloa/invalid-host-response','本地业务记录列表回包不一致。')
 if(!isRecord(value)||Object.keys(value).some(k=>!['schema','sourceId','capturedAt','items','nextCursor'].includes(k))||value.schema!=='teloa.business-data-page/v1'||!text(value.sourceId,120)||typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt))||new Date(value.capturedAt).toISOString()!==value.capturedAt||!Array.isArray(value.items)||value.items.length>100||Object.hasOwn(value,'nextCursor')&&!text(value.nextCursor,2048))throw bad()
 const items=value.items.map(item=>readBusinessRecordSnapshot(item,scope))
 if(items.some(item=>item.deletedAt!==undefined||item.receivedAt>(value.capturedAt as string))||new Set(items.map(item=>item.type+'\0'+item.id)).size!==items.length)throw bad()
 return {...value,items} as import('./business-data.ts').BusinessDataPage
}

export type BusinessRecordBatchOperation=
 |({operation:'create'}&Omit<BusinessRecordCreate,'scope'|'requestId'>)
 |({operation:'edit'}&Omit<BusinessRecordEdit,'scope'|'requestId'>)
 |({operation:'archive'}&Omit<BusinessRecordArchive,'scope'|'requestId'>)
export type BusinessRecordBatch={requestId:string;scope:string;operations:BusinessRecordBatchOperation[]}
export type BusinessRecordBatchResult={requestId:string;scope:string;items:import('./business-data.ts').BusinessObjectSnapshot[]}
/** 批次只有一个范围与请求身份；字段结构/归一继续沿单条读取器。 */
export function readBusinessRecordBatch(value:unknown):BusinessRecordBatch{
 const row=exact(value,['requestId','scope','operations']),{requestId}=readBusinessRecordReceipt({requestId:row.requestId})
 if(!isBusinessScopeKey(row.scope)||row.scope==='general'||!Array.isArray(row.operations)||row.operations.length<1||row.operations.length>50)throw invalid()
 const scope=row.scope,targets=new Set<string>()
 const operations=row.operations.map((value):BusinessRecordBatchOperation=>{
  if(!isRecord(value)||Object.hasOwn(value,'scope')||Object.hasOwn(value,'requestId'))throw invalid()
  const {operation,...body}=value,input={...body,scope,requestId}
  const parsed=operation==='create'?readBusinessRecordCreate(input):operation==='edit'?readBusinessRecordEdit(input):operation==='archive'?readBusinessRecordArchive(input):undefined
  if(!parsed)throw invalid()
  const {scope:_,requestId:__,...result}=parsed
  if('id' in result){const key=JSON.stringify([result.type,result.id]);if(targets.has(key))throw invalid();targets.add(key)}
  return {operation,...result} as BusinessRecordBatchOperation
 })
 return {requestId,scope,operations}
}
