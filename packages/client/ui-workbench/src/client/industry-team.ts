import type {GroupDefinition,GroupIndustrySource} from '@teloa/contract'
import type {IndustryLoadRecord} from './industry-load-api.ts'
import type {GroupApi,GroupSnapshot} from './group-api.ts'

export type IndustryTeamSeed=Pick<GroupDefinition,'name'|'scope'|'memberRoleIds'|'coordinatorRoleId'>&{source:GroupIndustrySource}
export type IndustryTeamRole={loadId?:string;itemInstanceId:string;state:string;roleId?:string}
const sameSource=(a:GroupIndustrySource|undefined,b:GroupIndustrySource)=>!!a&&a.kind===b.kind&&a.loadId===b.loadId&&a.contentId===b.contentId&&a.contentHash===b.contentHash&&a.mappingHash===b.mappingHash

/** 继任加载可以沿用一个精确旧实例；当前实例存在但失败或歧义时绝不回退。 */
export function industryTeamRole(load:IndustryLoadRecord,itemInstanceId:string,roles:readonly IndustryTeamRole[]):IndustryTeamRole|undefined{
 const item=load.items.find(item=>item.kind==='role'&&item.instanceId===itemInstanceId)
 if(!item)return undefined
 const current=roles.filter(row=>row.itemInstanceId===item.instanceId)
 const found=current.length?current:item.carriedFrom?roles.filter(row=>row.itemInstanceId===item.carriedFrom):[]
 if(found.length!==1||current.length&&found[0]!.loadId!==undefined&&found[0]!.loadId!==load.id)return undefined
 return found[0]
}

/** 原加载的岗位实例逐项映射为本团队成员；准备岗位不会创建群或恢复员工。 */
export function industryTeamSeed(load:IndustryLoadRecord,roles:readonly IndustryTeamRole[]):IndustryTeamSeed|undefined{
 if(load.status!=='active')return undefined
 const items=load.items.filter(item=>item.kind==='role'&&item.status!=='skipped')
 if(items.length<2)return undefined
 const roleOf=(id:string)=>{const found=industryTeamRole(load,id,roles);return found&&['active','paused'].includes(found.state)?found.roleId:undefined}
 const memberRoleIds=items.map(item=>roleOf(item.instanceId))
 if(memberRoleIds.some(id=>!id)||new Set(memberRoleIds).size!==items.length)return undefined
 const links=load.relations.filter(link=>link.kind==='role-coordination'),leads=[...new Set(links.map(link=>link.from))]
 if(leads.length>1||links.some(link=>!items.some(item=>item.instanceId===link.from)||!items.some(item=>item.instanceId===link.to)))return undefined
 const coordinatorRoleId=leads.length?roleOf(leads[0]!):undefined
 return {name:load.templateTitle,scope:load.space.scope,memberRoleIds:memberRoleIds as string[],source:{kind:'industry-load',loadId:load.id,contentId:load.contentId,contentHash:load.contentHash,mappingHash:load.mappingHash},...(coordinatorRoleId?{coordinatorRoleId}:{})}
}

export function matchingIndustryTeam(snapshot:GroupSnapshot,seed:IndustryTeamSeed):boolean{
 const actual=snapshot.members.flatMap(member=>member.roleId?[member.roleId]:[])
 return !snapshot.group.archived&&sameSource(snapshot.group.source,seed.source)&&snapshot.group.scope===seed.scope&&snapshot.group.coordinatorRoleId===seed.coordinatorRoleId&&actual.length===seed.memberRoleIds.length&&seed.memberRoleIds.every(id=>actual.includes(id))
}
/** 跨刷新从现有群目录核对原来源，绝不以姓名或其他同模板版本的群作回执。 */
export async function findIndustryTeam(api:Pick<GroupApi,'list'|'get'>,seed:IndustryTeamSeed):Promise<GroupSnapshot|undefined>{
 const candidates=(await api.list()).items.filter(group=>sameSource(group.source,seed.source))
 if(!candidates.length)return undefined
 if(candidates.length!==1)throw Error('The saved team source is ambiguous.')
 const snapshot=await api.get(candidates[0]!.id)
 if(!matchingIndustryTeam(snapshot,seed))throw Error('The saved team has changed. Review its members and coordinator.')
 return snapshot
}
