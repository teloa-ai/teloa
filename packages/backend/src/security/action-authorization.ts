import {createHash} from 'node:crypto'
import {WorkError,type BusinessObjectSnapshot,type SecurityActionAuthorization,type SecurityActionDefinition} from '@teloa/contract'

/**
 * 新安全动作授权的唯一 P0 声明。目录实例留在 harness composition root；backend
 * 仅依赖 contract 中的 SecurityActionDefinitionCatalog 端口。
 */
export function createSecurityEndpointIsolateDefinition():SecurityActionDefinition{
 return {
  tool:'security.endpoint.isolate',
  playbookVersion:'security.endpoint.isolate/v1',
  authorize(snapshot:BusinessObjectSnapshot,targetSet:readonly string[],params:unknown):SecurityActionAuthorization{
   const assets=securityEndpointAllowedTargets(snapshot)
   if(!Array.isArray(targetSet)||targetSet.length<1||targetSet.length>256||new Set(targetSet).size!==targetSet.length||targetSet.some(target=>!endpointId(target))||targetSet.some(target=>target!==assets[0]))throw new WorkError('teloa/forbidden','隔离目标不在固定告警资产范围内。')
   if(!plainRecord(params)||Object.keys(params).length!==1||!Object.hasOwn(params,'reason')||!reason(params.reason))throw new WorkError('teloa/invalid-input','隔离理由必须是无控制字符的非空文本，且不得携带额外参数。')
   return {tool:'security.endpoint.isolate',playbookVersion:'security.endpoint.isolate/v1',riskTier:'high',reversible:'reversible',targetSet:[...targetSet],params:{reason:params.reason}}
  },
 }
}

/** 能力展示和执行授权共用固定快照的资产边界，不伪造用户参数。 */
export function securityEndpointAllowedTargets(snapshot:BusinessObjectSnapshot):string[]{
 const assets=snapshot.fields.filter(field=>field.label==='资产').map(field=>field.value)
 if(assets.length!==1||!endpointId(assets[0]))throw new WorkError('teloa/forbidden','固定告警快照没有唯一且合法的资产。')
 return [assets[0]]
}

const endpointId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
const plainRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)
const reason=(value:unknown):value is string=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=1000&&!/[\x00-\x1f\x7f]/.test(value)

/** 安全动作共用的纯 JSON 与目标指纹。 */
function sha256(value:string){return `sha256:${createHash('sha256').update(value).digest('hex')}`}

function stableJson(value:unknown,path='params'):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw new WorkError('teloa/storage-corrupt',`${path} 含非有限数字。`)
  return JSON.stringify(value)
 }
 if(Array.isArray(value))return `[${value.map((item,index)=>stableJson(item,`${path}[${index}]`)).join(',')}]`
 if(typeof value==='object'){
  const prototype=Object.getPrototypeOf(value)
  if(prototype!==Object.prototype&&prototype!==null)throw new WorkError('teloa/storage-corrupt',`${path} 不是普通 JSON 对象。`)
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson((value as Record<string,unknown>)[key],`${path}.${key}`)}`).join(',')}}`
 }
 throw new WorkError('teloa/storage-corrupt',`${path} 含非 JSON 值。`)
}

export function securityParamFingerprint(params:Record<string,unknown>):string{return sha256(stableJson(params))}
export function securityTargetFingerprint(targetSet:readonly string[]):string{return sha256([...targetSet].sort().join('\n'))}
