export type BusinessDataQuality='complete'|'missing'

export type BusinessDataItem={
 scope:string
 type:string
 id:string
 version:number
 title:string
 source:string
 observedAt:string
 receivedAt:string
 quality:BusinessDataQuality
 summary:string
 fields:Array<{label:string;value:string}>
 snapshotHash:string
}

export type BusinessDataPage={
 schema:'teloa.business-data-page/v1'
 sourceId:string
 capturedAt:string
 items:BusinessDataItem[]
 nextCursor?:string
}

const pageKeys=['schema','sourceId','capturedAt','items','nextCursor'] as const
const itemKeys=['scope','type','id','version','title','source','observedAt','receivedAt','quality','summary','fields','snapshotHash'] as const
const fieldKeys=['label','value'] as const

function invalid(message='业务数据回包格式不正确。'):Error{return Error(message)}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function exact(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)&&!optional.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw invalid()
 return value
}
function text(value:unknown,max:number,empty=false):value is string{return typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)}
function stamp(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function hash(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)}

async function digest(value:unknown):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(value))
 const result=await crypto.subtle.digest('SHA-256',bytes)
 return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('')
}

/**
 * 读取一条已经由业务任务来源回执固定的对象快照。
 *
 * 这里的范围和来源都必须由调用方明确传入：把某个首批行业的来源写进读取器，会使其他
 * 业务范围的真实任务在会话中无法恢复固定输入。页面没有直接调用这条旧分页协议，唯一
 * 调用方是任务会话上下文，它持有服务端签发的来源回执。
 */
export async function readBusinessDataPage(value:unknown,expected:{scope:string;sourceId:string}):Promise<BusinessDataPage>{
 const row=exact(value,pageKeys.filter(key=>key!=='nextCursor'),['nextCursor'])
 if(!text(expected.scope,120)||expected.scope==='general'||!text(expected.sourceId,120)||row.schema!=='teloa.business-data-page/v1'||row.sourceId!==expected.sourceId||!stamp(row.capturedAt)||!Array.isArray(row.items)||row.items.length>100||(row.nextCursor!==undefined&&!text(row.nextCursor,1024)))throw invalid('业务数据回包的来源、范围或固定快照不一致。')
 const capturedAt=row.capturedAt as string,items:BusinessDataItem[]=[],identities=new Set<string>()
 for(const value of row.items){
  const item=exact(value,itemKeys)
  if(item.scope!==expected.scope||!text(item.type,80)||!text(item.id,200)||!Number.isSafeInteger(item.version)||Number(item.version)<1||Number(item.version)>2147483647||!text(item.title,240)||!text(item.source,120)||!stamp(item.observedAt)||!stamp(item.receivedAt)||String(item.receivedAt)<String(item.observedAt)||String(item.receivedAt)>capturedAt||(item.quality!=='complete'&&item.quality!=='missing')||!text(item.summary,4000,true)||!Array.isArray(item.fields)||item.fields.length>50||!hash(item.snapshotHash))throw invalid('业务数据回包的来源、范围或固定快照不一致。')
  const fields:Array<{label:string;value:string}>=[]
  for(const fieldValue of item.fields){const field=exact(fieldValue,fieldKeys);if(!text(field.label,120)||!text(field.value,2000,true))throw invalid('业务数据回包的来源、范围或固定快照不一致。');fields.push({label:field.label,value:field.value})}
  if(new Set(fields.map(field=>field.label)).size!==fields.length)throw invalid('业务数据回包的来源、范围或固定快照不一致。')
  const snapshot={scope:item.scope,type:item.type,id:item.id,version:item.version,title:item.title,source:item.source,observedAt:item.observedAt,receivedAt:item.receivedAt,quality:item.quality,summary:item.summary,fields}
  if(await digest(snapshot)!==item.snapshotHash)throw invalid('业务数据固定快照的摘要不一致。')
  const identity=String(item.type)+'\0'+String(item.id)
  if(identities.has(identity))throw invalid('业务数据回包包含重复对象。')
  identities.add(identity)
  items.push({...snapshot,version:item.version as number,quality:item.quality as BusinessDataQuality,snapshotHash:item.snapshotHash as string})
 }
 return {schema:'teloa.business-data-page/v1',sourceId:expected.sourceId,capturedAt,items,...(row.nextCursor===undefined?{}:{nextCursor:row.nextCursor as string})}
}

/**
 * `createBusinessDataApi`/`appendBusinessDataPage`/`BusinessDataApi` 已删除：业务页真实模式改由声明
 * 驱动（`business-ledger-api.ts` 的 `business-definitions/ledger`）。`readBusinessDataPage` 保留给
 * `object-conversation-api.ts`，以来源回执中的范围和来源标识核对会话里带出的固定对象快照。
 */
