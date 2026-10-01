import type {TeloaTranslate} from './i18n/index.js'

type RoleIdentity={id:string;storage?:'persistent'}

const accessKeys=[
  ['collaboration.access.members.title','collaboration.access.members.description'],
  ['collaboration.access.resources.title','collaboration.access.resources.description'],
  ['collaboration.access.capabilities.title','collaboration.access.capabilities.description'],
  ['collaboration.access.permissions.title','collaboration.access.permissions.description'],
] as const

export const groupAccessModel=(t:TeloaTranslate)=>accessKeys.map(([title,description])=>({title:t(title),description:t(description)}))

function savedMemberCount(memberIds:readonly string[],roles:readonly RoleIdentity[]):number{
  const members=new Set(memberIds)
  return roles.filter(role=>role.storage==='persistent'&&members.has(role.id)).length
}

/** 群关系仍是页面态；已保存岗位只作为可见身份投影。 */
export function groupMemberSummary(t:TeloaTranslate,memberIds:readonly string[],roles:readonly RoleIdentity[]):string{
  const saved=savedMemberCount(memberIds,roles)
  const key=saved===0?'presentation.collaboration.members':saved===1?'presentation.collaboration.membersWithOneSaved':'presentation.collaboration.membersWithSaved'
  return t(key,saved?{count:memberIds.length,saved}:{count:memberIds.length})
}
