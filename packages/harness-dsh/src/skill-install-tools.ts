import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput} from '@teloa/contract'
import {authorizePlanManagement,planRequestIdentity,safePlanOperation,type PlanToolsPorts} from './plan-tools.ts'

export const skillInstallToolNames=['teloa_skills_directory','teloa_skills_preview','teloa_skills_install','teloa_skills_observe'] as const
export type SkillInstallToolsPorts=Pick<PlanToolsPorts,'owner'|'conversation'|'readTaskPolicy'>&{
 directory:()=>Promise<unknown>
 handler:(method:string,payload:unknown)=>Promise<unknown>
}

const names=new Set<string>(skillInstallToolNames)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
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
  {name:'teloa_skills_directory' as const,description:'列出本人已保存的原子技能、已加载行业技能、真实安装记录和行业使用关系。先从目录取得锁定来源的身份；目录出现不表示已经授权安装。',parameters:{}},
  {name:'teloa_skills_preview' as const,description:'预览目录中锁定版本的技能来源，返回完整文件清单、安装包校验值（bundleHash）、信任信息校验值（trustHash）、原生名称、扩展与连接需求和权限。安装前必须使用本次返回的校验值。',parameters:{source:sourceSchema}},
  {name:'teloa_skills_install' as const,description:'安装、复用或继续核对一个锁定版本的技能来源。需要预览返回的 bundleHash 和 trustHash，并由本人确认在当前 Teloa 上的安装行为；不执行技能正文或附件。',parameters:{source:sourceSchema,expectedBundleHash:{type:'string',required:true},expectedTrustHash:{type:'string'}}},
  {name:'teloa_skills_observe' as const,description:'观测一项真实安装在默认工作区是否可用、被同名来源遮蔽或缺失。结果只代表默认工作区。',parameters:{installationId:{type:'string',required:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const sessionId=await authorizePlanManagement(ports,exec,'技能安装')
  return safePlanOperation(async()=>{
   if(definition.name==='teloa_skills_directory'){taskInput(args,[]);return JSON.stringify(await ports.directory())}
   if(definition.name==='teloa_skills_preview'){const row=taskInput(args,['source']);return JSON.stringify(await ports.handler('skill-installations/preview',{source:source(row.source)}))}
   if(definition.name==='teloa_skills_observe'){const row=taskInput(args,['installationId']);return JSON.stringify(await ports.handler('skill-installations/observe',{installationId:row.installationId}))}
   const row=taskInput(args,['source','expectedBundleHash','expectedTrustHash']);if(!hash(row.expectedBundleHash)||row.expectedTrustHash!==undefined&&!hash(row.expectedTrustHash))throw new WorkError('teloa/invalid-input','技能锁定来源的校验值格式不正确。')
   const fixed=source(row.source),requestId=planRequestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
   return JSON.stringify({requestId,...await ports.handler('skill-installations/install',{requestId,source:fixed,expectedBundleHash:row.expectedBundleHash,...(row.expectedTrustHash?{expectedTrustHash:row.expectedTrustHash}:{})}) as object})
  },'技能安装')
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{await authorizePlanManagement(ports,exec,'技能安装')}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对技能安装身份。'}}
  const decision=await next()
  if(decision.kind==='deny'||exec.name!=='teloa_skills_install')return decision
  try{
   const row=taskInput(exec.arguments,['source','expectedBundleHash','expectedTrustHash']);if(!hash(row.expectedBundleHash)||row.expectedTrustHash!==undefined&&!hash(row.expectedTrustHash))throw new WorkError('teloa/invalid-input','技能锁定来源的校验值格式不正确。')
   const fixed=source(row.source),value=await safePlanOperation(()=>ports.handler('skill-installations/preview',{source:fixed}),'技能安装'),identity=previewIdentity(value,row.expectedBundleHash,row.expectedTrustHash)
   const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
   const trust=identity.trustHash?`信任信息校验值（trustHash）：${identity.trustHash}；签名：${identity.signature}。`:''
   return {kind:'ask',reason:`${prior}确认在当前 Teloa 安装或复用技能“${identity.name}”？安装包校验值（bundleHash）：${row.expectedBundleHash}。${trust}本操作会发布受管文件，但不会执行技能正文或附件。`}
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取技能安装预览，已拒绝安装。'}}
 })
}
