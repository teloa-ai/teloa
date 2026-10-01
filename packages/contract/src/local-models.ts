import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {ollamaDigestPattern,ollamaModelNamePattern,type MarketCatalogText} from './market-catalog.ts'

/**
 * 本机模型（模型二期规格 §5–§8）：Ollama 唯一运行时。地址只由本人在设置里填写，
 * 缺省环回；路由键、占位凭据引用与最低版本为编译期常量，实施者不得改动。
 */
export const OLLAMA_DEFAULT_ADDRESS='http://127.0.0.1:11434'
export const OLLAMA_MIN_VERSION='0.6.0'
export const OLLAMA_ROUTE_KEY='ollama'
export const OLLAMA_CREDENTIAL_REF='OLLAMA_API_KEY'

export const localModelEndpoints=['local-models/overview','local-models/address','local-models/pull','local-models/pull-status','local-models/pull-cancel','local-models/remove','local-models/attach'] as const
export type LocalModelEndpoint=(typeof localModelEndpoints)[number]

export const localModelStatuses=['runtime-missing','not-pulled','pulling','verifying','ready','unverified','route-pending','missing','attached'] as const
export type LocalModelStatus=(typeof localModelStatuses)[number]
export const pullJobPhases=['pulling','verifying','done','failed','cancelled'] as const
export type PullJobPhase=(typeof pullJobPhases)[number]

export type LocalModelRow={entryId:string;version:string;variant:number;name:string;title:MarketCatalogText;quant:string;sizeBytes:number;fit:'good'|'slow'|'poor';licenseTier:'commercial'|'restricted';licenseName:string;licenseURL:string;restrictions:MarketCatalogText[];catalogDigest:string|null;status:LocalModelStatus;loaded:boolean;runtimeContextLength?:number|null}
export type PullJobView={pullId:string;name:string;phase:PullJobPhase;completed:number;total:number|null;error:string|null}
export type LocalModelsOverview={
 runtime:{state:'missing'|'running';version:string|null;outdated:boolean;address:{baseURL:string;custom:boolean;local:boolean}}
 hardware:{totalMemGb:number;unified:boolean;diskFreeBytes:number|null}
 rows:LocalModelRow[]
 offCatalog:{name:string;sizeBytes:number;family:string|null;parameterSize:string|null;loaded:boolean;runtimeContextLength?:number|null;status:'attached'|'unverified'}[]
 pull:PullJobView|null
}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const hostPattern=/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** 规格 §8 地址校验：只收 http(s) 的「协议 + 主机 + 端口」，不带账号、路径、查询或片段；IPv6 字面量须带方括号。 */
export function readOllamaAddress(value:unknown):{baseURL:string;host:string;port:number;local:boolean}{
 if(typeof value!=='string'||value.length>256||value!==value.trim())throw bad('Ollama 地址格式不正确。')
 let url:URL;try{url=new URL(value)}catch{throw bad('Ollama 地址不是合法 URL。')}
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw bad('Ollama 地址只接受 http 或 https。')
 if(url.username||url.password||url.search||url.hash||value.includes('?')||value.includes('#')||(url.pathname!=='/'&&url.pathname!==''))throw bad('Ollama 地址不得带路径、账号或查询串。')
 const port=url.port?Number(url.port):url.protocol==='https:'?443:80
 if(!Number.isInteger(port)||port<1||port>65535)throw bad('Ollama 地址端口不合法。')
 const raw=url.hostname,host=raw.startsWith('[')?raw.slice(1,-1):raw
 if(!host)throw bad('Ollama 地址主机名不合法。')
 // WHATWG URL 已校验并归一 IPv4/IPv6；共享契约只管格式，网段与 DNS 策略由宿主在写入/连接前强制校验。
 const ipKind=raw.startsWith('[')?6:/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)?4:0
 if(ipKind===0&&!hostPattern.test(host))throw bad('Ollama 地址主机名不合法。')
 const local=host==='localhost'||host==='::1'||(ipKind===4&&host.startsWith('127.'))
 return {baseURL:`${url.protocol}//${raw}:${port}`,host,port,local}
}

const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw bad('本地模型请求格式不正确或包含未知字段。')
 return value
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const catalogId=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/
const semver=/^(?=.{1,80}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const shape=()=>bad('本地模型回包格式不正确。')
const str=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max
const nonNegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const oneOf=<T extends string>(list:readonly T[],value:unknown):value is T=>(list as readonly unknown[]).includes(value)
const localizedText=(value:unknown):MarketCatalogText=>{
 const row=exact(value,['zh-CN','en'])
 if(!str(row['zh-CN'],1000)||!str(row.en,1000))throw shape()
 return {'zh-CN':row['zh-CN'],en:row.en}
}
const modelName=(value:unknown):string=>{if(!str(value,128)||!ollamaModelNamePattern.test(value))throw bad('本地模型名称格式不正确。');return value}

export function readLocalModelPullInput(value:unknown):{requestId:string;entryId:string;version:string;variant:number;acknowledgeRestrictions:boolean}{
 const row=exact(value,['requestId','entryId','version','variant','acknowledgeRestrictions'])
 if(!uuid(row.requestId)||!str(row.entryId,120)||!catalogId.test(row.entryId)||!str(row.version,80)||!semver.test(row.version)||!nonNegative(row.variant)||row.variant>5||typeof row.acknowledgeRestrictions!=='boolean')throw bad('本地模型拉取请求格式不正确。')
 return {requestId:row.requestId,entryId:row.entryId,version:row.version,variant:row.variant,acknowledgeRestrictions:row.acknowledgeRestrictions}
}
/** `baseURL:null` ＝ 恢复缺省地址；字符串按 `readOllamaAddress` 校验并归一（去尾斜杠、补端口）。 */
export function readLocalModelAddressInput(value:unknown):{requestId:string;baseURL:string|null}{
 const row=exact(value,['requestId','baseURL'])
 if(!uuid(row.requestId))throw bad('本地模型地址请求格式不正确。')
 return {requestId:row.requestId,baseURL:row.baseURL===null?null:readOllamaAddress(row.baseURL).baseURL}
}
/** 供 remove / attach / pull-cancel：只带 Ollama 模型名称。 */
export function readLocalModelNameInput(value:unknown):{requestId:string;name:string}{
 const row=exact(value,['requestId','name'])
 if(!uuid(row.requestId))throw bad('本地模型请求格式不正确。')
 return {requestId:row.requestId,name:modelName(row.name)}
}

/** 浏览器确认绑定实际目标；字段在宿主状态锁内复核，不允许确认后换服务。 */
export function readLocalModelPullRequest(value:unknown){
 const {expectedAddress,...input}=exact(value,['requestId','entryId','version','variant','acknowledgeRestrictions','expectedAddress'])
 return {...readLocalModelPullInput(input),expectedAddress:readOllamaAddress(expectedAddress).baseURL}
}
export function readLocalModelTargetNameInput(value:unknown){
 const {expectedAddress,...input}=exact(value,['requestId','name','expectedAddress'])
 return {...readLocalModelNameInput(input),expectedAddress:readOllamaAddress(expectedAddress).baseURL}
}

export function readPullJobView(value:unknown):PullJobView{
 const row=exact(value,['pullId','name','phase','completed','total','error'])
 if(!uuid(row.pullId)||!oneOf(pullJobPhases,row.phase)||!nonNegative(row.completed)||(row.total!==null&&!nonNegative(row.total))||(row.error!==null&&!str(row.error,1000)))throw shape()
 return {pullId:row.pullId,name:modelName(row.name),phase:row.phase,completed:row.completed,total:row.total as number|null,error:row.error as string|null}
}
/** 兼容旧宿主的缺省字段；缺省/空值不能冒充已知容量。 */
function readRuntimeContext(row:Record<string,unknown>):{runtimeContextLength?:number|null}{
 if(!Object.hasOwn(row,'runtimeContextLength'))return {}
 const value=row.runtimeContextLength
 if(value!==null&&(!nonNegative(value)||value===0||row.loaded!==true))throw shape()
 return {runtimeContextLength:value as number|null}
}
function readLocalModelRow(value:unknown):LocalModelRow{
 const row=exact(value,['entryId','version','variant','name','title','quant','sizeBytes','fit','licenseTier','licenseName','licenseURL','restrictions','catalogDigest','status','loaded',...(isRecord(value)&&Object.hasOwn(value,'runtimeContextLength')?['runtimeContextLength']:[])])
 if(!str(row.entryId,120)||!catalogId.test(row.entryId)||!str(row.version,80)||!semver.test(row.version)||!nonNegative(row.variant)||row.variant>5)throw shape()
 if(!str(row.quant,16)||!/^[A-Za-z0-9_]{1,16}$/.test(row.quant)||!nonNegative(row.sizeBytes)||!oneOf(['good','slow','poor'] as const,row.fit)||!oneOf(['commercial','restricted'] as const,row.licenseTier))throw shape()
 if(!str(row.licenseName,256)||!str(row.licenseURL,2048))throw shape()
 try{const url=new URL(row.licenseURL);if(url.protocol!=='https:'||url.username||url.password)throw shape()}catch{throw shape()}
 if(!Array.isArray(row.restrictions)||row.restrictions.length>20||(row.catalogDigest!==null&&(typeof row.catalogDigest!=='string'||!ollamaDigestPattern.test(row.catalogDigest)))||!oneOf(localModelStatuses,row.status)||typeof row.loaded!=='boolean')throw shape()
 return {entryId:row.entryId,version:row.version,variant:row.variant,name:modelName(row.name),title:localizedText(row.title),quant:row.quant,sizeBytes:row.sizeBytes,fit:row.fit,licenseTier:row.licenseTier,licenseName:row.licenseName,licenseURL:row.licenseURL,restrictions:row.restrictions.map(localizedText),catalogDigest:row.catalogDigest as string|null,status:row.status,loaded:row.loaded,...readRuntimeContext(row)}
}
export function readLocalModelsOverview(value:unknown):LocalModelsOverview{
 const row=exact(value,['runtime','hardware','rows','offCatalog','pull'])
 const runtime=exact(row.runtime,['state','version','outdated','address']),address=exact(runtime.address,['baseURL','custom','local']),hardware=exact(row.hardware,['totalMemGb','unified','diskFreeBytes'])
 if(!oneOf(['missing','running'] as const,runtime.state)||(runtime.version!==null&&!str(runtime.version,64))||typeof runtime.outdated!=='boolean'||typeof address.custom!=='boolean'||typeof address.local!=='boolean')throw shape()
 const parsed=readOllamaAddress(address.baseURL)
 if(typeof hardware.totalMemGb!=='number'||!Number.isFinite(hardware.totalMemGb)||hardware.totalMemGb<0||typeof hardware.unified!=='boolean'||(hardware.diskFreeBytes!==null&&!nonNegative(hardware.diskFreeBytes)))throw shape()
 if(!Array.isArray(row.rows)||row.rows.length>200||!Array.isArray(row.offCatalog)||row.offCatalog.length>500)throw shape()
 const offCatalog=row.offCatalog.map(item=>{
  const m=exact(item,['name','sizeBytes','family','parameterSize','loaded','status',...(isRecord(item)&&Object.hasOwn(item,'runtimeContextLength')?['runtimeContextLength']:[])])
  if(!nonNegative(m.sizeBytes)||(m.family!==null&&!str(m.family,64))||(m.parameterSize!==null&&!str(m.parameterSize,32))||typeof m.loaded!=='boolean'||!oneOf(['attached','unverified'] as const,m.status))throw shape()
  return {name:modelName(m.name),sizeBytes:m.sizeBytes,family:m.family as string|null,parameterSize:m.parameterSize as string|null,loaded:m.loaded,status:m.status,...readRuntimeContext(m)}
 })
 return {
  runtime:{state:runtime.state,version:runtime.version as string|null,outdated:runtime.outdated,address:{baseURL:parsed.baseURL,custom:address.custom,local:address.local}},
  hardware:{totalMemGb:hardware.totalMemGb,unified:hardware.unified,diskFreeBytes:hardware.diskFreeBytes as number|null},
  rows:row.rows.map(readLocalModelRow),offCatalog,pull:row.pull===null?null:readPullJobView(row.pull),
 }
}
