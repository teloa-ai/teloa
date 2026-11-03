import type {PreviewRole} from './role-preview.js'

/** 完整名单决定当前成员；单个保存回执只更新对应成员。历史任务与运行不属于此目录。 */
export function reconcileRoleDirectory(current:readonly PreviewRole[],rows:readonly PreviewRole[],kind:'snapshot'|'receipt'):PreviewRole[]{
 const members=new Set(rows.map(row=>row.id))
 const roles=kind==='snapshot'?current.filter(row=>row.storage!=='persistent'||members.has(row.id)):[...current]
 for(const row of rows){
  const index=roles.findIndex(previous=>previous.id===row.id),previous=index<0?undefined:roles[index]
  if(previous&&(previous.version>row.version||previous.version===row.version&&previous.updatedAt&&row.updatedAt&&Date.parse(previous.updatedAt)>Date.parse(row.updatedAt)))continue
  if(index<0)roles.push(row)
  else roles[index]=row
 }
 return roles
}
