import {WorkError,isRecord} from '@teloa/contract'
import type {BusinessDataPage,BusinessDataService} from '@teloa/backend'
import {createHash} from 'node:crypto'

export const businessDataEndpoints=['business-data/query'] as const
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-host-response','业务数据回包的来源、范围或固定快照不一致。')
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

export function readBusinessDataPage(value:unknown,scope:string,expectedSourceId?:string):BusinessDataPage{
 const row=exact(value,['schema','sourceId','capturedAt','items','nextCursor'])
 if(row.schema!=='teloa.business-data-page/v1'||!text(row.sourceId,120)||expectedSourceId!==undefined&&row.sourceId!==expectedSourceId||!stamp(row.capturedAt)||!Array.isArray(row.items)||row.items.length>100||(row.nextCursor!==undefined&&!text(row.nextCursor,1024)))throw invalid()
 const capturedAt=row.capturedAt as string,identities=new Set<string>()
 for(const value of row.items){
  const item=exact(value,['scope','type','id','version','title','source','observedAt','receivedAt','quality','summary','fields','snapshotHash'])
  if(item.scope!==scope||!text(item.type,80)||!text(item.id,200)||!Number.isSafeInteger(item.version)||Number(item.version)<1||Number(item.version)>2147483647||!text(item.title,240)||!text(item.source,120)||!stamp(item.observedAt)||!stamp(item.receivedAt)||item.receivedAt<item.observedAt||item.receivedAt>capturedAt||!['complete','missing'].includes(String(item.quality))||!text(item.summary,4000,true)||!Array.isArray(item.fields)||item.fields.length>50||!hash(item.snapshotHash))throw invalid()
  const fields:Array<{label:string;value:string}>=[]
  for(const value of item.fields){const field=exact(value,['label','value']);if(!text(field.label,120)||!text(field.value,2000,true))throw invalid();fields.push({label:field.label,value:field.value})}
  if(new Set(fields.map(field=>field.label)).size!==fields.length)throw invalid()
  const snapshot={scope:item.scope,type:item.type,id:item.id,version:item.version,title:item.title,source:item.source,observedAt:item.observedAt,receivedAt:item.receivedAt,quality:item.quality,summary:item.summary,fields}
  if(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')!==item.snapshotHash)throw invalid()
  const identity=item.type+'\0'+item.id;if(identities.has(identity))throw invalid();identities.add(identity)
 }
 return row as unknown as BusinessDataPage
}

export function createBusinessDataHandler(owner:string,get:()=>Promise<BusinessDataService>,sourceId='security-alert-http'){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<BusinessDataPage>=>{
  if(endpoint!=='business-data/query')throw new WorkError('teloa/not-found','未提供此业务数据接口。')
  if(!isRecord(payload)||typeof payload.scope!=='string')throw new WorkError('teloa/invalid-input','需要明确的业务数据范围。')
  signal?.throwIfAborted()
  const result=await(await get()).query({ownerId:owner,scopeIds:['SOC']},payload,signal)
  return readBusinessDataPage(result,payload.scope,sourceId)
 }
}
