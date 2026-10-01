import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PostToolDecision,type PreToolDecision,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,detectSecrets,encodedForms,isForbiddenModelHeader,isRecord,normalizedHeaderName,redactSecrets,skillSecretPathAllowed,webHostBlocked,type MarketCatalogSkillSecret,type TaskToolArgumentRule,type WebAccessPolicy} from '@teloa/contract'
import {pinnedHttpsRequest,resolveOutboundAddresses,type PinnedInit,type PublicAddress} from './public-address.ts'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'

/**
 * teloa_skill_http（规格 §5）：模型调用目录声明的精确 origin + 路径前缀，密钥由宿主在请求当下注入。
 * 任何分支都不把密钥写进返回值、错误或日志；被拒调用写 deny 审计。参数另经全局 credential-guards 守卫，结果另经全局脱敏（第二道）。
 * 上网策略（规格 §13.1 裁定）：与 web_fetch 同一总开关、同一拦截名单、同一文案。
 */
export const skillHttpToolName='teloa_skill_http'
/**
 * 被拒原因码（宿主审计字段，非 WorkError 码）；approval：非 GET 确认阶段被拒（权限模式 never、本人拒卡，或审批瀑布无答复者/无通道而由 DSH 按拒绝处理）；
 * caller：调用时授权被拒（规格 2026-09-27 §5.4 审查修复 R1 L-2：未授予、技能未勾选、不在运行快照、安装已变、子代理、群路由、非本人普通会话等）。
 */
export type SkillHttpDenyReason='input'|'rate'|'visibility'|'policy'|'endpoint'|'method'|'header'|'binding'|'missing'|'store-locked'|'address'|'redirect'|'approval'|'caller'
export type SkillHttpAuditEvent=
 |{event:'skill-secret.use';skill:string;envVarNames:string[];origin:string;pathPrefix:string;method:string;status:number;bytes:number;redacted:number;sessionId:string;runId?:string;roleId?:string;group?:string}
 |{event:'skill-secret.deny';skill:string;reason:SkillHttpDenyReason;origin:string;method:string;sessionId:string;runId?:string;roleId?:string;group?:string}
/** 调用方身份：本人普通会话只有 sessionId；任务执行会话另带运行与岗位（规格 2026-09-27 §5.4，只进审计）。 */
export type SkillHttpCaller={sessionId:string;runId?:string;roleId?:string}
export type SkillHttpPorts={
 skillVisible:(skill:string)=>Promise<boolean>
 readForUse:(skill:string)=>Promise<{secrets:MarketCatalogSkillSecret[];values:Record<string,string>;stale:boolean;group?:string}>
 allow:(skill:string)=>boolean
 webPolicy:()=>Promise<WebAccessPolicy>
 resolve:(host:string,signal:AbortSignal)=>Promise<PublicAddress[]>
 request:(url:URL,init:PinnedInit,addresses:readonly PublicAddress[])=>Promise<Response>
 audit:(event:SkillHttpAuditEvent)=>void
}
/** 每技能滑动窗口限频（默认每分钟 30 次）；只记时间戳。 */
export function createSkillRateLimiter(limit=30,windowMs=60_000,now=()=>Date.now()){
 const hits=new Map<string,number[]>()
 return (skill:string)=>{
  const t=now(),recent=(hits.get(skill)??[]).filter(x=>t-x<windowMs)
  const ok=recent.length<limit
  if(ok)recent.push(t)
  hits.set(skill,recent)
  return ok
 }
}
const invalid=(m:string)=>new WorkError('teloa/invalid-input',m)
const forbidden=(m:string)=>new WorkError('teloa/forbidden',m)
const methods=['GET','POST','PUT','PATCH','DELETE'] as const
type Method=typeof methods[number]
const skillName=/^[a-z][a-z0-9-]{0,63}$/
/**
 * 模型可设的基础请求头（规格 §5.1-5）；另加本次适用声明的 allowHeaders（规格 2026-09-27 §4.3），其余一律拒绝——
 * Range/If-Range 可分段取密钥绕过整值脱敏，Accept-Encoding 让正文不可脱敏，方法覆盖头绕过方法白名单。比较一律用归一化名（_→-）。
 */
const baseHeaders=['accept','accept-language','content-type','user-agent','idempotency-key']
const headerName=/^[A-Za-z0-9_-]{1,64}$/
/**
 * 头值（审查 R1 L1）：RFC 9110 field-value 的 field-vchar 与其间的 SP/HTAB；obs-text（0x80–0xFF）按 RFC「新发送方不应生成」不收，
 * 非 Latin-1 字符同样拒绝——在读取密钥之前即拒并记 deny，而不是到发送层才抛 ERR_INVALID_CHAR。行首尾空白已先裁掉。
 */
const headerValue=/^[\t\x20-\x7e]{0,1024}$/
/** 回模型的 contentType 只取允许集合内的值（规格 §5.2-6 列出的文本类；application/*+json 归一为 application/json）；其余一律归一为 application/octet-stream 且不读正文——上游把注入头回显进 Content-Type 也带不出片段。 */
const allowedTypes=new Set(['text/plain','text/html','text/csv','text/markdown','text/xml','text/javascript','text/css','application/json','application/xml','application/x-ndjson'])
const vendorJson=/^application\/[a-z0-9.-]{1,50}\+json$/
const readableContentType=(raw:string)=>{const mime=raw.split(';')[0]!.trim().toLowerCase();return allowedTypes.has(mime)?mime:vendorJson.test(mime)?'application/json':undefined}
const maxBody=256*1024,readMargin=16*1024,timeoutMs=30_000,maxRedirects=3
type Input={skill:string;method:Method;url:URL;headers:Record<string,string>;body?:string}
function readInput(args:unknown):Input{
 const keys=['skill','method','url','headers','body']
 if(!isRecord(args)||Object.keys(args).some(key=>!keys.includes(key)))throw invalid('teloa_skill_http 参数只允许 skill、method、url、headers、body。')
 if(typeof args.skill!=='string'||!skillName.test(args.skill))throw invalid('skill 格式不正确。')
 if(!(methods as readonly unknown[]).includes(args.method))throw invalid('method 只能是 GET、POST、PUT、PATCH、DELETE。')
 let url:URL
 try{if(typeof args.url!=='string'||args.url.length>2048)throw Error();url=new URL(args.url)}catch{throw invalid('url 格式不正确。')}
 if(url.protocol!=='https:'||url.username||url.password||url.port)throw invalid('url 只允许不带账号与端口的 https 地址。')
 const headers:Record<string,string>={}
 if(args.headers!==undefined){
  if(typeof args.headers!=='string'||args.headers.length>8192)throw invalid('headers 须为每行一个 Name: value 的文本。')
  for(const line of args.headers.split('\n').map(item=>item.trim()).filter(Boolean)){
   // 此处只做语法校验；名字授权要等匹配到适用声明之后（allowHeaders 按声明放开）。
   const match=/^([^:\s]+):[\t ]*(.*)$/.exec(line)
   if(!match||!headerName.test(match[1]!)||!headerValue.test(match[2]!))throw invalid('headers 须为每行一个 Name: value 的文本；值只允许可见 ASCII 字符、空格与制表符，最长 1024 字符。')
   // 按归一名去重（审查 R1 M2）：CGI 类后端把 - 与 _ 映射为同一变量，同名两值由后端决定取舍，等于让模型制造歧义。
   const normalized=normalizedHeaderName(match[1]!)
   if(Object.keys(headers).some(name=>normalizedHeaderName(name)===normalized))throw invalid(`请求头 ${match[1]} 重复（大小写与 _、- 视为同一请求头）。`)
   headers[match[1]!.toLowerCase()]=match[2]!
  }
 }
 if(args.body!==undefined&&(typeof args.body!=='string'||args.body.length>1_000_000||args.method==='GET'))throw invalid('body 须为 1 MB 以内文本，且 GET 不带 body。')
 return {skill:args.skill,method:args.method as Method,url,headers,...(typeof args.body==='string'?{body:args.body}:{})}
}
const endpointAllows=(s:MarketCatalogSkillSecret,url:URL)=>s.endpoints.some(ep=>ep.origin===url.origin&&skillSecretPathAllowed(url.pathname,ep.pathPrefixes))
/** 找到 url 所属的声明与前缀（首跳）。 */
function matchEndpoint(secrets:readonly MarketCatalogSkillSecret[],url:URL):{applicable:MarketCatalogSkillSecret[];pathPrefix:string}|undefined{
 const applicable=secrets.filter(s=>endpointAllows(s,url))
 if(!applicable.length)return undefined
 const prefixes=applicable[0]!.endpoints.find(ep=>ep.origin===url.origin)!.pathPrefixes
 return {applicable,pathPrefix:prefixes.find(prefix=>skillSecretPathAllowed(url.pathname,[prefix]))??'/'}
}
const hasQueryParam=(url:URL,name:string)=>{const target=name.toLowerCase();for(const key of url.searchParams.keys())if(key.toLowerCase()===target)return true;return false}
/** 读到 maxBody+余量（留给跨边界脱敏）；异常、中止或超限一律取消读取并释放连接。回原始字节，解码另行处理。 */
async function readCapped(response:Response):Promise<{data:Buffer;over:boolean;bytes:number}>{
 const reader=response.body?.getReader()
 if(!reader)return {data:Buffer.alloc(0),over:false,bytes:0}
 const chunks:Uint8Array[]=[],cap=maxBody+readMargin;let size=0,finished=false
 try{
  for(;;){
   const {done,value}=await reader.read()
   if(done){finished=true;break}
   if(size+value.byteLength>cap){chunks.push(value.subarray(0,cap-size));size=cap+1;break}
   chunks.push(value);size+=value.byteLength
  }
 }finally{
  if(!finished)await reader.cancel().catch(()=>{})
  reader.releaseLock()
 }
 return {data:Buffer.concat(chunks),over:size>maxBody,bytes:Math.min(size,cap)}
}
const utf8Label=/^(utf-?8|us-ascii|ascii)$/i
/** UTF-16/UTF-32 BOM（FF FE 也覆盖 UTF-32LE 的 FF FE 00 00）。 */
const wideBom=(b:Buffer)=>(b[0]===0xff&&b[1]===0xfe)||(b[0]===0xfe&&b[1]===0xff)||(b[0]===0&&b[1]===0&&b[2]===0xfe&&b[3]===0xff)
/**
 * 解码正文（审查 R1 M-2 裁定）：只接受 UTF-8（含 ASCII）文本，不做任何编码猜测——声明 charset 非 utf-8、带 UTF-16/UTF-32 BOM、或出现 NUL 字节即回 undefined（按非文本响应处理）；
 * UTF-8 fatal 解码失败同样拒绝。脱敏在原始字节的 UTF-8 解码结果上进行。切点字符下标由前 maxBody 字节流式解码得到：按原文字节定位且不切开多字节字符（跨界字符归入切点之后）。
 */
function decodeBody(data:Buffer,over:boolean,rawContentType:string):{text:string;cut:number}|undefined{
 const declared=/;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(rawContentType)?.[1]
 if((declared!==undefined&&!utf8Label.test(declared))||wideBom(data)||data.includes(0))return undefined
 try{
  const decoder=new TextDecoder('utf-8',{fatal:true})
  const head=decoder.decode(data.subarray(0,maxBody),{stream:true}),tail=decoder.decode(data.subarray(maxBody),{stream:over})
  return {text:head+tail,cut:over?head.length:head.length+tail.length}
 }catch{return undefined}
}
/**
 * 先脱敏后截断（规格 §5.4）：切点按原文字节定在 maxBody；跨切点的完整命中整段保留后替换，切点之后（含读取上限处被切开的残片）一律丢弃。
 * 余量 16 KiB ≥ 最长编码形态（4096 字符值 URL 编码 ≤ 12 KiB），跨 maxBody 的命中必然完整落在读取窗口内。
 */
function redactThenCut(text:string,cut:number,secretValues:readonly string[]):string{
 let end=cut
 for(const finding of detectSecrets(text,secretValues.flatMap(encodedForms)))if(finding.start<cut&&finding.end>end)end=finding.end
 return redactSecrets(text.slice(0,end),secretValues)
}
/** 审计里的原始调用字段：技能名与方法不合文法时记 (invalid)，origin 只取合法 https 地址的 origin（不记路径与查询串）。 */
const rawSkillOf=(args:unknown)=>isRecord(args)&&typeof args.skill==='string'&&skillName.test(args.skill)?args.skill:'(invalid)'
const rawMethodOf=(args:unknown)=>isRecord(args)&&(methods as readonly unknown[]).includes(args.method)?String(args.method):'(invalid)'
const rawOriginOf=(args:unknown)=>{if(!isRecord(args)||typeof args.url!=='string')return '';try{const url=new URL(args.url);return url.protocol==='https:'?url.origin:''}catch{return ''}}
/**
 * 本人在授权页逐项勾选的技能（规格 2026-09-27 §5.1 审查修复 R1 M-1）：授权记录形如 `{name:'teloa_skill_http',allowed:[{skill}]}`。
 * 整工具形状（anyArguments）或缺记录一律视为没有勾选任何技能。
 */
export function skillHttpGrantedSkills(rules:readonly TaskToolArgumentRule[]|undefined):string[]{
 const rule=rules?.find(item=>item.name===skillHttpToolName)
 if(!rule||rule.anyArguments===true)return []
 return rule.allowed.flatMap(args=>Object.keys(args).length===1&&typeof args.skill==='string'&&skillName.test(args.skill)?[args.skill]:[])
}
/** 审计身份字段：只含 sessionId 与（任务会话才有的）runId、roleId，缺省即省略。 */
const callerFields=(caller:SkillHttpCaller):SkillHttpCaller=>({sessionId:caller.sessionId,...(caller.runId===undefined?{}:{runId:caller.runId}),...(caller.roleId===undefined?{}:{roleId:caller.roleId})})
/** 任务会话调用时授权所需的运行快照（`TaskRun` 的子集）。 */
export type SkillHttpRunSnapshot={id:string;roleId:string;sessionId:string;skills:readonly {name:string;provider:string;managed?:{installationId:string}}[]}
export type SkillHttpAuthorizePorts={
 /** 谱系上溯读口（传 ctx）；与任务工具守卫、岗位记忆共用 `resolveSessionLineage`。 */
 agents:Parameters<typeof resolveSessionLineage<LineageSession>>[0]['agents']
 isRouting:(sessionId:string)=>boolean
 /** 与 `registerTaskToolGuard` 同一来源的运行策略（含本人勾选的技能记录）；null 表示普通会话。 */
 policy:(sessionId:string,signal:AbortSignal)=>Promise<{allowedTools:readonly string[];argumentRules?:readonly TaskToolArgumentRule[]}|null>
 /** 会话绑定的运行（含岗位技能快照）；普通会话 null。 */
 run:(sessionId:string,signal:AbortSignal)=>Promise<SkillHttpRunSnapshot|null>
 /** 技能名当前选定的受管安装 id；未安装 undefined。 */
 selectedInstallation:(skill:string,signal:AbortSignal)=>Promise<string|undefined>
 /** 本人普通会话且本轮有真实用户指令（原有路径）；失败抛 WorkError。 */
 ordinary:(exec:ToolExecution)=>Promise<string>
 /** 被拒即记 `skill-secret.deny reason caller`（审查修复 R1 L-2）；只含技能名、方法、origin 与已知的会话/运行/岗位标识。 */
 audit?:(event:SkillHttpAuditEvent)=>void
}
/**
 * 调用时授权（规格 2026-09-27 §5.2）：只有两条放行路径，其余一律 `teloa/forbidden`。
 * 1. 本人普通会话（运行策略为 null）→ 原有路径不变；
 * 2. 任务执行会话 → 本次运行 `allowedTools` 含本工具，且 `args.skill` 是本人在「员工 → 能力」逐项勾选的技能（审查修复 R1 M-1），
 *    并在运行岗位技能快照里、快照中为受管安装且其 installationId 等于当前选定安装。
 * 子代理会话（含任务运行派生的）与群路由会话先于读策略拒绝。每次调用现读策略，撤销或取消勾选即时生效；被拒记 deny caller 审计。
 */
export function createSkillHttpAuthorizer(ports:SkillHttpAuthorizePorts):(exec:ToolExecution,args:unknown)=>Promise<SkillHttpCaller>{
 const hostRead=async<T>(read:()=>Promise<T>):Promise<T>=>{try{return await read()}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/host-unavailable','技能接口授权服务暂不可用，请稍后重试。')}}
 const check=async(exec:ToolExecution,args:unknown,known:SkillHttpCaller):Promise<SkillHttpCaller>=>{
  const session=exec.agent?.session
  if(!session)return {sessionId:await ports.ordinary(exec)}
  let root:LineageSession
  try{root=resolveSessionLineage(ports,session).root}catch{throw forbidden('无法核对调用会话的来源，已拒绝。')}
  if(root.id!==session.id)throw forbidden('子 Agent 会话不能调用技能接口。')
  if(ports.isRouting(root.id))throw forbidden('群路由会话不能调用技能接口。')
  const policy=await hostRead(()=>ports.policy(root.id,exec.signal))
  if(policy===null)return {sessionId:await ports.ordinary(exec)}
  if(!policy.allowedTools.includes(skillHttpToolName))throw forbidden('本员工未获授权使用技能接口代发；需要时请在运行结论里说明，由本人到「员工 > 能力」授予。')
  const skill=isRecord(args)&&typeof args.skill==='string'?args.skill:undefined
  if(skill===undefined||!skillHttpGrantedSkills(policy.argumentRules).includes(skill))throw forbidden('本人未勾选该技能的接口代发授权；需要时请在运行结论里说明，由本人到「员工 > 能力」勾选。')
  const run=await hostRead(()=>ports.run(root.id,exec.signal))
  if(!run||run.sessionId!==root.id)throw forbidden('无法核对本次运行，已拒绝。')
  known.runId=run.id;known.roleId=run.roleId
  const snapshot=run.skills.find(item=>item.name===skill)
  if(!snapshot)throw forbidden('该技能不在本次运行的员工技能中。')
  if(snapshot.provider!=='teloa-market'||!snapshot.managed)throw forbidden('只有市场受管安装的技能可以在员工任务中代发。')
  if(await hostRead(()=>ports.selectedInstallation(snapshot.name,exec.signal))!==snapshot.managed.installationId)throw forbidden('该技能的安装已变化，请重新准备本次执行。')
  return {sessionId:root.id,runId:run.id,roleId:run.roleId}
 }
 return async(exec,args)=>{
  const known:SkillHttpCaller={sessionId:exec.agent?.session.id??''}
  try{return await check(exec,args,known)}catch(error){
   if(error instanceof WorkError&&(error.code==='teloa/forbidden'||error.code==='teloa/not-bound'))ports.audit?.({event:'skill-secret.deny',skill:rawSkillOf(args),reason:'caller',origin:rawOriginOf(args),method:rawMethodOf(args),...callerFields(known)})
   throw error
  }
 }
}
/** 校验 → 限频 → 可见性 → 上网策略 → 现读密钥 → 地址/方法/指纹 → 注入 → 公网校验钉住请求（逐跳复判全部声明与方法） → 先脱敏后截断 → 审计。 */
export async function runSkillHttp(ports:SkillHttpPorts,args:unknown,signal:AbortSignal,caller:SkillHttpCaller={sessionId:''}):Promise<string>{
 const who=callerFields(caller)
 const rawSkill=rawSkillOf(args),rawMethod=rawMethodOf(args)
 let origin='',group:string|undefined
 const deny=(reason:SkillHttpDenyReason,error:WorkError)=>{ports.audit({event:'skill-secret.deny',skill:rawSkill,reason,origin,method:rawMethod,...who,...(group===undefined?{}:{group})});return error}
 let input:Input
 try{input=readInput(args)}catch(error){throw error instanceof WorkError?deny('input',error):error}
 origin=input.url.origin
 if(!ports.allow(input.skill))throw deny('rate',forbidden('该技能调用过于频繁，请稍后再试。'))
 if(!(await ports.skillVisible(input.skill)))throw deny('visibility',forbidden('该技能未安装或已停用。'))
 const policy=await ports.webPolicy()
 if(!policy.enabled)throw deny('policy',forbidden('设置中已关闭网页搜索与读取。'))
 if(webHostBlocked(policy.blocked,input.url.hostname))throw deny('policy',forbidden('目标网站在拦截名单里。'))
 // 密钥只在此刻读取，不缓存。存储锁定：不发请求、回稳定状态与设置页引导、deny store-locked；技能未声明密钥：deny endpoint。
 let stored:Awaited<ReturnType<SkillHttpPorts['readForUse']>>
 try{stored=await ports.readForUse(input.skill)}catch(error){
  if(error instanceof WorkError&&error.code==='teloa/storage-unavailable'){deny('store-locked',error);return JSON.stringify({status:'store-locked',message:'密钥存储已锁定：请到 设置 > 密钥存储 处理后重试，不要把密钥发到会话。',configure:{page:'settings/credential-store',skill:input.skill}})}
  if(error instanceof WorkError&&error.code==='teloa/invalid-input')throw deny('endpoint',forbidden('该技能没有写明需要密钥，不能通过 teloa_skill_http 调用。'))
  throw error
 }
 const {secrets,values,stale}=stored
 group=stored.group
 const matched=matchEndpoint(secrets,input.url)
 if(!matched)throw deny('endpoint',forbidden('该地址不在技能写明的密钥目标地址中（origin 或路径前缀不符），已拒绝。'))
 const {applicable}=matched
 if(applicable.some(s=>!s.methods.includes(input.method)))throw deny('method',forbidden(`方法 ${input.method} 不在该技能写明的密钥目标中，已拒绝。`))
 const given=Object.keys(input.headers)
 for(const s of applicable){
  // 重名按归一化名比对（规格 §4.2）：CGI 类后端把 em-api-key 与 em_api_key 映射成同一变量。
  if(s.target==='header'&&given.some(name=>normalizedHeaderName(name)===normalizedHeaderName(s.name!)))throw deny('header',forbidden(`请求头 ${s.name} 由 Teloa 注入，不允许由模型设置。`))
  if(s.target==='query'&&hasQueryParam(input.url,s.name!))throw deny('header',forbidden(`查询参数 ${s.name} 由 Teloa 注入，不允许由模型设置。`))
 }
 // 名字授权：基础 5 个 ∪ 本次适用声明的 allowHeaders；模型禁用头即便被声明也不放行（契约读取期已拒，这里纵深防御）。
 const extra=applicable.flatMap(s=>s.allowHeaders??[]),permitted=new Set([...baseHeaders,...extra].map(normalizedHeaderName))
 for(const name of given)if(!permitted.has(normalizedHeaderName(name))||isForbiddenModelHeader(name))throw deny('input',forbidden(`请求头 ${name} 不允许由模型设置（只允许 Accept、Accept-Language、Content-Type、User-Agent、Idempotency-Key${extra.length?'、'+extra.join('、'):''}）。`))
 const configure={page:'market/skill-secrets',skill:input.skill,vars:applicable.map(s=>s.envVarName)}
 if(stale){deny('binding',forbidden(''));return JSON.stringify({status:'reconfirm-secrets',reconfirm:true,message:'该技能的密钥用途已随目录更新变化：请到 市场 > 技能 > 该技能 > 密钥 重新确认保存，不要发到会话。',configure})}
 const missing=applicable.filter(s=>s.required&&!values[s.envVarName]).map(s=>s.envVarName)
 if(missing.length){deny('missing',forbidden(''));return JSON.stringify({status:'missing-secrets',message:'缺少密钥：请到 市场 > 技能 > 该技能 > 密钥 填写，不要发到会话。',configure:{...configure,vars:missing}})}
 // 强制 identity：压缩正文无法脱敏。模型不能设置该头（白名单外）。
 const headers:Record<string,string>={...input.headers,'accept-encoding':'identity'},used:string[]=[]
 // query 注入只在原查询串末尾追加，不重写模型给的编码；跳转目标若已带同名参数（上游自带）则不重复追加。
 const inject=(url:URL)=>{for(const s of applicable){const value=values[s.envVarName];if(!value)continue;if(s.target==='bearer')headers.authorization=`Bearer ${value}`;else if(s.target==='header')headers[s.name!.toLowerCase()]=value;else if(!hasQueryParam(url,s.name!))url.search=(url.search?url.search+'&':'?')+encodeURIComponent(s.name!)+'='+encodeURIComponent(value)}}
 for(const s of applicable)if(values[s.envVarName])used.push(s.envVarName)
 const secretValues=used.map(name=>values[name]!)
 /** 每一跳：首跳全部适用声明都必须允许新目标（origin + 段边界前缀）与新方法，否则整体拒绝——不带任何密钥到其声明之外。 */
 const stillAllowed=(url:URL,m:string)=>applicable.every(s=>(s.methods as readonly string[]).includes(m)&&endpointAllows(s,url))
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])
 const omittedText='非文本响应，已省略正文。',omitted={text:omittedText,cut:omittedText.length,over:false,bytes:0}
 let response!:Response,current=new URL(input.url),method:string=input.method,body=input.body,contentType='',raw=omitted
 try{
  for(let hop=0;;hop++){
   inject(current)
   const addresses=await ports.resolve(current.hostname,deadline)
   response=await ports.request(current,{method,headers,...(body!==undefined?{body}:{}),signal:deadline},addresses)
   const location=response.headers.get('location')
   if(response.status<300||response.status>=400||!location)break
   await response.body?.cancel().catch(()=>{})
   let next:URL
   try{next=new URL(location,current)}catch{throw new WorkError('teloa/forbidden','对方服务返回的跳转地址无法解析，已拒绝。')}
   next.username='';next.password=''
   const nextMethod=response.status===303?'GET':method
   if(hop>=maxRedirects||next.origin!==origin||next.port||!stillAllowed(next,nextMethod))throw new WorkError('teloa/forbidden','对方服务跳转到未写明的地址或方法，或跳转次数过多，已拒绝。')
   if(response.status===303){method='GET';body=undefined}
   current=next
  }
  // 回模型只给允许集合内的 MIME 本体（小写、去参数）；参数里的 charset 只用于解码校验。
  const rawType=response.headers.get('content-type')??'',readable=readableContentType(rawType)
  contentType=readable??'application/octet-stream'
  // Content-Encoding 非 identity、Transfer-Encoding 除 chunked（Node 已解帧）/identity 外一律不读正文、不透传：压缩或编码后的正文无法脱敏。
  const tokens=(name:string)=>(response.headers.get(name)??'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)
  const plain=tokens('content-encoding').every(x=>x==='identity')&&tokens('transfer-encoding').every(x=>x==='identity'||x==='chunked')
  if(readable!==undefined&&plain){
   const read=await readCapped(response),decoded=decodeBody(read.data,read.over,rawType)
   raw=decoded?{...decoded,over:read.over,bytes:read.bytes}:omitted
  }else{await response.body?.cancel().catch(()=>{});raw=omitted}
 }catch(error){
  if(error instanceof WorkError&&error.code==='teloa/forbidden')throw deny(/跳转/.test(error.message)?'redirect':'address',error)
  if(error instanceof WorkError)throw error
  throw new WorkError('teloa/source-unavailable',`请求失败：${error instanceof Error?error.name:'Error'}。`)
 }
 // 契约不回次数，按掩码出现次数计。
 const text=redactThenCut(raw.text,raw.cut,secretValues)
 const redacted=text.split('[已隐藏]').length-1
 ports.audit({event:'skill-secret.use',skill:input.skill,envVarNames:used,origin,pathPrefix:matched.pathPrefix,method,status:response.status,bytes:raw.bytes,redacted,...who,...(group===undefined?{}:{group})})
 return JSON.stringify({status:response.status,contentType,truncated:raw.over,body:text})
}

const writeMethods:readonly string[]=['POST','PUT','PATCH','DELETE']
/**
 * 非 GET 确认卡文案（规格 2026-09-27 §4.6）：只含技能名、方法、origin+pathname、查询参数个数与请求体字节数/前 200 字预览；
 * 不读已存密钥，查询串值不上卡，预览先经 redactSecrets（前缀形态）脱敏。
 */
export function skillHttpConfirmReason(input:{skill:string;method:string;url:URL;body?:string}):string{
 const query=[...input.url.searchParams.keys()].length,body=input.body??''
 const preview=body?`（模型给出、未核验）：「${bodyPreview(body)}」`:''
 return `确认通过技能 ${input.skill} 向 ${input.url.origin}${input.url.pathname} 发送 ${input.method} 请求？${query?`查询参数 ${query} 个，`:''}请求体 ${Buffer.byteLength(body,'utf8')} 字节${preview}。Teloa 会注入该技能已保存的密钥；这会改动外部服务的数据，员工授权不会代替逐次确认。`
}
const previewChars=200
const fenceLike=new Map([['【','['],['〖','['],['】',']'],['〗',']'],['「','"'],['」','"'],['『','"'],['』','"']])
/**
 * 请求体预览（审查 R1 M1/L2，复审 LOW-1）：模型可控文本不得在卡片上冒充宿主口吻——先脱敏，再把 C0/C1、零宽、双向与行/段分隔符换成空格并折叠空白，
 * 方头括号【】与形近的〖〗一律换成 []（中和「【Teloa】」等宿主前缀），围栏字符「」及其近形 『』 一律换成 ASCII 引号 "（不能提前闭合或视觉上冒充闭合围栏）；按码点截断，超出以 … 结尾。
 * 判定按字符先 NFKC 归一（审查 R1 L4）：半角 ｢｣、竖排表现形式 ﹁﹂﹃﹄ ︻︼ ︗︘ 等兼容字符归一后落在上述括号里即一并替换，不逐个列举近形；
 * 其余字符保留原形（不把全角标点等改成半角，预览仍如实反映请求体）。
 */
function bodyPreview(body:string):string{
 const text=redactSecrets(body,[]).replace(/[\x00-\x1f\x7f-\x9f\xad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,' ').replace(/\s+/g,' ').trim()
  .replace(/[^\x00-\x7f]/gu,ch=>fenceLike.get(ch.normalize('NFKC'))??ch)
 const chars=Array.from(text)
 return chars.length>previewChars?chars.slice(0,previewChars).join('')+'…':text
}
const parameters={skill:{type:'string',required:true},method:{type:'string',enum:[...methods],required:true},url:{type:'string',required:true},headers:{type:'string'},body:{type:'string'}} as const
const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
type RegisterPorts=Omit<SkillHttpPorts,'skillVisible'|'resolve'|'request'>&Partial<Pick<SkillHttpPorts,'resolve'|'request'>>&{
 skillVisible:(exec:ToolExecution,skill:string,signal:AbortSignal)=>Promise<boolean>
 /** 返回调用方身份（见 createSkillHttpAuthorizer）；失败抛 WorkError。 */
 authorize:(exec:ToolExecution,args:unknown)=>Promise<SkillHttpCaller>
 /** 该会话生效的 DSH 审批权限模式（approval.overrideOf(session)??approval.config.policy）；审批服务缺席时 undefined（DSH 会把 ask 转 deny）。 */
 approvalPolicy:(exec:ToolExecution)=>'never'|string|undefined
 /** 确认冷却用的时钟（测试注入）；缺省 Date.now。 */
 now?:()=>number
}
/** 确认阶段被拒或无人应答后，同一技能 + 方法 + 目标（origin + 归一路径，不含查询串）不再出卡的时长（复审 LOW-3）。 */
const approvalCooldownMs=60_000
const workbenchGuidance='请本人到工作台操作，勿重复发起。'
/**
 * 冷却键的路径（审查修复 L-1）：与路径白名单同一口径——skillSecretPathAllowed 把 `/v1` 与 `/v1/` 视为同一前缀、逐字（区分大小写）比较，
 * 服务端对百分号编码的非保留字符按解码后处理；故先解码百分号编码、再去尾斜杠，大小写保留。解不开的编码保持原文。host 与默认端口已由 URL 归一。
 */
const cooldownPath=(pathname:string)=>{let path=pathname;try{path=decodeURIComponent(pathname)}catch{};return path.length>1?path.replace(/\/+$/,'')||'/':path}
/**
 * 注册 teloa_skill_http；authorize 失败在 pre 阶段转 deny（无活跃用户指令、子代理、群路由、未按岗位授权的任务执行会话等）。
 * 非 GET 逐次确认（规格 2026-09-27 §4.6）：复用 DSH 官方审批——原生决策为 allow/ask 时转 ask；权限模式 never 转 deny；GET 与无法解析的参数原决策透传。
 */
export function registerSkillHttpTool(ctx:Context,ports:RegisterPorts){
 const full=(exec:ToolExecution):SkillHttpPorts=>({...ports,resolve:ports.resolve??((host,signal)=>resolveOutboundAddresses(host,signal)),request:ports.request??pinnedHttpsRequest,skillVisible:skill=>ports.skillVisible(exec,skill,exec.signal)})
 ctx.tools.register(defineTool({name:skillHttpToolName,description:'调用已安装技能写明的第三方 HTTP 接口；该技能所需的 API 密钥由 Teloa 在请求时注入，你看不到也不需要密钥，不要在参数里提供密钥。只能访问该技能写明的地址与方法；headers 每行一个 Name: value，只允许 Accept、Accept-Language、Content-Type、User-Agent、Idempotency-Key 与该技能写明放开的附加请求头；POST、PUT、PATCH、DELETE 每次调用前都会请本人确认。',parameters,output,execute:async(args,exec)=>{
  const caller=await ports.authorize(exec,args)
  return runSkillHttp(full(exec),args,exec.signal,caller)
 }}))
 // 已出卡、待本人答复的调用（按 callId），用于本人拒卡时补 deny 审计（审查 R1 L5）；有界，审批未走到答复者（服务缺席等）时由上限淘汰。
 type Row={skill:string;origin:string;method:string;target:string;caller:SkillHttpCaller}
 const pending=new Map<string,Row>(),pendingMax=256
 const approvalDeny=(row:Row)=>ports.audit({event:'skill-secret.deny',skill:row.skill,reason:'approval',origin:row.origin,method:row.method,...callerFields(row.caller)})
 // 复审 LOW-3：只能拒绝的 IM 卡片会立即结束，模型若马上重试就会再发一张卡。确认阶段被拒/无人应答后，同一技能 + 方法 + 目标短冷却（冷却内直接拒、不出卡，记 deny rate），
 // 该次调用的错误回包改为引导本人到工作台操作。两张表均有界（与 pending 同上限）。
 const now=ports.now??Date.now
 const cooldown=new Map<string,number>(),deniedCalls=new Map<string,'rejected'|'unavailable'>()
 const cooldownKey=(row:Pick<Row,'skill'|'method'|'target'>)=>`${row.skill}\n${row.method}\n${row.target}`
 const remember=<V>(map:Map<string,V>,key:string,value:V)=>{map.delete(key);map.set(key,value);if(map.size>pendingMax)map.delete(map.keys().next().value!)}
 // 挂在链最前（prepend）：调用时授权先于任务工具守卫判定，未授予、未勾选等拒绝也能记 deny caller 审计（审查修复 R1 L-2）；
 // 放行后再经 next() 走完路由闸、任务守卫与原生审批，本闸不代替它们。
 const offPre=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==skillHttpToolName)return next()
  let caller:SkillHttpCaller
  try{caller=await ports.authorize(exec,exec.arguments)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对调用身份。'}}
  const decision=await next()
  if(decision.kind!=='allow'&&decision.kind!=='ask')return decision
  let input:Input
  try{input=readInput(exec.arguments)}catch{return decision}
  if(!writeMethods.includes(input.method))return decision
  const row={skill:input.skill,origin:input.url.origin,method:input.method,target:input.url.origin+cooldownPath(input.url.pathname),caller}
  const policy=ports.approvalPolicy(exec)
  if(policy==='never'){approvalDeny(row);return {kind:'deny',reason:'当前权限模式不会请求人工确认；请切换到允许人工确认的权限模式后再调用会改动数据的技能接口。'}}
  const until=cooldown.get(cooldownKey(row))
  if(until!==undefined&&now()<until){
   ports.audit({event:'skill-secret.deny',skill:row.skill,reason:'rate',origin:row.origin,method:row.method,...callerFields(caller)})
   return {kind:'deny',reason:`同一技能接口调用刚在确认阶段被拒绝或无人应答，${Math.ceil((until-now())/1000)} 秒内不再发起确认；${workbenchGuidance}`}
  }
  if(policy!==undefined)remember(pending,exec.callId,row)
  // 原生理由在前（与受管 MCP 写工具 managed-mcp-connections.ts 同式），本卡如实列出本次写请求。
  const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
  return {kind:'ask',reason:prior+skillHttpConfirmReason(input)}
 },{prepend:true})
 // 观察审批瀑布的最终结论：放在最前并调用 next()，不代答、不改结论。
 const offApproval=ctx.on('approval/request',async(req,next)=>{
  const outcome=await next()
  if(req.toolName!==skillHttpToolName||req.callId===undefined)return outcome
  const row=pending.get(req.callId)
  pending.delete(req.callId)
  // rejected：本人拒卡；unavailable：无答复者/无审批通道，DSH 同样按拒绝处理（工具报错、不执行）——两者都是「确认阶段未通过」（复审 LOW-3）。
  if(row&&(outcome==='rejected'||outcome==='unavailable')){
   approvalDeny(row)
   remember(cooldown,cooldownKey(row),now()+approvalCooldownMs)
   remember(deniedCalls,req.callId,outcome)
  }
  return outcome
 },{prepend:true})
 // 确认阶段未通过的调用由 DSH 物化为英文错误结果（the user rejected… / no approval channel…），这里换成带工作台引导的回包。
 const offPost=ctx.on('tools/post-execute',async(exec,result,next):Promise<PostToolDecision>=>{
  const decision=await next()
  if(exec.name!==skillHttpToolName)return decision
  const outcome=deniedCalls.get(exec.callId)
  deniedCalls.delete(exec.callId)
  if(outcome===undefined||!result.isError||decision.kind!=='accept')return decision
  const text=outcome==='rejected'?'本人未批准这次技能接口调用，未执行。':'这次技能接口调用需要本人在工作台确认，当前无人应答，未执行。'
  return {kind:'block',feedback:[{type:'text',text:`Error: ${text}${workbenchGuidance}`}]}
 })
 return ()=>{offPre();offApproval();offPost()}
}
