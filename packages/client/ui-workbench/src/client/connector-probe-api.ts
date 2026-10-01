type Call=(method:string,payload:unknown)=>Promise<unknown>

export type ConnectorKind='data-source'|'mcp'|'execution-tool'
export type ConnectorProbeInput={kind:ConnectorKind;instanceId:string}
export type ConnectorProbeResult={kind:ConnectorKind;instanceId:string;probedAt:string}&({ok:true}|{ok:false;reason:string})

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;try{return new Date(value).toISOString()===value}catch{return false}}
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const isKind=(value:unknown):value is ConnectorKind=>value==='data-source'||value==='mcp'||value==='execution-tool'
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}

/** 回包形状不符即抛：不把失败原因当成功渲染，也不把宿主多给的字段悄悄放行。 */
function read(value:unknown,kind:ConnectorKind,instanceId:string):ConnectorProbeResult{
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error()
  const ok=(value as Record<string,unknown>).ok
  if(ok===true){
   const row=exact(value,['kind','instanceId','probedAt','ok'])
   if(row.kind!==kind||row.instanceId!==instanceId||!stamp(row.probedAt))throw Error()
   return {kind,instanceId,probedAt:row.probedAt as string,ok:true}
  }
  if(ok===false){
   const row=exact(value,['kind','instanceId','probedAt','ok','reason'])
   if(row.kind!==kind||row.instanceId!==instanceId||!stamp(row.probedAt)||!text(row.reason,2000))throw Error()
   return {kind,instanceId,probedAt:row.probedAt as string,ok:false,reason:row.reason as string}
  }
  throw Error()
 }catch{throw Error('连接测试连接回包格式不正确。')}
}

export type ConnectorProbeApi=ReturnType<typeof createConnectorProbeApi>
export function createConnectorProbeApi(call:Call){
 return {
  async probe(input:ConnectorProbeInput):Promise<ConnectorProbeResult>{
   if(!isKind(input.kind))throw Error('连接类型不正确。')
   if(!uuid(input.instanceId))throw Error('连接实例身份必须是 UUID。')
   const normalized={kind:input.kind,instanceId:input.instanceId.toLowerCase()}
   return read(await call('connectors/probe',normalized),normalized.kind,normalized.instanceId)
  },
 }
}
