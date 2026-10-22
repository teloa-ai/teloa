import type {Context} from '@deepseek-ai/cordis'
import {defineTool,valueSchemaSpecToJsonSchema,validateJsonSchemaValue,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput,readPageCreateAtomicSkillDraft,readPageCreateBody,pageCreateCanonicalBody,pageCreateLimits,pageCreateEntities,templateShareResourceCapability,readPageCreateDraftOrigin,readPageCreateDraftReferences,type PageCreateDraftOrigin,type PageCreateDraftRevisionInput,type PageCreateDraftDirectory,type PageCreateDraftReadResult,type PageCreateDraftPreview,type PageCreateEntity,type WritableRoleDefinition,type MarketCatalogEntry} from '@teloa/contract'
import {savedDraftSummaries} from './saved-draft-summaries.ts'
import {roleAvatarDescription} from './role-avatar-description.ts'
import {registerSavedDraftContext} from './saved-draft-context.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeConversationInstructionMutation,conversationInstructionMutationRequestId,assertConversationInstructionMutationAuthorization,type ConversationInstructionMutationAuthorization} from './conversation-mutation.ts'
import {assertSkillCreatorLoaded,type BuiltinSkillCreator} from './builtin-skill-creator.ts'
import {planDraftGuide} from './plan-draft-guide.ts'
import {planDraftParameters,planDraftBody} from './plan-draft-parameters.ts'
import {readSessionEvents} from './session-events.ts'

export const pageCreateToolNames=['teloa_create_directory','teloa_create_drafts','teloa_create_draft','teloa_create_revise'] as const
export {skillDraftBody,skillDraftParameters}
export type PageCreateToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 /** 只回宿主已经核对过的目录摘要；不提供草案正文、对象取值或任何凭据。 */
 directory:(input:{entity:PageCreateEntity;scope?:string})=>Promise<unknown>
 /** 本人已有草案目录；正文只经固定预览读取，目录不触发创建或应用。 */
 draftDirectory:(input:{entity:PageCreateEntity;scope?:string},signal?:AbortSignal)=>Promise<PageCreateDraftDirectory>
 /** 沿能力原稿的既有正式只读预览，不调用应用或安装。 */
 preview:(input:{draftId:string},signal?:AbortSignal)=>Promise<PageCreateDraftPreview>
 draft:(input:{entity:PageCreateEntity;scope?:string;body:unknown;requestId:string;origin:PageCreateDraftOrigin})=>Promise<unknown>
 revise?:(input:PageCreateDraftRevisionInput,signal:AbortSignal,assertCurrent:()=>Promise<void>)=>Promise<unknown>
 /** 内置技能创建器；null 表示宿主启动时未能准备好，技能草案一律拒绝，其余实体不受影响。 */
 skillCreator:BuiltinSkillCreator|null
}
const entities=pageCreateEntities
const appDraftHelp='\n自定义MCP应用使用entity=app（不是分享模板entity=share）。body是仅含definition的JSON字符串，definition含schema=teloa.mcp-server/v1、serverName（1至32位字母数字下划线或连字符）、title、transport=streamable-http、url。URL必须由本人提供；远程HTTPS，本机回环可HTTP，不带查询参数、片段或账号。静态认证可声明auth:{kind:"headers",headers:[{name:"Authorization",scheme:"Bearer"},{name:"X-API-Key"}]}，最多8个头，只写名称和可选前缀，不写值。无需先制作技能或分享包，不传scope，不编造工具清单；工具只在本人添加并连接后真实发现。密钥由本人在浏览器可信控件填写，任何工具与会话正文都不得接收密钥。保存草稿不授权、不连接、不安装或执行。'
const appManifest={format:'teloa.business-package/v2',id:'meeting-summary-app',version:'1.0.0',title:'会议三条要点应用',description:'只整理本人提供的会议记录，不连接外部账号。',domain:'general',scope:'general',resources:[{id:'meeting-summary',kind:'skill',title:'会议三条要点',version:'1.0.0',required:true,source:{kind:'local',path:'skills/meeting-summary/SKILL.md'}}],relations:[],entrypoints:[]}
const appDraftExample={format:'teloa.template-share/v2',subject:'app',id:appManifest.id,version:appManifest.version,title:appManifest.title,description:appManifest.description,requirements:['本人提供会议记录纯文本。'],license:'MIT',trust:{publisher:'本人创作'},provenance:{sources:[]},sourceFiles:[],compatibility:{manifestFormat:appManifest.format,capabilities:[]},manifest:appManifest,files:[{path:'skills/meeting-summary/SKILL.md',text:'---\nname: meeting-summary\ndescription: 将本人提供的会议记录整理成三条要点。\n---\n只根据本人提供的记录列出三条要点；缺少事实时写待确认，不读取其他文件或对外发送。\n'}]}
// 连接只引用官方目录连接的 serverName 与工具（与手动分享 share-package-plan 同形）；鉴权与凭据在本人「设置连接」时输入，不进模板。
const connectedAppManifest={...appManifest,id:'issue-digest-app',title:'议题周报应用',description:'读取本人 GitHub 议题并整理周报；需本人连接账号。',resources:[{id:'issue-digest',kind:'skill',title:'议题周报',version:'1.0.0',required:true,source:{kind:'local',path:'skills/issue-digest/SKILL.md'}},{id:'mcp-github',kind:'mcp',title:'GitHub',version:'1.0.0',required:false,source:{kind:'local',path:'mcp-github.json'}}]}
const connectedAppDraftExample={...appDraftExample,id:connectedAppManifest.id,title:connectedAppManifest.title,description:connectedAppManifest.description,requirements:['需连接本人账号：GitHub'],compatibility:{manifestFormat:appManifest.format,capabilities:['connections']},manifest:connectedAppManifest,files:[{path:'skills/issue-digest/SKILL.md',text:'---\nname: issue-digest\ndescription: 用本人已连接的 GitHub 读取议题并整理周报。\n---\n只读取本人指定仓库的议题，按状态整理周报；不创建或修改议题。\n'},{path:'mcp-github.json',json:{format:'teloa.mcp-connection/v1',serverName:'github',tools:['list_issues']}}]}
const templateManifestParameters={type:'object',additionalProperties:false,description:'固定业务包清单。resources、relations、entrypoints均为数组；无关系/入口用[]，不能用空字符串。宿主生成唯一teloa.json。',properties:{
 format:{type:'string',enum:['teloa.business-package/v2','teloa.business-package/v3','teloa.business-package/v4'],required:true},id:{type:'string',required:true},version:{type:'string',required:true},title:{type:'string',required:true},description:{type:'string',required:true},domain:{type:'string',required:true},scope:{type:'string'},
 resources:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{id:{type:'string',required:true},kind:{type:'string',enum:['role','skill','knowledge','work-template','plan','mcp','plugin','data-source','execution-tool','object-type','business-view','business-action','business-configuration'],required:true},title:{type:'string',required:true},version:{type:'string',required:true},required:{type:'boolean',required:true},source:{required:true,oneOf:[{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['local'],required:true},path:{type:'string',required:true}}},{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['public'],required:true},id:{type:'string',required:true},version:{type:'string',required:true}}}]},modelDependencies:{type:'array',items:{type:'object',additionalProperties:false,properties:{catalogId:{type:'string',required:true},version:{type:'string',required:true},usage:{type:'string',enum:['speech-to-text','text-to-speech','embedding','rerank','ocr','classification','extraction','chat'],required:true},required:{type:'boolean',required:true}}}}}}},
 relations:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['role-knowledge','role-skill','role-work','role-connection'],required:true},from:{type:'string',required:true},to:{type:'string',required:true}}}},entrypoints:{type:'array',items:{type:'string'},required:true},
}} as const
const templateManifestJsonSchema=valueSchemaSpecToJsonSchema(templateManifestParameters)
// 对应原分享 parser 的 portable employee 白名单；不套用可运行员工的 scopes/skills/knowledge/runtimeConfig。
const responsibilityEntries={type:'array',items:{type:'string'},required:true} as const
const portableRoleParameters={type:'object',additionalProperties:false,description:'可移植静态员工定义；不含账号、scopes、skills、knowledge或运行配置，能力关联只写manifest。',properties:{
 format:{type:'string',enum:['teloa.role/v1'],required:true},name:{type:'string',required:true},kind:{type:'string',enum:['employee'],required:true},duty:{type:'string',required:true},dataScope:{type:'string',required:true},executionScope:{type:'string',required:true},avatarKey:{type:'string',description:roleAvatarDescription},
 responsibility:{type:'object',additionalProperties:false,properties:{triggers:responsibilityEntries,autonomousActions:responsibilityEntries,confirmationPoints:responsibilityEntries,escalationRules:responsibilityEntries,deliveryChecks:responsibilityEntries}},
}} as const
const portableRoleJsonSchema=valueSchemaSpecToJsonSchema(portableRoleParameters)
const shareDraftHelp='\n模板（entity=share）优先直接传 template 对象，不传 body 或 skill，不把 JSON 再放进字符串。template 的 format 固定为 teloa.template-share/v2（不能写 schema）；应用必须用 subject=app，即使应用只包含一个技能也不能改成 skill。其他主体可用 employee/team/skill/mcp。必填 id、version、title、description、requirements（字符串数组）、license（许可名称）、trust:{publisher}、provenance:{sources}、sourceFiles（字符串数组）、compatibility:{manifestFormat,capabilities}、files。version 为固定三段版本号。\n优先传 manifest 强类型对象（其 resources、relations、entrypoints 必须是数组，没有关系和入口时用 []，不能用空字符串）；宿主生成唯一 teloa.json，files 不得再传 teloa.json。manifest 含 format/id/version/title/description/domain、可选 scope 以及 resources/relations/entrypoints。files 每项只含相对路径 path，以及 text 原文或 json 对象二者之一。Markdown直接传 text，其他JSON声明文件直接传 json 对象，宿主只编码一次；不要调用 shell 生成 JSON、Base64 或查找 schema。teloa.json 的 format 和 compatibility.manifestFormat 都用 teloa.business-package/v2、v3或v4，不能写 template-share；清单 id/version 必须与模板一致，resources 每项含 id/kind/title/version/required/source，静态文件用 source:{kind:"local",path:"相对路径"} 并随包提供。应用可以只有原创技能、无员工，无连接时 capabilities=[] 合法，关系与入口无需求时用 []。需要外部账号时先调 teloa_create_directory(entity=share) 取 connectors，只用其中真实的 serverName 与 tools 名：每个连接一项 kind=mcp、required:false 的资源，其 json 文件只含 format:"teloa.mcp-connection/v1"、serverName、tools，不得写 auth、token、密钥、url、recipe、env 等运行配置；capabilities 须含 connections，requirements 写“需连接本人账号：连接名”。凭据由本人在应用目录「设置连接」时填写；目录没有的连接不编造，如实告诉本人。员工一位、团队至少两位；有关系时用已声明资源间的 role-skill/role-knowledge/role-connection，不猜资源。协调者可用 team:{coordinatorResourceId} 明确指定。\n原创模板的 provenance.sources/sourceFiles 可为 []；引用外部原作时 sources 每项含 title/license/resourceIds，可选 https url/version，resourceIds 只能指向包内对应资源。sourceFiles 若非空，每项是 source/ 下JSON原件的相对路径字符串，并在 files 提供原件，不是路径对象。原账号、密钥、本机绝对路径、私人记忆、运行配置和历史不可入包。许可证/作者/出处以本人拥有或已获准的内容为准，固定公共引用前先读目录核对版本，不能伪造。\n最小结构化应用调用：\n'+JSON.stringify({entity:'share',template:appDraftExample})+'\n最小结构化带连接应用调用：\n'+JSON.stringify({entity:'share',template:connectedAppDraftExample})+'\n仅当当前需求为应用时，按应用示例改写名称、用途和正文（有连接需求用带连接示例），保留 subject=app 与资源结构，不要改成独立技能。创建 employee/team/skill/mcp 模板时，按用户当前要创建的对象选择对应 subject，并遵守该主体的原有结构校验，不套用应用示例的 subject 或资源组成。旧调用仅兼容 body 为 {package:...} 的JSON字符串，template 与 body 必须恰好一个；旧 files 的JSON正文仍是 text 字符串。保存后用 teloa_create_preview 回读静态原稿，只保存不调用 apply、安装、发布或授权；模板的后续分享沿原稿分享抽屉完成。失败先读错误，只修正格式后重试一次；取得草案id后回读原稿，不新建同名副本。'
const templateDraftParameters={type:'object',additionalProperties:false,description:'静态分享包对象；应用subject=app，JSON文件传json对象，Markdown传text原文，宿主编码。',properties:{
 format:{type:'string',enum:['teloa.template-share/v2'],required:true},subject:{type:'string',enum:['employee','team','app','skill','mcp'],required:true},id:{type:'string',required:true},version:{type:'string',required:true},title:{type:'string',required:true},description:{type:'string',required:true},requirements:{type:'array',items:{type:'string'},required:true},license:{type:'string',required:true},
 trust:{type:'object',additionalProperties:false,required:true,properties:{publisher:{type:'string',required:true}}},
 provenance:{type:'object',additionalProperties:false,required:true,properties:{sources:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{title:{type:'string',required:true},license:{type:'string',required:true},resourceIds:{type:'array',items:{type:'string'},required:true},url:{type:'string'},version:{type:'string'}}}},modifications:{type:'string'}}},
 sourceFiles:{type:'array',items:{type:'string'},required:true},team:{type:'object',additionalProperties:false,properties:{coordinatorResourceId:{type:'string',required:true}}},
 compatibility:{type:'object',additionalProperties:false,required:true,properties:{manifestFormat:{type:'string',enum:['teloa.business-package/v2','teloa.business-package/v3','teloa.business-package/v4'],required:true},capabilities:{type:'array',items:{type:'string',enum:['people','automation','connections','business']},required:true}}},
 manifest:templateManifestParameters,
 roles:{type:'array',description:'员工/团队优先使用此强类型角色定义，由宿主编码JSON；path必须精确对应manifest声明的本地role路径，不得在files重复。',items:{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},definition:{...portableRoleParameters,required:true}}}},
 files:{type:'array',required:true,items:{oneOf:[{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},text:{type:'string',required:true}}},{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},json:{type:'object',additionalProperties:true,required:true}}}]}},
}} as const
// 工具说明必须自足：真实会话没有仓库源码可查，不能让模型猜岗位字段。
const roleDraftExample:WritableRoleDefinition={name:'研究助理',kind:'employee',scopes:['general'],duty:'根据本人提供的资料整理周报草案',dataScope:'仅本次提供且已获准使用的资料',executionScope:'只分析与代拟，发送或修改外部系统前交由本人确认',skills:[],knowledge:[],responsibility:{triggers:['本人交办周报'],autonomousActions:['归纳资料并代拟周报'],confirmationPoints:['对外发送前请本人确认'],escalationRules:['缺少资料时向本人说明'],deliveryChecks:['核对事实与来源']}}
const roleDraftHelp='员工（entity=role）的 body 是员工定义 JSON 字符串，不是市场包、不是 {fields:...} 请求包装；不接受 format/id/title/description/version 等额外字段。必填 name、kind（employee 或 twin）、scopes（非空业务键数组，通用工作可用 general）、duty、dataScope、executionScope、skills、knowledge、responsibility。skills 为已有原生技能名数组，knowledge 为已有资料 ID 数组；无已核对资源时用 []，不得编造。responsibility 包含 triggers/autonomousActions/confirmationPoints/escalationRules/deliveryChecks 五个字符串数组。运行配置未核对时省略 runtimeConfig。最小员工示例：\n'+JSON.stringify(roleDraftExample)+'\n请按需求改写职责；范围和资源以目录为准。'
function shareRoleDraftExample(team:boolean){
 const id=team?'evidence-review-team':'evidence-review-employee',title=team?'资料核对团队':'资料整理员工'
 const roles=(team?['资料整理员工','资料复核员工']:['资料整理员工']).map((name,index)=>({path:'roles/employee-'+index+'.json',definition:{format:'teloa.role/v1',kind:'employee',name,duty:roleDraftExample.duty,dataScope:roleDraftExample.dataScope,executionScope:roleDraftExample.executionScope,responsibility:roleDraftExample.responsibility}}))
 return {entity:'share',template:{...appDraftExample,subject:team?'team':'employee',id,title,description:'只整理与核对本人提供的资料，不连接外部账号。',requirements:['本人提供明确的资料和整理目标。'],compatibility:{manifestFormat:appManifest.format,capabilities:['people']},manifest:{...appManifest,id,title,description:'只整理与核对本人提供的资料，不连接外部账号。',resources:roles.map((role,index)=>({id:'employee-'+index,kind:'role',title:role.definition.name,version:appManifest.version,required:true,source:{kind:'local',path:role.path}}))},...(team?{team:{coordinatorResourceId:'employee-0'}}:{}),roles,files:[]}}
}
/** 员工依赖的应用（npm 扩展）：资源 kind=plugin、required:false，声明文件只含固定包名与版本；员工经 role-connection 依赖它，接收方一键准备据此先装好已核验的应用。 */
function shareRoleWithAppDraftExample(){
 const base=shareRoleDraftExample(false),template=base.template,app={id:'app-ticket-sync',kind:'plugin',title:'工单同步应用',version:'1.2.0',required:false,source:{kind:'local',path:'apps/ticket-sync.json'}}
 return {entity:'share',template:{...template,id:'ticket-followup-employee',title:'工单跟进员工',description:'按本人提供的工单整理跟进要点；依赖工单同步应用。',requirements:['本人提供要跟进的工单范围。'],compatibility:{manifestFormat:appManifest.format,capabilities:['people','connections']},
  manifest:{...template.manifest,id:'ticket-followup-employee',title:'工单跟进员工',description:'按本人提供的工单整理跟进要点；依赖工单同步应用。',resources:[...template.manifest.resources,app],relations:[{kind:'role-connection',from:'employee-0',to:app.id}]},
  files:[{path:app.source.path,json:{format:'teloa.plugin/v1',registry:'npm',packageName:'@example/ticket-sync',version:app.version}}]}}
}
const shareRoleDraftHelp='\n员工/团队静态模板（entity=share，subject=employee/team）优先用 template.roles 数组，每项只含 path 与 definition；宿主编码角色JSON一次，files中不要重复这些path；没有其他文件时files=[]。path必须精确对应manifest.resources中kind=role的local路径。definition只收 format:"teloa.role/v1"、name、kind:"employee"、duty、dataScope、executionScope，可选avatarKey与responsibility。responsibility若提供，须含triggers/autonomousActions/confirmationPoints/escalationRules/deliveryChecks五个字符串数组；没有条目用[]，不能用空字符串或{item:...}。此处不是entity=role运行定义，禁止scopes、skills、knowledge、runtimeConfig、ownerId、员工ID或状态；关联能力须在清单中声明并随包提供或固定公共引用，不把私人资料ID塞入角色。员工一位、团队至少两位；compatibility.capabilities必须声明people，这是原分享格式的兼容要求，不创建员工、不启用或授予权限。外层工具不传scope；manifest.scope可用general或省略，缺省沿domain。旧files中角色JSON仍严格校验，不自动删错字段或转换伪数组。\n最小结构化员工模板调用：\n'+JSON.stringify(shareRoleDraftExample(false))+'\n最小结构化团队模板调用：\n'+JSON.stringify(shareRoleDraftExample(true))+'\n员工依赖的应用（npm 扩展）随员工声明：每个应用一项 kind=plugin、required:false 的资源，其 json 文件只含 format:"teloa.plugin/v1"、registry:"npm"、packageName 与固定 version（与资源 version 相同），再用 role-connection 从该员工指向应用；capabilities 须含 connections。只用本人明确指定或已在用的真实应用包名与版本，不编造；不知道时如实询问本人。接收方一键准备只自动安装已核验、只新增配置的应用，会改动现有配置的交本人确认，员工在应用就绪后才上岗。\n最小结构化带依赖应用员工模板调用：\n'+JSON.stringify(shareRoleWithAppDraftExample())+'\n只保存后用teloa_create_preview回读同一原稿；创建模板不调用实际员工创建、安装、应用或启用。'
const skillDraftExample={id:'content-review',title:'内容核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',content:'---\nname: content-review\ndescription: Review an internal content draft against supplied sources.\n---\nCheck facts against the supplied sources and list unresolved questions.\n'}]}
const skillDraftHelp='\n技能（entity=skill）优先直接传 skill 对象，包含 id、title、version、categories、files；不要传 body，不把 JSON 再放进字符串。version 用固定三段版本号；categories 无分类时用 []；文本文件每项只含相对路径 path 和原文 content，必须恰好有一份 SKILL.md。直接写 Markdown，宿主按 UTF-8 完整编码并校验；不要调用 shell 生成 JSON、Base64 或查找工具 schema。旧二进制文件可用 base64，content 与 base64 必须恰好一个。不传本机路径或 scope。最小结构化技能调用：\n'+JSON.stringify({entity:'skill',skill:skillDraftExample})+'\n旧调用仅兼容 body 为技能对象序列化字符串，skill 与 body 必须恰好一个；新调用使用上面的结构化对象。旧版最小技能示例：\n'+JSON.stringify(skillDraftExample)+'\n保存后用 teloa_create_preview 回读正文；只保存时不要 apply、安装或启用。失败未保存时先读错误，只修正后重试一次；已取得草案 id 后先回读原草案，不要用新的 create_draft 调用创建同名副本。'
const skillDraftParameters={type:'object',additionalProperties:false,description:'技能的明确结构化定义；直接传对象，不传JSON字符串。',properties:{id:{type:'string',required:true},title:{type:'string',required:true},version:{type:'string',required:true},categories:{type:'array',items:{type:'string'},required:true},files:{type:'array',required:true,items:{oneOf:[{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},content:{type:'string',required:true}}},{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},base64:{type:'string',required:true}}}]}}}} as const

/** 仅在技能工具传输边界编码文本；存储与其他实体仍使用原有严格契约。 */
function skillDraftBody(value:unknown){
 if(!isRecord(value)||!Array.isArray(value.files))return readPageCreateAtomicSkillDraft(value)
 const files=value.files.map(file=>{
  if(!isRecord(file)||!Object.hasOwn(file,'content'))return file
  if(Object.keys(file).length!==2||!Object.hasOwn(file,'path')||typeof file.content!=='string')throw new WorkError('teloa/invalid-input','技能文本文件必须只含 path 和原文 content；不能同时传 base64。')
  const bytes=Buffer.from(file.content,'utf8')
  if(bytes.byteLength>2*1024*1024||bytes.toString('utf8')!==file.content)throw new WorkError('teloa/invalid-input','技能文本文件必须是有效 UTF-8 原文，且不超过 2 MiB。')
  return {path:file.path,base64:bytes.toString('base64')}
 })
 return readPageCreateAtomicSkillDraft({...value,files})
}
/** 工具只消除文件内层JSON字符串转义；分享包的路径、资源闭包与敏感信息仍由原读取器核对。 */
function checkTemplateManifest(value:unknown,path:string){
 const issues=validateJsonSchemaValue(templateManifestJsonSchema,value,path)
 if(issues.length)throw new WorkError('teloa/invalid-input','模板清单字段不正确：'+issues.slice(0,6).join('；')+'。只修正这些字段后重试；没有关系或入口时用 []。')
}
function checkManifestFile(file:Record<string,unknown>,path:string){
 if(file.path!=='teloa.json')return
 if(Object.hasOwn(file,'json')){checkTemplateManifest(file.json,path+'.json');return file.json}
 else if(typeof file.text==='string'){
  let manifest:unknown;try{manifest=JSON.parse(file.text)}catch{throw new WorkError('teloa/invalid-input',path+'.text 必须是合法清单JSON。建议改传 template.manifest 对象，由宿主编码。')}
  checkTemplateManifest(manifest,path+'.text')
  return manifest
 }
}
function checkPortableRole(value:unknown,path:string){
 const issues=validateJsonSchemaValue(portableRoleJsonSchema,value,path)
 if(issues.length)throw new WorkError('teloa/invalid-input','模板员工字段不正确：'+issues.slice(0,12).join('；')+'。仅修正这些字段；角色不携带私人身份、scopes、skills、knowledge或运行配置，职责条目须为字符串数组。')
}
function declaredRolePaths(manifest:unknown):Set<string>{
 if(!isRecord(manifest)||!Array.isArray(manifest.resources))return new Set()
 return new Set(manifest.resources.flatMap(resource=>isRecord(resource)&&resource.kind==='role'&&isRecord(resource.source)&&resource.source.kind==='local'&&typeof resource.source.path==='string'?[resource.source.path]:[]))
}
function checkPortableRoleFiles(manifest:unknown,files:unknown[],path:string){
 const roles=declaredRolePaths(manifest)
 files.forEach((file,index)=>{
  if(!isRecord(file)||typeof file.path!=='string'||!roles.has(file.path))return
  if(Object.hasOwn(file,'json'))checkPortableRole(file.json,path+'['+index+'].json')
  else if(typeof file.text==='string'){
   let role:unknown;try{role=JSON.parse(file.text)}catch{throw new WorkError('teloa/invalid-input',path+'['+index+'].text 必须是合法员工JSON；建议改用template.roles。')}
   checkPortableRole(role,path+'['+index+'].text')
  }
 })
}
/** 资源类型与兼容能力的对应沿分享包读取器同一张表；此处只先给出可修正的字段路径。 */
function checkCapabilities(manifest:unknown,compatibility:unknown,path:string){
 if(!isRecord(manifest)||!Array.isArray(manifest.resources)||!isRecord(compatibility)||!Array.isArray(compatibility.capabilities))return
 for(const resource of manifest.resources){
  const kind=isRecord(resource)&&typeof resource.kind==='string'?resource.kind:'',capability=templateShareResourceCapability(kind)
  if(capability&&!compatibility.capabilities.includes(capability))throw new WorkError('teloa/invalid-input',path+'.compatibility.capabilities 必须包含'+capability+'，才能声明'+kind+'资源的原格式兼容性；此声明不启用员工、连接或授予权限。')
 }
}
function templateDraftBody(value:unknown){
 const issues=validateJsonSchemaValue(valueSchemaSpecToJsonSchema(templateDraftParameters),value,'template')
 if(issues.length)throw new WorkError('teloa/invalid-input','模板字段不正确：'+issues.slice(0,12).join('；')+'。仅修正列出的字段后重新提交；这不是同名草稿冲突。')
 if(!isRecord(value)||!Array.isArray(value.files))throw new WorkError('teloa/invalid-input','模板必须是包含 files 的结构化分享包对象。')
 const structuredManifest=Object.hasOwn(value,'manifest')
 if(structuredManifest)checkTemplateManifest(value.manifest,'template.manifest')
 let declaredManifest:unknown=structuredManifest?value.manifest:undefined
 const files=value.files.map((file,index)=>{
  if(!isRecord(file)||Object.keys(file).length!==2||!Object.hasOwn(file,'path')||Object.hasOwn(file,'text')===Object.hasOwn(file,'json'))throw new WorkError('teloa/invalid-input','模板文件必须只含 path 与 text 或 json 二者之一。')
  if(structuredManifest&&file.path==='teloa.json')throw new WorkError('teloa/invalid-input','template.manifest 已生成唯一 teloa.json，不能同时在 template.files 提供同名文件。')
  const manifest=checkManifestFile(file,'template.files['+index+']');if(manifest!==undefined)declaredManifest=manifest
  if(Object.hasOwn(file,'json')){
   if(typeof file.path!=='string'||!file.path.endsWith('.json')||!isRecord(file.json))throw new WorkError('teloa/invalid-input','模板 json 只接受JSON文件路径与对象；Markdown请使用 text 原文。')
   return {path:file.path,text:JSON.stringify(file.json)}
  }
  if(typeof file.text!=='string'||Buffer.from(file.text,'utf8').toString('utf8')!==file.text)throw new WorkError('teloa/invalid-input','模板 text 必须是有效 UTF-8 原文。')
  return file
 })
 checkPortableRoleFiles(declaredManifest,value.files,'template.files')
 checkCapabilities(declaredManifest,value.compatibility,'template')
 if(value.roles!==undefined){
  if(!Array.isArray(value.roles))throw new WorkError('teloa/invalid-input','template.roles 必须是角色定义数组。')
  const declared=declaredRolePaths(declaredManifest),paths=new Set(files.map(file=>file.path))
  value.roles.forEach((role,index)=>{
   const path='template.roles['+index+']'
   if(!isRecord(role)||Object.keys(role).some(key=>!['path','definition'].includes(key))||typeof role.path!=='string'||!declared.has(role.path))throw new WorkError('teloa/invalid-input',path+'.path 必须精确对应manifest中声明的本地员工资源路径。')
   if(paths.has(role.path))throw new WorkError('teloa/invalid-input',path+'.path 与files或其他roles重复；同一角色只提供一次。')
   checkPortableRole(role.definition,path+'.definition');paths.add(role.path)
   files.push({path:role.path,text:JSON.stringify(role.definition)})
  })
 }
 const {manifest,roles,...pkg}=value
 if(structuredManifest)files.unshift({path:'teloa.json',text:JSON.stringify(manifest)})
 return {package:{...pkg,files}}
}
/** 分享模板可引用的已审目录连接：只给服务名、显示名、工具名与鉴权方式（含密钥槽名称），不含配方、地址、授权范围或任何取值。 */
export function shareConnectorDirectory(entries:readonly MarketCatalogEntry[]){
 return entries.flatMap(entry=>{
  if(entry.kind!=='connector')return []
  const {compatibility,connector:{serverName,title,tools,auth}}=entry
  if(compatibility.status==='unsupported'||!tools.length||auth.kind==='oauth'&&(!auth.supported||auth.requiresAllowlist&&!auth.requiresUserClientId))return []
  return [{serverName,title:title['zh-CN'],tools:tools.map(tool=>tool.name),auth:auth.kind,...(auth.kind==='secret'?{secrets:auth.vars.flatMap(item=>item.target==='basic'?[item.userLabel['zh-CN'],item.label['zh-CN']]:[item.label['zh-CN']])}:{})}]
 })
}
const entity=(value:unknown):value is PageCreateEntity=>(entities as readonly string[]).includes(value as string)
/** 只有业务与连接器需要业务范围；员工、技能、扩展缺省，见客户端 CreateEntryProps.scope 注释。 */
const scopedEntities=new Set<PageCreateEntity>(['business-definition','business-domain','connector'])
const scope=(value:unknown):string|undefined=>{
 if(value===undefined)return undefined
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>120||/[\x00-\x1f\x7f]/.test(value)||value==='general')throw new WorkError('teloa/invalid-input','业务范围不正确：业务与连接必须给一个已登记的业务范围，不能是通用工作（general）。')
 return value
}
function directoryInput(value:unknown){
 const row=taskInput(value,['entity','scope'])
 if(!entity(row.entity))throw new WorkError('teloa/invalid-input','页内新建目录格式不正确。')
 if(!scopedEntities.has(row.entity))return {entity:row.entity}
 const businessScope=scope(row.scope)
 return {entity:row.entity,...(businessScope===undefined?{}:{scope:businessScope})}
}
function lookupInput(value:unknown){
 const row=taskInput(value,['entity','scope','title','preview'])
 const directory=directoryInput({entity:row.entity,...(row.scope===undefined?{}:{scope:row.scope})})
 if(row.title!==undefined&&(typeof row.title!=='string'||!row.title.trim()||row.title!==row.title.trim()||row.title.length>240||/[\x00-\x1f\x7f]/.test(row.title)))throw new WorkError('teloa/invalid-input','请使用原稿的完整名称。')
 if(row.preview!==undefined&&typeof row.preview!=='boolean'||row.preview===true&&(row.title===undefined||!['skill','connector','extension','plan'].includes(directory.entity)))throw new WorkError('teloa/invalid-input','查看原稿需要明确的技能、连接器、扩展或计划名称；其他实体沿原管理入口读取。')
 return {directory,title:row.title as string|undefined,preview:row.preview===true}
}
function draftInput(value:unknown){
 const row=taskInput(value,['entity','scope','body','skill','template','plan'])
 if(!entity(row.entity))throw new WorkError('teloa/invalid-input','页内新建草案格式不正确。')
 const structured=Object.hasOwn(row,'skill'),template=Object.hasOwn(row,'template'),plan=Object.hasOwn(row,'plan')
 if(plan&&(row.entity!=='plan'||Object.hasOwn(row,'body')||structured||template))throw new WorkError('teloa/invalid-input','plan 仅用于计划草稿，不能与其他正文混用。')
 if(structured&&row.entity!=='skill'||template&&row.entity!=='share'||row.entity==='skill'&&structured===Object.hasOwn(row,'body')||row.entity==='share'&&template===Object.hasOwn(row,'body'))throw new WorkError('teloa/invalid-input','skill 仅用于技能、template 仅用于模板；对应结构化对象与旧 body 必须恰好一个，不能混用。')
 let body:unknown
 if(structured||template||plan){
  const encoded=JSON.stringify(structured?row.skill:template?row.template:row.plan)
  if(typeof encoded!=='string'||encoded.length>131072)throw new WorkError('teloa/invalid-input','页内新建草案格式不正确。')
  body=structured?skillDraftBody(row.skill):template?templateDraftBody(row.template):row.plan
 }else{
  if(typeof row.body!=='string'||!row.body.trim()||row.body.length>131072)throw new WorkError('teloa/invalid-input','页内新建草案格式不正确。')
  try{body=JSON.parse(row.body)}catch{throw new WorkError('teloa/invalid-input','草案正文必须是 JSON。')}
  if(row.entity==='skill')body=skillDraftBody(body)
 }
 if(row.entity==='plan')body=planDraftBody(body)
 if(row.entity==='share'){
  if(isRecord(body)&&isRecord(body.package)&&Array.isArray(body.package.files)){
   let manifest:unknown
   body.package.files.forEach((file,index)=>{if(isRecord(file)){const checked=checkManifestFile(file,'body.package.files['+index+']');if(checked!==undefined)manifest=checked}})
   if(!template){checkPortableRoleFiles(manifest,body.package.files,'body.package.files');checkCapabilities(manifest,body.package.compatibility,'body.package')}
  }
  body=readPageCreateBody('share',body);pageCreateCanonicalBody(body)
 }
 if(!scopedEntities.has(row.entity))return {entity:row.entity,body}
 const businessScope=scope(row.scope)
 if(businessScope===undefined)throw new WorkError('teloa/invalid-input','此类新建对象需要业务范围。')
 return {entity:row.entity,body,scope:businessScope}
}
function reviseInput(value:unknown){
 const row=taskInput(value,['draftId','expectedBodyHash','entity','scope','body','skill','template','plan']),{draftId,expectedBodyHash,...body}=row
 if(typeof draftId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(draftId)||typeof expectedBodyHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedBodyHash))throw new WorkError('teloa/invalid-input','修改草稿需要原稿身份与刚读取的正文摘要。')
 return {...draftInput(body),draftId,expectedBodyHash}
}
function draftInstruction(exec:Parameters<Context['tools']['execute']>[0],authorization:ConversationInstructionMutationAuthorization):PageCreateDraftOrigin{
 if(!exec.agent)throw new WorkError('teloa/forbidden','草稿需要真实本人消息。')
 const event=readSessionEvents(exec.agent.session).find(event=>event.seq===authorization.instruction.seq)
 if(!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.source.kind!=='user'||event.data.id!==authorization.instruction.messageId)throw new WorkError('teloa/forbidden','草稿需要原生本人消息的稳定来源。')
 return readPageCreateDraftOrigin({sessionId:authorization.sessionId,messageId:event.data.id,messageSeq:event.seq,...('rpcId'in event.data.source?{requestId:event.data.source.rpcId}:{})})
}
function assertDraftRevisionReference(exec:Parameters<Context['tools']['execute']>[0],authorization:ConversationInstructionMutationAuthorization,input:{draftId:string;expectedBodyHash:string}):void{
 const event=exec.agent&&readSessionEvents(exec.agent.session).find(event=>event.seq===authorization.instruction.seq)
 if(!event||event.type!=='user/message'||event.data.source.kind!=='user'||event.data.id!==authorization.instruction.messageId)throw new WorkError('teloa/forbidden','草稿修改需要当前本人消息。')
 const references=readPageCreateDraftReferences(event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
 if(references.some(reference=>reference.draftId!==input.draftId.toLowerCase()||reference.bodyHash!==input.expectedBodyHash))throw new WorkError('teloa/version-conflict','修改目标与本人选定的原稿或摘要不同，请重新打开原稿。')
}

/** 对话先保存草案，再通过固定预览与应用工具沿已有实体处理路径落地。 */
export function registerPageCreateTools(ctx:Context,ports:PageCreateToolsPorts){
 const checked=new WeakMap<object,ConversationInstructionMutationAuthorization>()
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0])=>authorizeConversationInstructionMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 // 技能草案必须由创建器生成：创建器正文要在当前模型可见上下文中且与固定版本一致，模型自报不算。
 const creatorLoaded=(exec:Parameters<typeof ctx.tools.execute>[0],entity:PageCreateEntity)=>{
  if(entity!=='skill')return
  if(!ports.skillCreator)throw new WorkError('teloa/dependency-unavailable','技能创建器不可用，暂不能生成技能草案。')
  if(!exec.agent)throw new WorkError('teloa/forbidden','技能草案需要真实本人普通会话。')
  assertSkillCreatorLoaded(exec.agent.session,ports.skillCreator)
 }
 const definitions=[
  {name:'teloa_create_directory' as const,description:'读取本人已有的业务范围、员工、技能、连接和官方扩展目录摘要，用于生成新建草案前核对名称、范围与来源。不返回对象取值、草案正文或凭据。员工、技能、扩展不需要 scope（传了会被忽略）；业务定义、连接必须传本人已登记的业务范围；新增一类业务（business-domain）用的是尚未登记的新范围键，不必先登记。scope 只能是 1–64 位字母、数字、下划线或连字符（如 recruiting），不能是中文或 general。',parameters:{entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'}}},
  {name:'teloa_create_drafts' as const,description:'只读检索本人以前保存的新建草案，可从另一条本人普通会话按名称找到原稿，不新建、不应用、不安装。用户指定名称时把完整名称传 title，唯一同名匹配无论是否展开正文，都会提供本会话原生原稿卡；只返回匹配项，不再建议用户去未核验的管理页面。不要把近义名称当作旧名或列无关草稿。用户明确要求查看技能、连接器或扩展原稿时同时传 preview=true，唯一匹配沿与 teloa_create_preview 相同的正式读取服务核对原稿，返回独立只读结果与本会话原稿卡；该结果不带创建预览中的安装/应用下一步，无需再问是否读取；只问状态时省略 preview 或传 false，不读取正文。只读核对完成后说明真实状态和原稿入口即可，不提议未要求的安装、修改或删除。目录每类最多返回最近 16 条，待确认草案优先；未命中不能断言从未保存。重名不会读取正文，让用户按时间和状态选择，不猜身份。员工与业务草案在原页面继续。draft 表示已保存未应用；applied 只证明草案已应用，不证明安装、启用、连接或运行，须另查原对象真实状态。员工、技能、扩展不需要 scope；业务定义、业务类别和连接器需要对应业务范围。失败须说明暂不能核实，不能伪装成空目录或重建同名草案。',parameters:{entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'},title:{type:'string',description:'用户明确指定的完整名称，精确匹配，不猜近义名称。'},preview:{type:'boolean',description:'仅当用户明确要求查看原稿时为true；唯一匹配直接返回正式只读预览及原生资源卡。'}}},
  {name:'teloa_create_draft' as const,description:'把一份已校验的新建定义保存成草案。只能用于本人普通工作会话；保存不创建、安装、授权或启用任何东西。技能、连接器和官方扩展随后可在本会话调用 teloa_create_preview 核对内容与影响，按用户授权调用 teloa_create_apply 应用，也可在对应页面继续。实际创建或管理员工才优先使用 teloa_employees_create/update 等工具；仅准备可分享的员工或团队模板时用 entity=share、subject=employee/team，不调用实际员工创建。自然语言新建或调整业务使用原业务搭建会话：尚无草案时请引导本人在“业务”页点击“新建业务”，再继续描述；已有草案打开原搭建会话。本工具的 business-domain 仅兼容已有完整行业包，不是自然语言业务搭建的替代入口；不要猜 scope、清单格式或反复试错。这两类旧草案如已保存，可继续在对应页面处理。员工、技能、扩展不需要 scope（传了会被忽略）；业务定义、连接必须传本人已登记的业务范围；新增一类业务（business-domain）用的是尚未登记的新范围键，不必先登记。scope 只能是 1–64 位字母、数字、下划线或连字符（如 recruiting），不能是中文或 general。技能草案的 SKILL.md 必须带 frontmatter，name 与草案 id 相同且只含小写字母、数字、连字符，description 必填；中文名字放 title。业务定义正文是三种声明之一，校验失败会指出缺少或不认识的字段路径：teloa.business-object-type/v1（顶层必填 format/id/version/domain/title/unit/lead/sourceId/fields，可选 localized/progress/defaultAction）；teloa.business-view/v1（顶层必填 format/id/version/domain/title/kind/chart/objectType/measures/filters/limit，distribution/trend 需另加 dimension，非 board-card 需另加 sort，可选 localized/window）；teloa.business-action/v1（顶层必填 format/id/version/domain/title/objectType/target/inputs，可选 localized）。',parameters:{entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'},body:{type:'string',description:'旧JSON正文字符串；技能新调用请用skill对象，分享模板请用template对象，自定义MCP应用请用body，其余实体必填。'},skill:skillDraftParameters,template:templateDraftParameters,plan:planDraftParameters}},
  {name:'teloa_create_revise' as const,description:'继续修改同一条尚未应用的创建草稿。先回读原稿取得draftId、bodyHash，将bodyHash作为expectedBodyHash，并提交完整修订正文；技能使用skill对象，分享模板使用template对象，自定义MCP应用使用body，计划使用plan对象，其余使用原格式body。本人消息含teloa://draft/原稿引用时必须逐字使用该身份和摘要，不能按同名换稿或用后来摘要替换。只能在原创建会话由当前本人消息发起；保持原草稿ID、实体和业务归属，保存旧正文与本次修订回执。该工具不修改已有对象，不确认、安装、启用或执行；计划必须保留save-paused。同次调用丢失回执可只读恢复；更换正文/来源的重放、过期摘要、并发、已应用/丢弃、来源或权限变化会拒绝，重新回读后由本人决定，不新建同名替代稿。',parameters:{draftId:{type:'string',required:true},expectedBodyHash:{type:'string',required:true},entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'},body:{type:'string'},skill:skillDraftParameters,template:templateDraftParameters,plan:planDraftParameters}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,
  description:definition.description+(definition.name==='teloa_create_draft'?roleDraftHelp+skillDraftHelp+shareDraftHelp+shareRoleDraftHelp+planDraftGuide+appDraftHelp:definition.name==='teloa_create_revise'?appDraftHelp:definition.name==='teloa_create_drafts'?'计划原稿同样支持 preview=true，只读之后在原稿由本人确认。':''),
  output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},
  execute:async(args,exec)=>{
   const authorization=await authorize(exec)
   assertConversationInstructionMutationAuthorization(checked.get(exec),authorization)
   if(definition.name==='teloa_create_directory')return JSON.stringify(await ports.directory(directoryInput(args)))
   if(definition.name==='teloa_create_revise'){
    if(!ports.revise)throw new WorkError('teloa/dependency-unavailable','草稿修改服务暂不可用。')
    const input=reviseInput(args);creatorLoaded(exec,input.entity);assertDraftRevisionReference(exec,authorization,input)
    const current=async()=>{exec.signal.throwIfAborted();assertConversationInstructionMutationAuthorization(authorization,await authorize(exec));exec.signal.throwIfAborted()}
    await current()
    const requestId=conversationInstructionMutationRequestId(authorization,definition.name,exec.callId),acceptedSource=draftInstruction(exec,authorization)
    const result=await ports.revise({...input,requestId,acceptedSource},exec.signal,current);await current();return JSON.stringify(result)
   }
   if(definition.name==='teloa_create_drafts'){
    const input=lookupInput(args),page=await ports.draftDirectory(input.directory,exec.signal)
    exec.signal.throwIfAborted()
    const summary=savedDraftSummaries(page,input.directory,ports.owner)
    const matches=input.title===undefined?summary.drafts:summary.drafts.filter(draft=>draft.title===input.title)
    assertConversationInstructionMutationAuthorization(authorization,await authorize(exec))
    if(input.preview&&matches.length===1){
     assertConversationInstructionMutationAuthorization(authorization,await authorize(exec))
     const match=matches[0]!,preview=await ports.preview({draftId:match.id},exec.signal)
     exec.signal.throwIfAborted()
     assertConversationInstructionMutationAuthorization(authorization,await authorize(exec))
     const original=page.drafts.find(draft=>draft.id===match.id)!
     if(!isRecord(preview)||preview.schema!=='teloa.page-create-draft-preview/v1'||!isRecord(preview.draft)||preview.draft.ownerId!==ports.owner||preview.draft.id!==match.id||preview.draft.title!==match.title||preview.draft.entity!==match.entity||preview.draft.scope!==match.scope||preview.draft.bodyHash!==match.bodyHash||preview.draft.body!==original.body||preview.draft.status!==match.status||preview.draft.appliedRef!==match.appliedRef||preview.draft.updatedAt!==match.updatedAt)throw new WorkError('teloa/version-conflict','原稿身份或内容已变化，请重新核对原稿。')
     if(typeof preview.computedAt!=='string'||!Number.isFinite(Date.parse(preview.computedAt))||new Date(preview.computedAt).toISOString()!==preview.computedAt)throw new WorkError('teloa/invalid-host-response','原稿读取时间不正确。')
     return JSON.stringify({schema:'teloa.page-create-draft-read/v1',ownerId:ports.owner,sessionId:authorization.sessionId,draft:preview.draft,readAt:preview.computedAt,next:{kind:'open-original',title:preview.draft.title}} satisfies PageCreateDraftReadResult)
    }
    if(input.title!==undefined&&matches.length===1)return JSON.stringify({schema:'teloa.page-create-draft-reference/v1',ownerId:ports.owner,sessionId:authorization.sessionId,draft:matches[0],next:'本次查询已提供原生原稿卡，可直接打开查看；本次只读查询未进行应用、安装或启用，既有启停状态以原资源为准。'})
    return JSON.stringify({...summary,drafts:matches,...(input.title===undefined?{}:{title:input.title}),...(input.preview?{previewState:matches.length?'ambiguous':'not-found'}:{})})
   }
   const draft=draftInput(args);creatorLoaded(exec,draft.entity)
   const requestId=conversationInstructionMutationRequestId(authorization,'teloa_create_draft',exec.callId)
   return JSON.stringify(await ports.draft({...draft,requestId,origin:draftInstruction(exec,authorization)}))
  },
 }))
 const releaseContext=registerSavedDraftContext(ctx,ports)
 const releaseTools=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(pageCreateToolNames as readonly string[]).includes(exec.name))return next()
  try{const authorization=await authorize(exec);if(exec.name==='teloa_create_drafts')lookupInput(exec.arguments);else if(exec.name==='teloa_create_directory')directoryInput(exec.arguments);else{if(exec.name==='teloa_create_revise'){const input=reviseInput(exec.arguments);creatorLoaded(exec,input.entity);assertDraftRevisionReference(exec,authorization,input)}else creatorLoaded(exec,draftInput(exec.arguments).entity);draftInstruction(exec,authorization)}checked.set(exec,authorization)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对页内新建草案身份。'}}
  return next()
 },{prepend:true})
 return ()=>{releaseContext();releaseTools()}
}
