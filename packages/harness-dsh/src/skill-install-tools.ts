import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput} from '@teloa/contract'
import {authorizePlanManagement,planRequestIdentity,safePlanOperation,type PlanToolsPorts} from './plan-tools.ts'

export const skillInstallToolNames=['teloa_skills_directory','teloa_skills_preview','teloa_skills_install','teloa_skills_observe','teloa_skills_uninstall'] as const
export type SkillInstallToolsPorts=Pick<PlanToolsPorts,'owner'|'conversation'|'readTaskPolicy'>&{
 directory:()=>Promise<unknown>
 handler:(method:string,payload:unknown)=>Promise<unknown>
}

const names=new Set<string>(skillInstallToolNames)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
/** 卸载前用真实安装记录核对身份/版本/摘要；不把 owner、路径或哈希派生字段回给模型。 */
function uninstallIdentity(value:unknown,request:{installationId:string;expectedVersion:number;expectedBundleHash:string}){
 if(!isRecord(value)||typeof value.id!=='string'||value.id.toLowerCase()!==request.installationId||!isRecord(value.native)||typeof value.native.name!=='string'||!value.native.name)throw new WorkError('teloa/source-unavailable','技能安装身份已变化，请重新读取技能目录。')
 if(value.state!=='installed')throw new WorkError('teloa/conflict','技能安装尚未完成，不能卸载；请先完成安装或继续核对。')
 if(value.version!==request.expectedVersion||value.bundleHash!==request.expectedBundleHash)throw new WorkError('teloa/version-conflict','技能安装已变化，请刷新目录后重试。')
 return {name:value.native.name}
}
const atomicSource={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['atomic'],required:true},contentId:{type:'string',required:true}}} as const
const industrySource={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['industry'],required:true},loadId:{type:'string',required:true},itemInstanceId:{type:'string',required:true}}} as const
const sourceSchema={oneOf:[atomicSource,industrySource],required:true} as const

function source(value:unknown){
 const row=taskInput(value,['kind','contentId','loadId','itemInstanceId'])
 if(row.kind==='atomic'){taskInput(row,['kind','contentId']);return {kind:'atomic' as const,contentId:row.contentId}}
 taskInput(row,['kind','loadId','itemInstanceId'])
 if(row.kind!=='industry')throw new WorkError('teloa/invalid-input','技能来源格式不正确。')
 return {kind:'industry' as const,loadId:row.loadId,itemInstanceId:row.itemInstanceId}
}

function previewIdentity(value:unknown,expectedBundleHash:string,expectedTrustHash:unknown){
 if(!isRecord(value)||!isRecord(value.native)||typeof value.native.name!=='string'||!value.native.name||value.bundleHash!==expectedBundleHash)throw new WorkError('teloa/source-unavailable','技能锁定来源的校验值已变化。')
 if(value.trustHash!==undefined&&(!hash(value.trustHash)||expectedTrustHash!==value.trustHash))throw new WorkError('teloa/source-unavailable','来源的信任说明已变化，请重新预览并核对。')
 if(value.trustHash===undefined&&expectedTrustHash!==undefined)throw new WorkError('teloa/source-unavailable','来源的信任说明与预览不一致。')
 const signature=isRecord(value.trust)&&isRecord(value.trust.signature)?value.trust.signature.status:undefined
 return {name:value.native.name,trustHash:value.trustHash as string|undefined,signature:signature==='verified'?'已验证':signature==='invalid'?'无效':'未验证'}
}

/** 自然语言入口只接受固定来源身份，并复用现有严格安装 handler 与默认工作区观测。 */
export function registerSkillInstallTools(ctx:Context,ports:SkillInstallToolsPorts){
 const definitions=[
  {name:'teloa_skills_directory' as const,description:'列出本人已保存的原子技能、已加载行业技能、真实安装记录和行业使用关系。先从目录取得锁定来源的身份；目录出现不表示已经授权安装。此目录不包含未应用的新建草案；用户查以前写好或保存的技能原稿时，另调用 teloa_create_drafts（entity=skill）按名称查草稿，再用 teloa_create_preview 回读；本目录未命中不能断言没有原稿。',parameters:{}},
  {name:'teloa_skills_preview' as const,description:'预览目录中锁定版本的技能来源，返回完整文件清单、安装包校验值（bundleHash）、信任信息校验值（trustHash）、原生名称、扩展与连接需求和权限。安装前必须使用本次返回的校验值。',parameters:{source:sourceSchema}},
  {name:'teloa_skills_install' as const,description:'安装、复用或继续核对一个锁定版本的技能来源。需要预览返回的 bundleHash 和 trustHash，并由本人确认在当前 Teloa 上的安装行为；不执行技能正文或附件。',parameters:{source:sourceSchema,expectedBundleHash:{type:'string',required:true},expectedTrustHash:{type:'string'}}},
  {name:'teloa_skills_observe' as const,description:'观测一项真实安装在默认工作区是否可用、被同名来源遮蔽或缺失。结果只代表默认工作区。',parameters:{installationId:{type:'string',required:true}}},
  {name:'teloa_skills_uninstall' as const,description:'硬卸载一项本人已安装技能。仅在本人明确要求卸载某个已安装技能时调用；必须先调用 teloa_skills_directory 取得真实 installationId、版本和安装包校验值，不得自行推断或猜测技能。不可撤销：删除本机受管技能目录与安装记录；当前选中的多版本、仍被加载包引用或被历史运行引用时会被拒绝（历史运行证据不删除，被引用时只可停用）。',parameters:{installationId:{type:'string',required:true},expectedVersion:{type:'number',required:true},expectedBundleHash:{type:'string',required:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const sessionId=await authorizePlanManagement(ports,exec,'技能安装')
  return safePlanOperation(async()=>{
   if(definition.name==='teloa_skills_directory'){taskInput(args,[]);return JSON.stringify(await ports.directory())}
   if(definition.name==='teloa_skills_preview'){const row=taskInput(args,['source']);return JSON.stringify(await ports.handler('skill-installations/preview',{source:source(row.source)}))}
   if(definition.name==='teloa_skills_observe'){const row=taskInput(args,['installationId']);return JSON.stringify(await ports.handler('skill-installations/observe',{installationId:row.installationId}))}
   if(definition.name==='teloa_skills_uninstall'){
    const row=taskInput(args,['installationId','expectedVersion','expectedBundleHash'])
    if(!uuid(row.installationId)||!positive(row.expectedVersion)||!hash(row.expectedBundleHash))throw new WorkError('teloa/invalid-input','技能卸载参数格式不正确。')
    const target=(row.installationId as string).toLowerCase(),expectedVersion=row.expectedVersion as number,expectedBundleHash=row.expectedBundleHash as string
    uninstallIdentity(await ports.handler('skill-installations/get',{installationId:target}),{installationId:target,expectedVersion,expectedBundleHash})
    const requestId=planRequestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
    return JSON.stringify({requestId,...await ports.handler('skill-installations/uninstall',{requestId,installationId:target,expectedVersion,expectedBundleHash,confirm:true}) as object})
   }
   const row=taskInput(args,['source','expectedBundleHash','expectedTrustHash']);if(!hash(row.expectedBundleHash)||row.expectedTrustHash!==undefined&&!hash(row.expectedTrustHash))throw new WorkError('teloa/invalid-input','技能锁定来源的校验值格式不正确。')
   const fixed=source(row.source),requestId=planRequestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
   return JSON.stringify({requestId,...await ports.handler('skill-installations/install',{requestId,source:fixed,expectedBundleHash:row.expectedBundleHash,...(row.expectedTrustHash?{expectedTrustHash:row.expectedTrustHash}:{})}) as object})
  },'技能安装')
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{await authorizePlanManagement(ports,exec,'技能安装')}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对技能安装身份。'}}
  const decision=await next()
  if(decision.kind==='deny')return decision
  if(exec.name==='teloa_skills_install'){
   try{
    const row=taskInput(exec.arguments,['source','expectedBundleHash','expectedTrustHash']);if(!hash(row.expectedBundleHash)||row.expectedTrustHash!==undefined&&!hash(row.expectedTrustHash))throw new WorkError('teloa/invalid-input','技能锁定来源的校验值格式不正确。')
    const fixed=source(row.source),value=await safePlanOperation(()=>ports.handler('skill-installations/preview',{source:fixed}),'技能安装'),identity=previewIdentity(value,row.expectedBundleHash,row.expectedTrustHash)
    const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
    const trust=identity.trustHash?`信任信息校验值（trustHash）：${identity.trustHash}；签名：${identity.signature}。`:''
    return {kind:'ask',reason:`${prior}确认在当前 Teloa 安装或复用技能“${identity.name}”？安装包校验值（bundleHash）：${row.expectedBundleHash}。${trust}本操作会发布受管文件，但不会执行技能正文或附件。`}
   }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取技能安装预览，已拒绝安装。'}}
  }
  if(exec.name!=='teloa_skills_uninstall')return decision
  try{
   const row=taskInput(exec.arguments,['installationId','expectedVersion','expectedBundleHash'])
   if(!uuid(row.installationId)||!positive(row.expectedVersion)||!hash(row.expectedBundleHash))throw new WorkError('teloa/invalid-input','技能卸载参数格式不正确。')
   const target=(row.installationId as string).toLowerCase(),identity=uninstallIdentity(await safePlanOperation(()=>ports.handler('skill-installations/get',{installationId:target}),'技能卸载'),{installationId:target,expectedVersion:row.expectedVersion,expectedBundleHash:row.expectedBundleHash})
   const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
   return {kind:'ask',reason:`${prior}确认硬卸载技能“${identity.name}”？不可撤销：会删除本机受管技能目录与安装记录。当前选中的多版本、仍被加载包引用或被历史运行引用时会被拒绝；历史运行证据不会删除，被引用时只可停用。`}
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取技能安装身份，已拒绝卸载。'}}
 })
}
