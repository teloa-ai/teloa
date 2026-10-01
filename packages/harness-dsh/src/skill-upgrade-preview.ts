import type {SkillUpgradePreviewService} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'
export const skillUpgradePreviewEndpoints=['skill-upgrades/preview'] as const
type Ports=Pick<SkillUpgradePreviewService,'preview'>
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','技能升级预览请求格式不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','技能升级预览返回身份不一致。')
export function createSkillUpgradePreviewHandler(owner:string,get:()=>Promise<Ports>){return async(method:string,payload:unknown)=>{
 if(method!=='skill-upgrades/preview')throw new WorkError('teloa/not-found','未提供此技能升级接口。')
 const row=taskInput(payload,['installationId','target'])
 if(!uuid(row.installationId))throw invalid()
 const input=taskInput(row.target,['kind','contentId','loadId','itemInstanceId'])
 let target:{kind:'atomic';contentId:string}|{kind:'industry';loadId:string;itemInstanceId:string}
 if(input.kind==='atomic'){
  taskInput(input,['kind','contentId']);if(!uuid(input.contentId))throw invalid();target={kind:'atomic',contentId:input.contentId.toLowerCase()}
 }else{
  taskInput(input,['kind','loadId','itemInstanceId']);if(input.kind!=='industry'||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw invalid();target={kind:'industry',loadId:input.loadId.toLowerCase(),itemInstanceId:input.itemInstanceId.toLowerCase()}
 }
 const installationId=row.installationId.toLowerCase(),result=await(await get()).preview(owner,{installationId,target}),current=result.current,source=result.target.source
 if(current.installation.id!==installationId||current.installation.ownerId!==owner||current.availability.installationId!==installationId||current.availability.ownerId!==owner||current.impact.installation.id!==installationId||current.impact.installation.version!==current.installation.version||current.impact.installation.bundleHash!==current.installation.bundleHash||current.impact.installation.nativeName!==current.installation.native.name||current.impact.availability.version!==current.availability.version||current.impact.availability.value!==current.availability.availability||!hash(current.impactDigest)||!hash(result.target.bundleHash))throw bad()
 if(target.kind==='atomic'?(source.kind!=='atomic'||source.contentId!==target.contentId):(source.kind==='atomic'||source.loadId!==target.loadId||source.itemInstanceId!==target.itemInstanceId))throw bad()
 return result
}}
