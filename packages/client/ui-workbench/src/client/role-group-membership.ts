import type {GroupApi} from './group-api.ts'

/** 成员关系来自已保存群；不能用演示目录的空数组推断「未加入群」。 */
export async function readRoleGroups(api:Pick<GroupApi,'list'|'get'>,roleId:string){
 const {items}=await api.list(),result:{id:string;name:string}[]=[]
 // 限制并发，避免群目录较大时同时发起全部请求。
 for(let start=0;start<items.length;start+=4){
  const rows=await Promise.all(items.slice(start,start+4).map(group=>api.get(group.id)))
  for(const {group,members} of rows)if(members.some(member=>member.roleId===roleId))result.push({id:group.id,name:group.name})
 }
 return result
}
