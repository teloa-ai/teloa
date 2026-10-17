/** 可移植的模板分享边界；只接受静态文本，正文仍由原资源解析器核验，不产生运行权限。 */
import {ROLE_AVATAR_KEYS} from './role-avatars.mjs'
const encoder = new TextEncoder()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const kinds = ['role','skill','knowledge','work-template','plan']
const targets = {'role-knowledge':'knowledge','role-skill':'skill','role-work':['work-template','plan']}
const fail = message => { throw new Error(message) }
function object(value, keys, required = keys) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) fail('Template contains missing or unsupported fields.')
 return value
}
function text(value,max,empty=false) {
 if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail('Template text is empty, invalid or too long.')
 return value
}
function path(value) {
 text(value,300)
 if(value.startsWith('/')||value.split('/').some(v=>!v||v.startsWith('.'))||/[\\:?%#\x00-\x1f\x7f]/.test(value)||!(/\.(md|txt|json)$/i.test(value)||/^(?:.*\/)?(?:LICENSE|README)$/.test(value)))fail('Template file path is unsafe or executable.')
 return value
}
function list(value,max) {if(!Array.isArray(value)||value.length>max)fail('Template list is invalid or too long.');return value}
function localId(value) {text(value,120);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value))fail('Template resource identifier is invalid.');return value}
function version(value) {text(value,80);if(!SEMVER.test(value))fail('Template version must be exact.');return value}
function json(value) {try{return JSON.parse(value)}catch{fail('Template JSON is invalid.')}}
function unique(values) {if(new Set(values).size!==values.length)fail('Template list repeats.');return values}

/** 常见凭据与本机路径筛查，不代表可以省略作者对完整正文的审阅。 */
export function templateShareTextIssue(value) {
 if(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|file:\/\/)/i.test(value))return 'Template contains a private local path.'
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9_+\/-]{16,}/i.test(value))return 'Template contains a possible credential.'
 return undefined
}
function screen(values) {for(const value of values){const issue=templateShareTextIssue(value);if(issue)fail(issue)}}
/** 员工正文只收职责与范围，不收私人身份或运行配置。 */
function employeeRole(source,structured=false) {
 const role=object(json(source),['format','name','kind','duty','dataScope','executionScope','avatarKey',...structured?['responsibility']:[]],['format','name','kind','duty','dataScope','executionScope'])
 if(role.format!=='teloa.role/v1'||role.kind!=='employee')fail('Template must define an employee, without private identity.')
 if(Object.hasOwn(role,'avatarKey')&&!ROLE_AVATAR_KEYS.includes(role.avatarKey))fail('Template avatar must be a built-in employee avatar.')
 text(role.name,80);for(const key of ['duty','dataScope','executionScope'])text(role[key],4000)
 if(role.responsibility!==undefined){
  const duties=object(role.responsibility,['triggers','autonomousActions','confirmationPoints','escalationRules','deliveryChecks'])
  for(const entries of Object.values(duties))list(entries,30).forEach(item=>text(item,1000))
 }
}
function relations(value,max,byId,allowedTargets) {
 const seen=new Set()
 for(const raw of list(value,max)){
  const r=object(raw,['kind','from','to']),from=byId.get(r.from),to=byId.get(r.to),allowed=allowedTargets[r.kind]
  if(!from||!to||from.kind!=='role'||!allowed||(Array.isArray(allowed)?!allowed.includes(to.kind):allowed!==to.kind))fail('Template relationship is incomplete or invalid.')
  const key=JSON.stringify(r);if(seen.has(key))fail('Template relationship repeats.');seen.add(key)
 }
}
function entrypoints(value,max,byId) {
 const entries=list(value,max);if(new Set(entries).size!==entries.length||entries.some(id=>!['skill','work-template'].includes(byId.get(id)?.kind)))fail('Template entry point is invalid.')
}
function manifest(value,pkg,files) {
 const m=object(value,['format','id','version','title','description','domain','scope','resources','relations','entrypoints'])
 if(m.format!=='teloa.business-package/v2'||m.id!==pkg.id||m.version!==pkg.version)fail('Template and manifest identity or version differ.')
 text(m.title,120);text(m.description,2000);text(m.domain,80)
 if(typeof m.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(m.scope))fail('Template scope is invalid.')
 const rows=list(m.resources,100).map(raw=>{
  const r=object(raw,['id','kind','title','version','required','source']);localId(r.id);text(r.title,120);version(r.version)
  if(!kinds.includes(r.kind)||typeof r.required!=='boolean')fail('Template resource type is unsupported.')
  const source=object(r.source,['kind','path']);if(source.kind!=='local')fail('Template resources must be self-contained.')
  path(source.path);if(!files.has(source.path)||source.path==='teloa.json')fail('Template resource file is missing.')
  if(['role','plan','work-template'].includes(r.kind)&&!source.path.endsWith('.json'))fail('Template declaration must be JSON.')
  if(['skill','knowledge'].includes(r.kind)&&!(/\.(md|txt)$/i.test(source.path)))fail('Template resource must be plain text.')
  return r
 })
 const byId=new Map(rows.map(r=>[r.id,r]));if(!rows.length||byId.size!==rows.length)fail('Template resource identities repeat or are empty.')
 const roles=rows.filter(r=>r.kind==='role');if(roles.length!==1)fail('Template must contain exactly one employee.')
 employeeRole(files.get(roles[0].source.path))
 relations(m.relations,500,byId,targets)
 entrypoints(m.entrypoints,100,byId)
 const declaredJson=new Set(['teloa.json',...rows.filter(r=>r.source.path.endsWith('.json')).map(r=>r.source.path)])
 for(const name of files.keys())if(name.endsWith('.json')&&!declaredJson.has(name))fail('Template contains an undeclared JSON file.')
 if(rows.some(r=>r.kind==='plan')&&!pkg.compatibility.capabilities.includes('automation'))fail('Template plans require the automation capability.')
 return m
}
function serialize(pkg) {
 return JSON.stringify({format:pkg.format,id:pkg.id,version:pkg.version,title:pkg.title,description:pkg.description,requirements:pkg.requirements,compatibility:{manifestFormat:pkg.compatibility.manifestFormat,capabilities:[...pkg.compatibility.capabilities].sort()},files:sortFiles(pkg.files)})
}
const sortFiles=files=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(f=>({path:f.path,text:f.text}))
/** v1 是已发布链接的固定格式：只读一个员工、UUID 身份、自包含资源；v2 包不经此入口。 */
export function readTemplateSharePackage(value) {
 const row=object(value,['format','id','version','title','description','requirements','compatibility','files'])
 if(row.format!=='teloa.template-share/v1'||typeof row.id!=='string'||!UUID.test(row.id))fail('Template share format or identity is invalid.')
 version(row.version);text(row.title,120);text(row.description,2000)
 const requirements=list(row.requirements,100).map(v=>text(v,500))
 const c=object(row.compatibility,['manifestFormat','capabilities']),capabilities=list(c.capabilities,2)
 if(c.manifestFormat!=='teloa.business-package/v2'||!capabilities.includes('people')||capabilities.some(v=>!['people','automation'].includes(v))||new Set(capabilities).size!==capabilities.length)fail('Template requires an unsupported capability.')
 const files=list(row.files,100).map(raw=>{const f=object(raw,['path','text']);path(f.path);text(f.text,262144);if(encoder.encode(f.text).byteLength>262144)fail('Template file exceeds 256 KiB.');return {path:f.path,text:f.text}})
 const byPath=new Map(files.map(f=>[f.path,f.text]));if(byPath.size!==files.length||!byPath.has('teloa.json'))fail('Template files repeat or teloa.json is missing.')
 const pkg={format:row.format,id:row.id,version:row.version,title:row.title,description:row.description,requirements,compatibility:{manifestFormat:c.manifestFormat,capabilities:[...capabilities]},files}
 screen([pkg.title,pkg.description,...requirements,...files.map(f=>f.text)])
 manifest(json(byPath.get('teloa.json')),pkg,byPath)
 if(encoder.encode(serialize(pkg)).byteLength>1048576)fail('Template share exceeds 1 MiB.')
 return pkg
}

// ---- teloa.template-share/v2：AI 员工、AI 团队与单独能力（应用、技能、MCP）共用 business-package 容器与资源关系 ----
const SUBJECTS=['employee','team','app','skill','mcp']
const MANIFEST_FORMATS=['teloa.business-package/v2','teloa.business-package/v3','teloa.business-package/v4']
const CAPABILITY_OF={role:'people',plan:'automation',mcp:'connections',plugin:'connections','data-source':'connections','execution-tool':'connections','object-type':'business','business-view':'business','business-action':'business','business-configuration':'business'}
const CAPABILITIES=['people','automation','connections','business']
const V2_KINDS=[...kinds,...Object.keys(CAPABILITY_OF).filter(k=>!kinds.includes(k))]
const V2_TARGETS={...targets,'role-connection':['mcp','data-source','execution-tool']}
const TEXT_KINDS=['skill','knowledge']
// 与 market 内容库的固定公共引用一致：只引用已发布的原子技能或完整业务配置。
const PUBLIC_KINDS=['skill','business-configuration']
const V2_FILE_BYTES=2*1024*1024,V2_TOTAL_BYTES=8*1024*1024
const OFFICIAL_PUBLISHER='Teloa 官方目录'
const SERVER_NAME=/^(?!.*__)[A-Za-z0-9_-]{1,32}$/
const TOOL_NAME=/^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]{0,62}[A-Za-z0-9_-]$|^[A-Za-z0-9_-]$/
const NPM_NAME=/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
// 与安装端连接/扩展文件上限一致。
const CONNECTION_BYTES=128*1024
const MODEL_USAGES=['speech-to-text','text-to-speech','embedding','rerank','ocr','classification','extraction','chat']
/** 与行业清单的模型依赖规则一致：固定目录版本、用途与必需标记，不收下载地址或运行配置。 */
function modelDependencies(value) {
 const seen=new Set()
 for(const v of list(value,16)){
  const d=object(v,['catalogId','version','usage','required'])
  if(typeof d.catalogId!=='string'||!/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,2}$/.test(d.catalogId)||!MODEL_USAGES.includes(d.usage)||typeof d.required!=='boolean')fail('Template model dependencies are invalid.')
  version(d.version);const key=d.catalogId+'\0'+d.usage;if(seen.has(key))fail('Template model dependencies repeat.');seen.add(key)
 }
 if(!seen.size)fail('Template model dependencies are invalid.')
}
/** 连接、扩展与业务结构只收固定声明（与安装端定义同形），地址、环境变量、令牌、同步绑定等运行配置一律拒绝。 */
function declarationBody(resource,source,scope) {
 const value=json(source)
 if(['mcp','plugin','data-source','execution-tool'].includes(resource.kind)&&encoder.encode(source).byteLength>CONNECTION_BYTES)fail('Template connection declaration exceeds 128 KiB.')
 if(resource.kind==='mcp'){
  const v=object(value,['format','serverName','tools'])
  if(v.format!=='teloa.mcp-connection/v1'||typeof v.serverName!=='string'||!SERVER_NAME.test(v.serverName))fail('Template MCP declaration is invalid.')
  const tools=list(v.tools,64);if(!tools.length||tools.some(t=>typeof t!=='string'||!TOOL_NAME.test(t)))fail('Template MCP tools are invalid.');unique(tools)
 }else if(resource.kind==='plugin'){
  const v=object(value,['format','registry','packageName','version'])
  if(v.format!=='teloa.plugin/v1'||v.registry!=='npm'||typeof v.packageName!=='string'||v.packageName.length>214||!NPM_NAME.test(v.packageName))fail('Template plugin declaration is invalid.')
  if(version(v.version)!==resource.version)fail('Template plugin version must match its resource.')
 }else if(resource.kind==='data-source'){
  const v=object(value,['format','sourceId','scopes','sourceNoun'],['format','sourceId','scopes'])
  if(v.format!=='teloa.data-source/v1'||typeof v.sourceId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(v.sourceId))fail('Template data source declaration is invalid.')
  const scopes=list(v.scopes,16);if(!scopes.length||scopes.some(s=>typeof s!=='string'||!/^(?!general$)[^\x00-\x1f\x7f]{1,120}$/.test(s)))fail('Template data source scopes are invalid.');unique(scopes)
  if(Object.hasOwn(v,'sourceNoun')&&(typeof v.sourceNoun!=='string'||!v.sourceNoun.trim()||v.sourceNoun!==v.sourceNoun.trim()||v.sourceNoun.length>12||/[\x00-\x1f\x7f]/.test(v.sourceNoun)))fail('Template data source noun is invalid.')
 }else if(resource.kind==='execution-tool'){
  // 安装端目前只认这一项已审执行工具；其他声明在分享时就拒绝，避免分享成功、安装必失败。
  const v=object(value,['format','adapterId','tools'])
  if(v.format!=='teloa.execution-tool/v1'||v.adapterId!=='security-action-http'||!Array.isArray(v.tools)||v.tools.length!==1||v.tools[0]!=='security.endpoint.isolate')fail('Template execution tool declaration is invalid.')
 }else if(resource.kind==='business-configuration'){
  // 正文完整结构仍由安装端业务配置解析器核验；分享端先守身份、范围，并拒绝已有同步绑定。
  const v=object(value,['format','id','version','configuration'])
  const c=v.configuration
  if(v.format!=='teloa.business-dashboard-resource/v1'||v.id!==resource.id||v.version!==resource.version||!c||typeof c!=='object'||Array.isArray(c)||c.scope!==scope)fail('Template business configuration identity or scope differs.')
  if(Array.isArray(c.definitions)&&c.definitions.some(d=>d?.kind==='source-mapping'))fail('Template business configuration cannot carry existing sync bindings.')
 }else{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Template declaration must be a JSON object.')
  // 业务对象、视图、动作只收本类型的固定定义格式；正文由安装端原解析器核验。
  if(['object-type','business-view','business-action'].includes(resource.kind)&&(typeof value.format!=='string'||!value.format.startsWith('teloa.'+resource.kind+'/')))fail('Template business declaration format is invalid.')
 }
}
/** 发布者自报名称不能冒用官方目录；规范化后比较，避免空白、零宽或全角字符绕过。 */
const reservedPublisher=value=>value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/\s+/g,' ').trim().toLowerCase()===OFFICIAL_PUBLISHER.toLowerCase()
function httpsLink(value) {
 let url;try{url=new URL(text(value,500))}catch{fail('Template provenance link must use https.')}
 if(url.protocol!=='https:'||url.username||url.password||/\s/.test(value))fail('Template provenance link must use https without credentials.')
 return value
}
function manifestV2(value,pkg,files) {
 const m=object(value,['format','id','version','title','description','domain','scope','resources','relations','entrypoints'],['format','id','version','title','description','domain','resources','relations','entrypoints'])
 if(m.format!==pkg.compatibility.manifestFormat||m.id!==pkg.id||m.version!==pkg.version)fail('Template and manifest identity or version differ.')
 text(m.title,120);text(m.description,2000);text(m.domain,80)
 // 与业务包容器一致：缺省 scope 时取 domain。
 const scope=m.scope===undefined?m.domain:m.scope
 if(typeof scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(scope))fail('Template scope is invalid.')
 const used=new Set(['teloa.json',...pkg.sourceFiles])
 const rows=list(m.resources,500).map(raw=>{
  const r=object(raw,['id','kind','title','version','required','source',...(m.format==='teloa.business-package/v2'?[]:['modelDependencies'])],['id','kind','title','version','required','source'])
  localId(r.id);text(r.title,120);version(r.version)
  if(!V2_KINDS.includes(r.kind)||typeof r.required!=='boolean')fail('Template resource type is unsupported.')
  if(r.kind==='business-configuration'&&m.format!=='teloa.business-package/v4')fail('Template business configuration requires teloa.business-package/v4.')
  if(Object.hasOwn(r,'modelDependencies')){if(!['skill','work-template'].includes(r.kind))fail('Template model dependencies are invalid.');modelDependencies(r.modelDependencies)}
  if(r.source?.kind==='public'){
   const source=object(r.source,['kind','id','version']);localId(source.id)
   if(source.version!==r.version||!PUBLIC_KINDS.includes(r.kind))fail('Template public references must pin a skill or business configuration version.')
   return r
  }
  const source=object(r.source,['kind','path']);if(source.kind!=='local')fail('Template resources must be self-contained or pinned public references.')
  path(source.path);if(used.has(source.path))fail('Template resource file is missing or reused.');used.add(source.path)
  if(TEXT_KINDS.includes(r.kind)?!/\.(md|txt)$/i.test(source.path):!source.path.endsWith('.json'))fail(TEXT_KINDS.includes(r.kind)?'Template resource must be plain text.':'Template declaration must be JSON.')
  // 与业务包容器一致：非必需资源可以只声明（例如待接收方配置的连接），必需资源必须随包提供。
  if(!files.has(source.path)){if(r.required)fail('Template resource file is missing.');return r}
  if(r.kind==='role')employeeRole(files.get(source.path),true)
  else if(!TEXT_KINDS.includes(r.kind))declarationBody(r,files.get(source.path),scope)
  return r
 })
 const byId=new Map(rows.map(r=>[r.id,r]));if(!rows.length||byId.size!==rows.length)fail('Template resource identities repeat or are empty.')
 const provided=r=>r.source.kind==='local'&&files.has(r.source.path)
 const roles=rows.filter(r=>r.kind==='role');if(roles.some(r=>!provided(r)))fail('Template employees must be included.')
 const included=r=>provided(r)||r.source.kind==='public'
 const only=kind=>rows.length===1&&rows[0].kind===kind&&included(rows[0])
 const shaped={employee:roles.length===1,team:roles.length>=2,app:!roles.length&&rows.some(r=>['skill','mcp','plugin'].includes(r.kind)&&included(r)),skill:only('skill'),mcp:only('mcp')}[pkg.subject]
 if(!shaped)fail('Template contents do not match the shared subject.')
 if(pkg.team&&(pkg.subject!=='team'||byId.get(pkg.team.coordinatorResourceId)?.kind!=='role'))fail('Template team coordinator must be a declared employee.')
 relations(m.relations,2000,byId,V2_TARGETS)
 entrypoints(m.entrypoints,500,byId)
 const declaredJson=new Set(['teloa.json',...pkg.sourceFiles,...rows.filter(r=>r.source.kind==='local'&&r.source.path.endsWith('.json')).map(r=>r.source.path)])
 // 扩展名按不区分大小写判断，避免 .JSON 绕过声明（v1 保持原规则）。
 for(const name of files.keys())if(name.toLowerCase().endsWith('.json')&&!declaredJson.has(name))fail('Template contains an undeclared JSON file.')
 for(const r of rows)if(CAPABILITY_OF[r.kind]&&!pkg.compatibility.capabilities.includes(CAPABILITY_OF[r.kind]))fail('Template resources require an undeclared capability.')
 for(const s of pkg.provenance.sources)for(const id of s.resourceIds)if(!byId.has(id)||!provided(byId.get(id)))fail('Template provenance must describe included resources.')
 return m
}
function serializeV2(pkg) {
 return JSON.stringify({format:pkg.format,subject:pkg.subject,id:pkg.id,version:pkg.version,title:pkg.title,description:pkg.description,requirements:pkg.requirements,license:pkg.license,trust:{publisher:pkg.trust.publisher},provenance:{sources:pkg.provenance.sources.map(source),...(pkg.provenance.modifications===undefined?{}:{modifications:pkg.provenance.modifications})},sourceFiles:[...pkg.sourceFiles].sort(),...(pkg.team?{team:{coordinatorResourceId:pkg.team.coordinatorResourceId}}:{}),compatibility:{manifestFormat:pkg.compatibility.manifestFormat,capabilities:[...pkg.compatibility.capabilities].sort()},files:sortFiles(pkg.files)})
}
const source=s=>({title:s.title,...(s.url===undefined?{}:{url:s.url}),...(s.version===undefined?{}:{version:s.version}),license:s.license,resourceIds:[...s.resourceIds].sort()})
/** v2 分享包：主体、许可、出处与原件声明都进入固定摘要；不携带账号、凭据、运行配置或本机路径。 */
export function readTemplateSharePackageV2(value) {
 const keys=['format','subject','id','version','title','description','requirements','license','trust','provenance','sourceFiles','team','compatibility','files']
 const row=object(value,keys,keys.filter(k=>k!=='team'))
 if(row.format!=='teloa.template-share/v2')fail('Template share format or identity is invalid.')
 if(!SUBJECTS.includes(row.subject))fail('Template share subject is unsupported.')
 localId(row.id);version(row.version);text(row.title,120);text(row.description,2000)
 const requirements=list(row.requirements,100).map(v=>text(v,500))
 const license=text(row.license,120)
 const trust=object(row.trust,['publisher']);if(reservedPublisher(text(trust.publisher,120)))fail('Template publisher is reserved for the official catalog.')
 const p=object(row.provenance,['sources','modifications'],['sources'])
 const sources=list(p.sources,50).map(raw=>{
  const s=object(raw,['title','url','version','license','resourceIds'],['title','license','resourceIds']);text(s.title,200);text(s.license,120)
  if(s.url!==undefined)httpsLink(s.url)
  if(s.version!==undefined)text(s.version,80)
  const ids=unique(list(s.resourceIds,500).map(localId));if(!ids.length)fail('Template provenance must name its resources.')
  return source(s)
 })
 const modifications=p.modifications===undefined?undefined:text(p.modifications,4000)
 const sourceFiles=unique(list(row.sourceFiles,20).map(v=>{path(v);if(!/^source\/[^/]+\.json$/.test(v))fail('Template source files must be JSON directly under source/.');return v}))
 const team=row.team===undefined?undefined:{coordinatorResourceId:localId(object(row.team,['coordinatorResourceId']).coordinatorResourceId)}
 const c=object(row.compatibility,['manifestFormat','capabilities']),capabilities=unique(list(c.capabilities,CAPABILITIES.length))
 if(!MANIFEST_FORMATS.includes(c.manifestFormat)||capabilities.some(v=>!CAPABILITIES.includes(v)))fail('Template requires an unsupported capability.')
 // 500 项资源 + teloa.json + 20 份来源原件。
 const files=list(row.files,521).map(raw=>{const f=object(raw,['path','text']);path(f.path);text(f.text,V2_FILE_BYTES);if(encoder.encode(f.text).byteLength>V2_FILE_BYTES)fail('Template file exceeds 2 MiB.');return {path:f.path,text:f.text}})
 const byPath=new Map(files.map(f=>[f.path,f.text]));if(byPath.size!==files.length||!byPath.has('teloa.json'))fail('Template files repeat or teloa.json is missing.')
 for(const name of sourceFiles){if(!byPath.has(name))fail('Template source file is missing.');json(byPath.get(name))}
 const pkg={format:row.format,subject:row.subject,id:row.id,version:row.version,title:row.title,description:row.description,requirements,license,trust:{publisher:trust.publisher},provenance:{sources,...(modifications===undefined?{}:{modifications})},sourceFiles,...(team?{team}:{}),compatibility:{manifestFormat:c.manifestFormat,capabilities:[...capabilities]},files}
 screen([pkg.title,pkg.description,...requirements,license,trust.publisher,...sources.flatMap(s=>[s.title,s.url??'',s.version??'',s.license]),modifications??'',...files.map(f=>f.text)])
 manifestV2(json(byPath.get('teloa.json')),pkg,byPath)
 if(encoder.encode(serializeV2(pkg)).byteLength>V2_TOTAL_BYTES)fail('Template share exceeds 8 MiB.')
 return pkg
}
/** 按格式分流；v1 仍走原读取器与原字节规范。 */
export function readTemplateShare(value) {
 return value&&typeof value==='object'&&value.format==='teloa.template-share/v2'?readTemplateSharePackageV2(value):readTemplateSharePackage(value)
}
export function canonicalTemplateShare(value) {const pkg=readTemplateShare(value);return pkg.format==='teloa.template-share/v2'?serializeV2(pkg):serialize(pkg)}
export async function templateShareDigest(value) {
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(canonicalTemplateShare(value))))
 return Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('')
}
const SUBMISSION_STATES=['pending','approved','rejected','withdrawn']
const stamp=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('Template submission time is invalid.');return value}
/** 官方市场投稿回执：只认服务生成的分享身份、固定摘要与审核状态；投稿不等于上架，分享链接也不代表投稿。 */
export function readTemplateShareSubmission(value) {
 const row=object(value,['shareId','sha256','state','submittedAt','reviewedAt','reason'],['shareId','sha256','state','submittedAt'])
 if(typeof row.shareId!=='string'||!UUID.test(row.shareId)||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||!SUBMISSION_STATES.includes(row.state))fail('Template submission identity, digest or state is invalid.')
 const submittedAt=stamp(row.submittedAt)
 if(row.reviewedAt!==undefined&&(!['approved','rejected'].includes(row.state)||stamp(row.reviewedAt)<submittedAt))fail('Template submission review time is invalid.')
 if(row.reason!==undefined&&row.state!=='rejected')fail('Only a rejected submission carries a reason.')
 return {shareId:row.shareId,sha256:row.sha256,state:row.state,submittedAt,...(row.reviewedAt===undefined?{}:{reviewedAt:row.reviewedAt}),...(row.reason===undefined?{}:{reason:text(row.reason,2000)})}
}
