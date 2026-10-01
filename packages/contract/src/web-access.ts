import {WorkError} from './work-error.ts'

export const webAccessKinds=['search','fetch'] as const
export type WebAccessKind=typeof webAccessKinds[number]
/** 一次已放行的外发：value 对 search 是逐字查询词数组的序列化，对 fetch 是逐字 URL。 */
export type WebAccessEntry={kind:WebAccessKind;value:string;at:string}
export type WebAccessPolicy={version:number;enabled:boolean;blocked:string[]}
export type WebAccessPolicyChangeInput={requestId:string;expectedVersion:number;enabled:boolean;blocked:string[]}

export const webAccessEntryMaxChars=512
export const webAccessBlockedMax=128

const fail=():never=>{throw new WorkError('teloa/invalid-input','上网请求包含未知字段或格式不正确。')}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const nonNegativeInt=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))

/** 拦截名单的一行：主机名，不接受 scheme／端口／路径／通配符／IP 字面量。 */
export function isWebAccessBlockedHost(value:unknown):value is string{
 if(typeof value!=='string'||value.length<1||value.length>253)return false
 if(value!==value.toLowerCase()||!/^[a-z0-9.-]+$/.test(value))return false
 if(value.startsWith('.')||value.endsWith('.')||value.startsWith('-')||value.endsWith('-')||value.includes('..'))return false
 // 纯 IPv4 字面量交给 provider 的私网硬禁；放进名单只会让本人以为自己拦住了一类地址。
 // IPv6 的方括号字面量（`[::1]`、`[fd00::1]`）连上面那条字符集都过不去（`[`／`]`／`:` 都不在里面），
 // 所以同样进不了名单：地址族这一维一律交给 provider 的私网硬禁，本判据不假装能拦。
 return !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)
}

/**
 * 主机名匹配：完全相等，或以 '.'+rule 结尾。
 * example.com 拦 example.com 与 a.example.com，**不拦** notexample.com。
 * 不做通配符、不做正则、不做路径匹配——这三样都是给人写错的机会。
 */
export function webHostBlocked(blocked:readonly string[],host:string):boolean{
 const target=host.toLowerCase()
 return blocked.some(rule=>target===rule||target.endsWith('.'+rule))
}

/** URL 文本 → 归一化小写主机名；解析不出来、非 http(s)、带内嵌凭据一律 null。 */
export function webAccessHost(value:unknown):string|null{
 if(typeof value!=='string'||!value||value.length>2048)return null
 try{
  const url=new URL(value)
  if(url.protocol!=='http:'&&url.protocol!=='https:')return null
  if(url.username||url.password)return null
  // URL 的 hostname 已按 IDNA 归一（punycode），这里只补一次小写。
  const host=url.hostname.toLowerCase().replace(/\.$/,'')
  return host?host:null
 }catch{return null}
}

export function isWebAccessPolicy(value:unknown):value is WebAccessPolicy{
 if(!record(value)||Object.keys(value).length!==3)return false
 if(!Number.isSafeInteger(value.version)||(value.version as number)<0||typeof value.enabled!=='boolean')return false
 const blocked=value.blocked
 return Array.isArray(blocked)&&blocked.length<=webAccessBlockedMax&&blocked.every(isWebAccessBlockedHost)&&new Set(blocked).size===blocked.length
}

/** 一次上网记录读口结果的解析：kind 只认判别联合两值，value 上限 512 字符，at 为可解析的时间戳字符串。 */
export function readWebAccessEntry(value:unknown):WebAccessEntry{
 const row=exact(value,['kind','value','at'])
 if(!webAccessKinds.includes(row.kind as WebAccessKind))fail()
 if(typeof row.value!=='string'||!row.value||row.value.length>webAccessEntryMaxChars)fail()
 if(!stamp(row.at))fail()
 return {kind:row.kind as WebAccessKind,value:row.value as string,at:row.at as string}
}

/** 策略改写入参：白名单恰好四键；blocked 过 isWebAccessPolicy 同一套判据。 */
export function webAccessPolicyChangeInput(value:unknown):WebAccessPolicyChangeInput{
 const row=exact(value,['requestId','expectedVersion','enabled','blocked'])
 if(!uuid(row.requestId)||!nonNegativeInt(row.expectedVersion)||typeof row.enabled!=='boolean')fail()
 const blocked=row.blocked
 if(!Array.isArray(blocked)||blocked.length>webAccessBlockedMax||!blocked.every(isWebAccessBlockedHost)||new Set(blocked).size!==blocked.length)fail()
 return {requestId:row.requestId as string,expectedVersion:row.expectedVersion as number,enabled:row.enabled as boolean,blocked:blocked as string[]}
}
