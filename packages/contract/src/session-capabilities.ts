import {WorkError} from './work-error.ts'

export type WorkCapability='general-agent'|'parallel-agents'|'groups'|'people'|'automation'
/** 服务端已核实的会话所需能力；仅用于呈现，不授予执行权。null 明确表示不能确定。 */
export type SessionCapabilitySnapshot={schema:'teloa.session-capabilities/v1';sessionId:string}&(
 |{status:'ready';requiredCapabilities:readonly WorkCapability[]}
 |{status:'unavailable';requiredCapabilities:null}
)
const capabilities=new Set<WorkCapability>(['general-agent','parallel-agents','groups','people','automation'])
export function isSessionCapabilitySnapshot(value:unknown):value is SessionCapabilitySnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const row=value as Record<string,unknown>
 if(Object.keys(row).sort().join(',')!=='requiredCapabilities,schema,sessionId,status'||row.schema!=='teloa.session-capabilities/v1'||typeof row.sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId))return false
 if(row.status==='unavailable')return row.requiredCapabilities===null
 const required=row.requiredCapabilities
 return row.status==='ready'&&Array.isArray(required)&&required.length>0&&required.length<=capabilities.size&&required.every(capability=>capabilities.has(capability))&&new Set(required).size===required.length
}
export function readSessionCapabilitySnapshot(value:unknown):SessionCapabilitySnapshot{
 if(!isSessionCapabilitySnapshot(value))throw new WorkError('teloa/invalid-host-response','工作服务返回的会话能力分类不正确。')
 return Object.freeze({schema:value.schema,sessionId:value.sessionId,...(value.status==='ready'?{status:'ready' as const,requiredCapabilities:Object.freeze([...value.requiredCapabilities])}:{status:'unavailable' as const,requiredCapabilities:null})})
}
