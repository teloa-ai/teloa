import type {IndustryLoadApi,IndustryLoadRecord} from './industry-load-api.js'
import type {SkillInstallApi,SkillInstallObservation,SkillInstallationRecord} from './skill-install-api.js'
import {selectSkillInstallation,skillInstallationMatchesPreview} from './skill-install-state.js'
import type {IndustryRoleApi} from './industry-role-api.js'

export type CapabilitySkillStatus='loading'|'unverified'|'not-installed'|'preparing'|'installed'|'unlinked'|'installed-unverified'|'disabled'|'missing'|'shadowed'|'mismatch'
export type CapabilitySkillFact={loadId:string;itemInstanceId:string;status:CapabilitySkillStatus;installationId?:string;linked?:boolean;nativeName?:string;nativeSource?:string;nativeProvider?:string}
export type CapabilitySkillRuntime={loadsKey:string;state:'loading'|'ready'|'error';facts:CapabilitySkillFact[]}
export const capabilitySkillLoadsKey=(loads:readonly IndustryLoadRecord[])=>JSON.stringify(loads.filter(load=>load.status==='active').map(load=>[load.id,load.contentId,load.contentHash,load.mappingHash,load.items.filter(item=>item.kind==='skill'&&item.status!=='skipped').map(item=>[item.instanceId,item.version])]))
const nativeMatches=(record:SkillInstallationRecord,observation:SkillInstallObservation)=>observation.installationId===record.id&&observation.current!==null&&(['name','description','bodyHash','modelInvocable','userInvocable'] as const).every(key=>record.native[key]===observation.current![key])

/** 只读安装/使用关系/固定预览/默认工作区观测；不安装、不把加载项状态回写成运行状态。 */
export async function loadCapabilitySkillRuntime(api:Pick<SkillInstallApi,'list'|'preview'|'observe'>,loads:readonly IndustryLoadRecord[]):Promise<CapabilitySkillRuntime>{
 const loadsKey=capabilitySkillLoadsKey(loads)
 let directory:Awaited<ReturnType<SkillInstallApi['list']>>
 try{directory=await api.list()}catch{return {loadsKey,state:'error',facts:[]}}
 const observations=new Map<string,Promise<SkillInstallObservation>>()
 const facts=await Promise.all(loads.filter(load=>load.status==='active').flatMap(load=>load.items.filter(item=>item.kind==='skill'&&item.status!=='skipped').map(async (item):Promise<CapabilitySkillFact>=>{
  const base={loadId:load.id,itemInstanceId:item.instanceId}
  try{
   const source={kind:'industry' as const,...base},preview=await api.preview(source)
   if(preview.source.kind==='atomic'||preview.source.loadId!==load.id||preview.source.itemInstanceId!==item.instanceId||preview.source.contentId!==load.contentId||preview.source.contentHash!==load.contentHash||preview.source.resourceId!==item.localId||preview.source.resourceVersion!==item.version)return {...base,status:'mismatch'}
   const usage=directory.usages.find(row=>row.loadId===load.id&&row.itemInstanceId===item.instanceId)
   const candidates=usage?directory.items:directory.items.filter(record=>skillInstallationMatchesPreview(record,preview))
   const {record,linked}=selectSkillInstallation(source,preview,candidates,directory.usages)
   if(!record)return {...base,status:usage?'mismatch':'not-installed'}
   if(record.ownerId!==load.ownerId||!skillInstallationMatchesPreview(record,preview))return {...base,status:'mismatch'}
   const fixed={...base,installationId:record.id,linked}
   if(record.state==='preparing')return {...fixed,status:'preparing'}
   try{
    let request=observations.get(record.id);if(!request){request=api.observe(record.id);observations.set(record.id,request)}
    const observation=await request
    if(observation.installationId!==record.id)return {...fixed,status:'installed-unverified'}
    if(observation.state==='disabled'||observation.state==='missing'||observation.state==='shadowed')return {...fixed,status:observation.state}
    if(observation.state!=='available'||!nativeMatches(record,observation))return {...fixed,status:'installed-unverified'}
    if(!linked)return {...fixed,status:'unlinked'}
    return {...fixed,status:'installed',nativeName:record.native.name,nativeSource:observation.current!.source,nativeProvider:observation.current!.provider}
   }catch{return {...fixed,status:'installed-unverified'}}
  }catch{return {...base,status:'unverified'}}
 })))
 return {loadsKey,state:'ready',facts}
}

export type SkillDisplayTitle={name:string;source:string;provider:string;title:string}
type SkillTitleRole={id:string;version:number;skills:readonly string[]}
export type RoleSkillTitleReader={read:(role:SkillTitleRole)=>Promise<readonly SkillDisplayTitle[]>}

/** 展示名不参与技能选择和授权；只有唯一的固定关系及当前原生身份才可取代原名。 */
export function skillDisplayTitle(titles:readonly SkillDisplayTitle[],skill:{name:string;source?:string;provider?:string}):string{
 const matches=titles.filter(row=>row.name===skill.name&&(skill.source===undefined&&skill.provider===undefined||row.source===skill.source&&row.provider===skill.provider))
 return matches.length===1?matches[0]!.title:skill.name
}

/** 只合并同员工正在进行的读取；重开时重新核实，详情与编辑共用已读展示。 */
export function createRoleSkillTitleReader(api:Pick<SkillInstallApi,'list'|'preview'|'observe'>,loadsApi:Pick<IndustryLoadApi,'list'>,rolesApi:Pick<IndustryRoleApi,'list'>):RoleSkillTitleReader{
 const reads=new Map<string,Promise<readonly SkillDisplayTitle[]>>()
 return {read(role){
  const key=JSON.stringify([role.id,role.version,role.skills])
  let pending=reads.get(key)
  if(!pending){pending=(async()=>{
   // 每次打开或员工版本变化都按原连接读取固定目录，不依赖当前页面是否曾预热。
   let loads:IndustryLoadRecord[],instances:Awaited<ReturnType<IndustryRoleApi['list']>>
   try{[loads,instances]=await Promise.all([loadsApi.list(),rolesApi.list()])}catch{return []}
   const matches=instances.filter(row=>row.role?.id===role.id)
   if(matches.length!==1)return []
   const instance=matches[0]!,original=instance.role!
   if(original.version!==role.version||original.ownerId!==instance.ownerId)return []
   const fixed=loads.filter(row=>row.id===instance.loadId)
   if(fixed.length!==1)return []
   const load=fixed[0]!
   if(load.status!=='active'||load.ownerId!==instance.ownerId)return []
   const roleItems=load.items.filter(item=>item.kind==='role'&&item.instanceId===instance.itemInstanceId&&item.localId===instance.itemLocalId&&['active','instantiated'].includes(item.status))
   if(roleItems.length!==1)return []
   const related=load.relations.filter(row=>row.kind==='role-skill'&&row.from===instance.itemInstanceId)
   const items=load.items.filter(item=>item.kind==='skill'&&item.status!=='skipped'&&item.status!=='detached'&&related.filter(row=>row.to===item.instanceId).length===1)
   if(!items.length)return []
   const scoped={...load,items},runtime=await loadCapabilitySkillRuntime(api,[scoped])
   if(runtime.state!=='ready'||runtime.loadsKey!==capabilitySkillLoadsKey([scoped]))return []
   const titles=items.flatMap(item=>{
    const facts=runtime.facts.filter(row=>row.loadId===load.id&&row.itemInstanceId===item.instanceId)
    if(facts.length!==1)return []
    const fact=facts[0]!
    return fact.status==='installed'&&fact.linked&&fact.nativeName&&fact.nativeSource&&fact.nativeProvider&&role.skills.includes(fact.nativeName)&&item.title.trim()?[{name:fact.nativeName,source:fact.nativeSource,provider:fact.nativeProvider,title:item.title}]:[]
   })
   return titles.filter(row=>titles.filter(other=>other.name===row.name&&other.source===row.source&&other.provider===row.provider).length===1)
  })();reads.set(key,pending)
   const request=pending,release=()=>{if(reads.get(key)===request)reads.delete(key)}
   void pending.then(release,release)
  }
  return pending
 }}
}
