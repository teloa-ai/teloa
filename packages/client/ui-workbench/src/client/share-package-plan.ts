import {canonicalTemplateShare,readTemplateShare,readTemplateSharePackageV2,readTemplateShareSubmission,templateShareDigest,type RoleAvatarKey,type RoleResponsibility,type AnyTemplateSharePackage,type TemplateSharePackageV2,type TemplateShareSubject,type TemplateShareCapability,type TemplateShareProvenanceSource} from '@teloa/contract'
import type {PreviewRole} from './role-preview.ts'
import type {IndustryResource as Resource} from './industry-manifest.ts'

/** 分享边界统一使用共同契约；这里只重建静态内容，不复制解析与摘要规则。 */
export type ShareSubject=TemplateShareSubject
export type ShareCapability=TemplateShareCapability
export type ShareProvenanceSource=TemplateShareProvenanceSource
export type SharePackageV2=TemplateSharePackageV2
export type SharePackage=AnyTemplateSharePackage
export type ShareSubmissionStatus='pending'|'approved'|'rejected'|'withdrawn'
export type ShareSubmission={shareId:string;sha256:string;status:ShareSubmissionStatus;submittedAt:string;updatedAt?:string;reviewerNote?:string}
const encoder=new TextEncoder()
const LOCAL_ID=/^[a-zA-Z0-9][a-zA-Z0-9-]*$/
const CAPABILITY_OF:Readonly<Record<string,ShareCapability>>={role:'people',plan:'automation',mcp:'connections',plugin:'connections','data-source':'connections','execution-tool':'connections','object-type':'business','business-view':'business','business-action':'business','business-configuration':'business'}
const fail=(message:string):never=>{throw Error(message)}
type Row=Record<string,unknown>
const json=(value:string):Row=>JSON.parse(value) as Row
export const readSharePackageV2=readTemplateSharePackageV2
export const isSharePackageV2=(value:unknown):value is SharePackageV2=>!!value&&typeof value==='object'&&(value as Row).format==='teloa.template-share/v2'
export const readSharePackage=readTemplateShare
export const canonicalSharePackage=canonicalTemplateShare
export const sharePackageDigest=templateShareDigest
/** 导出与发布前的凭据/本机路径检查输入：全部文件与说明文字，与 `inspectBusinessShareContent` 共用。 */
export function shareInspectionInput(pkg:SharePackage):{files:{path:string;bytes:Uint8Array}[];purpose:string}{
 return {files:pkg.files.map(f=>({path:f.path,bytes:encoder.encode(f.text)})),purpose:pkg.description}
}
/** UI只映射已核验状态与说明；回执的身份、摘要和时间规则来自共同契约。 */
export function readShareSubmission(value:unknown):ShareSubmission{
 const row=readTemplateShareSubmission(value)
 return {shareId:row.shareId,sha256:row.sha256,status:row.state,submittedAt:row.submittedAt,...(row.reviewedAt?{updatedAt:row.reviewedAt}:{}),...(row.reason?{reviewerNote:row.reason}:{})}
}

export type ShareSummary={
 subject:ShareSubject;version:string;title:string;description:string;scope:string
 roles:{resourceId:string;name:string;avatarKey?:RoleAvatarKey;duty:string;dataScope:string;executionScope:string;responsibility?:RoleResponsibility;skills:string[];knowledge:string[];connections:string[]}[]
 coordinatorResourceId?:string
 skills:{resourceId:string;title:string;version:string;required:boolean;source:'local'|'public';text?:string;publicId?:string}[]
 connections:{resourceId:string;title:string;version:string;required:boolean;serverName?:string;tools?:string[]}[]
 plugins:{resourceId:string;title:string;version:string;required:boolean;packageName?:string}[]
 plans:{resourceId:string;title:string}[];workTemplates:{resourceId:string;title:string}[];knowledge:{resourceId:string;title:string}[]
 counts:Record<string,number>;license?:string;publisher?:string;provenance:ShareProvenanceSource[]
}
/** 技能可取消选择；其余组成固定保留，空包不能成为接收申请。 */
export function hasShareSelection(summary:Pick<ShareSummary,'counts'|'skills'>,skills:readonly string[]):boolean{
 return Object.entries(summary.counts).some(([kind,count])=>kind!=='skill'&&count>0)||summary.skills.some(skill=>skills.includes(skill.resourceId))
}
export function sharePackageSummary(pkg:SharePackage):ShareSummary{
 const byPath=new Map(pkg.files.map(f=>[f.path,f.text])),manifest=JSON.parse(byPath.get('teloa.json')!) as {scope?:string;domain:string;resources:Resource[];relations:{kind:string;from:string;to:string}[]}
 const resources=manifest.resources,body=(r:Resource)=>r.source.kind==='local'?byPath.get(r.source.path):undefined
 const relation=(kind:string,from:string)=>manifest.relations.filter(r=>r.kind===kind&&r.from===from).map(r=>r.to)
 // 岗位正文原样带出结构化职责，不压成说明文字；接收方按同一份定义实例化。
 const roles=resources.filter(r=>r.kind==='role').map(r=>{const def=JSON.parse(body(r)!) as {name:string;avatarKey?:RoleAvatarKey;duty:string;dataScope:string;executionScope:string;responsibility?:RoleResponsibility};return {resourceId:r.id,name:def.name,...(def.avatarKey?{avatarKey:def.avatarKey}:{}),duty:def.duty,dataScope:def.dataScope,executionScope:def.executionScope,...(def.responsibility?{responsibility:def.responsibility}:{}),skills:relation('role-skill',r.id),knowledge:relation('role-knowledge',r.id),connections:relation('role-connection',r.id)}})
 const v2=isSharePackageV2(pkg)?pkg:undefined
 const counts:Record<string,number>={};for(const r of resources)counts[r.kind]=(counts[r.kind]??0)+1
 const parse=<T>(r:Resource):T|undefined=>{const b=body(r);if(b===undefined)return undefined;try{return JSON.parse(b) as T}catch{return undefined}}
 return {
  subject:v2?.subject??'employee',version:pkg.version,title:pkg.title,description:pkg.description,scope:manifest.scope??manifest.domain,
  roles,...(v2?.team?{coordinatorResourceId:v2.team.coordinatorResourceId}:{}),
  skills:resources.filter(r=>r.kind==='skill').map(r=>({resourceId:r.id,title:r.title,version:r.version,required:r.required as boolean,source:r.source.kind,...(r.source.kind==='public'?{publicId:r.source.id}:{}),...(body(r)===undefined?{}:{text:body(r)!})})),
  connections:resources.filter(r=>['mcp','data-source','execution-tool'].includes(r.kind)).map(r=>{const d=parse<{serverName?:string;tools?:string[]}>(r);return {resourceId:r.id,title:r.title,version:r.version,required:r.required,...(d?.serverName?{serverName:d.serverName}:{}),...(d?.tools?{tools:d.tools}:{})}}),
  plugins:resources.filter(r=>r.kind==='plugin').map(r=>{const d=parse<{packageName?:string}>(r);return {resourceId:r.id,title:r.title,version:r.version,required:r.required,...(d?.packageName?{packageName:d.packageName}:{})}}),
  plans:resources.filter(r=>r.kind==='plan').map(r=>({resourceId:r.id,title:r.title})),workTemplates:resources.filter(r=>r.kind==='work-template').map(r=>({resourceId:r.id,title:r.title})),knowledge:resources.filter(r=>r.kind==='knowledge').map(r=>({resourceId:r.id,title:r.title})),
  counts,...(v2?{license:v2.license,publisher:v2.trust.publisher,provenance:v2.provenance.sources}:{provenance:[]}),
 }
}

// ---- 计划：从真实来源白名单重建静态包 ----
export type ShareRoleSource=Pick<PreviewRole,'id'|'name'|'kind'|'avatarKey'|'duty'|'dataScope'|'executionScope'|'skills'|'knowledge'>&{responsibility?:PreviewRole['responsibility']|undefined}
/** 技能来源：`name` 是员工绑定的原生技能名；`publicId` 表示官方目录固定引用，`text` 表示许可允许随包的静态正文。 */
export type ShareSkillSource={name:string;title?:string;resourceId?:string;version?:string;text?:string;/** 同一技能入口下已核摘要的静态原文；路径相对于 SKILL.md。 */files?:readonly {path:string;text:string}[];license?:string;publisher?:string;sourceUrl?:string;publicId?:string}
export type ShareConnectionSource={serverName:string;title?:string;tools:string[];version?:string}
export type SharePluginSource={packageName:string;version:string;title?:string}
export type SharePlanInput={subject:ShareSubject;title?:string;description?:string;publisher:string;license?:string;modifications?:string;roles:readonly ShareRoleSource[];skills:readonly ShareSkillSource[];connections?:readonly ShareConnectionSource[];plugins?:readonly SharePluginSource[];coordinatorRoleId?:string;/** 员工与连接的显式关系；缺省时员工主题绑定全部连接，团队主题不猜。 */bindings?:readonly {roleId:string;skills?:readonly string[];connections?:readonly string[]}[]}
const slug=(value:string,fallback:string)=>{const s=value.normalize('NFKD').replace(/[^a-zA-Z0-9-]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase().slice(0,60);return LOCAL_ID.test(s)?s:fallback}
const uniqueId=(used:Set<string>,base:string)=>{let id=base,n=2;while(used.has(id))id=base+'-'+n++;used.add(id);return id}
const README='# Getting started\n\nChoose your own work materials and model account. Review each employee’s instructions and configure the listed methods. A copy does not inherit the author’s accounts, private memory, permissions, conversations or running tasks. Connections and plugins are declared only; connect accounts and enable extensions through your own settings.\n'
export function buildSharePlan(input:SharePlanInput):SharePackageV2{
 if(input.roles.some(r=>r.kind!=='employee'))throw Error('Private twin identities cannot be shared as templates.')
 if(input.subject==='team'&&input.roles.length<2)throw Error('A team template needs at least two employees.')
 if(input.subject==='employee'&&input.roles.length!==1)throw Error('An employee template contains exactly one employee.')
 const id=crypto.randomUUID(),ver='1.0.0',used=new Set<string>(),files:{path:string;text:string}[]=[],resources:Resource[]=[],relations:{kind:string;from:string;to:string}[]=[],requirements:string[]=[],sources:ShareProvenanceSource[]=[]
 const skillById=new Map<string,string>()
 for(const skill of input.skills){
  const rid=uniqueId(used,slug(skill.resourceId??skill.name,'skill')),title=skill.title??skill.name,v=skill.version??'1.0.0'
  if(skill.publicId){resources.push({id:rid,kind:'skill',title,version:v,required:true,source:{kind:'public',id:skill.publicId,version:v}})}
  else if(skill.text!==undefined&&skill.license){
   // 原生技能目录形态：接收方经固定加载按 industry 来源安装，入口必须是 SKILL.md。
   const entries=skill.files??[{path:'SKILL.md',text:skill.text}]
   if(entries.filter(file=>file.path==='SKILL.md').length!==1||entries.find(file=>file.path==='SKILL.md')!.text!==skill.text)fail('The shared skill entry must match its original static files.')
   const p=rid+'/SKILL.md';files.push(...entries.map(file=>({path:rid+'/'+file.path,text:file.text})));resources.push({id:rid,kind:'skill',title,version:v,required:true,source:{kind:'local',path:p}})
   sources.push({title:skill.publisher?`${title} · ${skill.publisher}`:title,...(skill.sourceUrl?{url:skill.sourceUrl}:{}),version:v,license:skill.license,resourceIds:[rid]})
  }else{requirements.push(`Configure a method for: ${skill.name}`);continue}
  skillById.set(skill.name,rid)
 }
 const connectionById=new Map<string,string>()
 for(const c of input.connections??[]){
  const rid=uniqueId(used,slug('mcp-'+c.serverName,'mcp')),p=rid+'.json'
  files.push({path:p,text:JSON.stringify({format:'teloa.mcp-connection/v1',serverName:c.serverName,tools:[...new Set(c.tools)]},null,2)})
  resources.push({id:rid,kind:'mcp',title:c.title??c.serverName,version:c.version??'1.0.0',required:false,source:{kind:'local',path:p}});connectionById.set(c.serverName,rid)
  requirements.push(`Connect your own account for: ${c.title??c.serverName}`)
 }
 for(const plugin of input.plugins??[]){
  const rid=uniqueId(used,slug('plugin-'+plugin.packageName,'plugin')),p=rid+'.json'
  files.push({path:p,text:JSON.stringify({format:'teloa.plugin/v1',registry:'npm',packageName:plugin.packageName,version:plugin.version},null,2)})
  resources.push({id:rid,kind:'plugin',title:plugin.title??plugin.packageName,version:plugin.version,required:false,source:{kind:'local',path:p}})
 }
 const roleIds=new Map<string,string>()
 let privateKnowledge=0
 for(const role of input.roles){
  // 五组职责按结构原样入包，不并入 duty；全空时省略。
  const rid=uniqueId(used,slug('employee-'+role.name,'employee')),p=rid+'.json',responsibility=role.responsibility&&Object.values(role.responsibility).some(items=>items.length)?role.responsibility:undefined
  files.push({path:p,text:JSON.stringify({format:'teloa.role/v1',kind:'employee',name:role.name,...(role.avatarKey===undefined?{}:{avatarKey:role.avatarKey}),duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,...(responsibility?{responsibility}:{})},null,2)})
  resources.push({id:rid,kind:'role',title:role.name,version:ver,required:true,source:{kind:'local',path:p}});roleIds.set(role.id,rid)
  privateKnowledge+=role.knowledge.length
  const binding=input.bindings?.find(b=>b.roleId===role.id)
  for(const name of binding?.skills??role.skills){const to=skillById.get(name);if(to)relations.push({kind:'role-skill',from:rid,to:to});else if(!input.skills.some(s=>s.name===name)&&!requirements.includes(`Configure a method for: ${name}`))requirements.push(`Configure a method for: ${name}`)}
  const bound=binding?.connections??(input.subject==='employee'?[...connectionById.keys()]:[])
  for(const serverName of bound){const to=connectionById.get(serverName);if(to)relations.push({kind:'role-connection',from:rid,to})}
 }
 if(privateKnowledge)requirements.push(`Connect your own knowledge sources (${privateKnowledge}).`)
 if(input.roles.length)requirements.push('Choose your own model account and review permissions before enabling.')
 let team:SharePackageV2['team']
 if(input.coordinatorRoleId!==undefined){const rid=roleIds.get(input.coordinatorRoleId);if(!rid||input.subject!=='team')throw Error('The team coordinator must be one of the shared employees.');team={coordinatorResourceId:rid}}
 const capabilities=[...new Set(resources.map(r=>CAPABILITY_OF[r.kind]).filter((c):c is ShareCapability=>!!c))]
 const first=input.roles[0],title=input.title??(input.subject==='employee'&&first?first.name:input.subject==='skill'&&input.skills[0]?input.skills[0].title??input.skills[0].name:input.subject==='mcp'&&input.connections?.[0]?input.connections[0].title??input.connections[0].serverName:'Shared template')
 const description=(input.description??(first?.duty??resources.map(r=>r.title).join(', '))).slice(0,2000)
 const manifest={format:'teloa.business-package/v2',id,version:ver,title,description,domain:'general',scope:'general',resources,relations,entrypoints:[]}
 files.unshift({path:'teloa.json',text:JSON.stringify(manifest,null,2)});files.push({path:'README.md',text:README})
 return readSharePackageV2({format:'teloa.template-share/v2',subject:input.subject,id,version:ver,title,description,requirements:[...new Set(requirements)],license:input.license??'All rights reserved',trust:{publisher:input.publisher},provenance:{sources,...(input.modifications?{modifications:input.modifications}:{})},sourceFiles:[],...(team?{team}:{}),compatibility:{manifestFormat:'teloa.business-package/v2',capabilities},files})
}
/** 只改标题与说明；正文与资源保持原样并重新核验。 */
export function editSharePackage(pkg:SharePackage,title:string,description:string):SharePackage{
 const manifest=JSON.parse(pkg.files.find(f=>f.path==='teloa.json')!.text)
 return readSharePackage({...pkg,title,description,files:pkg.files.map(f=>f.path==='teloa.json'?{path:f.path,text:JSON.stringify({...manifest,title,description},null,2)}:f)})
}
