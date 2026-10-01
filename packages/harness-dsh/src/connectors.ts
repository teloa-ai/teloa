import {WorkError,isRecord,taskInput} from '@teloa/contract'
import type {ConnectorKind,ConnectorProbeResult} from '@teloa/backend'

export const connectorEndpoints=['connectors/probe'] as const

type Ports={probe:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const isKind=(value:unknown):value is ConnectorKind=>value==='data-source'||value==='mcp'||value==='execution-tool'
const invalid=()=>new WorkError('teloa/invalid-host-response','连接测试连接回包的身份或格式不一致。')
const exact=(value:unknown,keys:string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

/**
 * 回包只接受契约白名单字段：成功态四列、失败态五列，多一列少一列都判定回包不一致，
 * 不把宿主给的失败原因之外的任何东西（例如误传的 details）当成合法字段放行。
 */
function read(value:unknown,kind:ConnectorKind,instanceId:string):ConnectorProbeResult{
 const ok=isRecord(value)?value.ok:undefined
 if(ok===true){
  const row=exact(value,['kind','instanceId','probedAt','ok'])
  if(row.kind!==kind||row.instanceId!==instanceId||!stamp(row.probedAt))throw invalid()
  return {kind,instanceId,probedAt:row.probedAt as string,ok:true}
 }
 if(ok===false){
  const row=exact(value,['kind','instanceId','probedAt','ok','reason'])
  if(row.kind!==kind||row.instanceId!==instanceId||!stamp(row.probedAt)||!text(row.reason,2000))throw invalid()
  return {kind,instanceId,probedAt:row.probedAt as string,ok:false,reason:row.reason}
 }
 throw invalid()
}

export function createConnectorHandler(owner:string,get:()=>Promise<Ports>){
 return async(endpoint:string,payload:unknown,signal:AbortSignal=new AbortController().signal):Promise<ConnectorProbeResult>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(endpoint!=='connectors/probe')throw new WorkError('teloa/invalid-input','不支持的连接操作。')
  const input=taskInput(payload,['kind','instanceId'])
  if(!isKind(input.kind))throw new WorkError('teloa/invalid-input','连接类型不正确。')
  if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','连接实例身份必须是 UUID。')
  const normalized={kind:input.kind,instanceId:input.instanceId.toLowerCase()}
  signal.throwIfAborted()
  const result=await(await get()).probe(owner,normalized,signal)
  signal.throwIfAborted()
  return read(result,normalized.kind,normalized.instanceId)
 }
}
