import {WorkError,roleInput} from '@teloa/contract'
export const roleEndpoints=['roles/list','roles/create','roles/edit']
type RoleOperations={list:(owner:string,input:unknown)=>Promise<unknown>;create:(owner:string,input:unknown)=>Promise<unknown>;edit:(owner:string,input:unknown)=>Promise<unknown>}
/** 仅认证后的工作台 RPC 使用；不注册为 Agent 工具。 */
/** `checkKnowledge`：保存前按资料体积预检（超过整段进提示词上限的资料只能加入本地检索），拒绝时不写岗位。 */
export function createRoleHandler(owner:string,get:()=>Promise<RoleOperations>,checkKnowledge?:(ids:string[])=>Promise<void>){
 return async(endpoint:string,payload:unknown)=>{
  if(!roleEndpoints.includes(endpoint))throw new WorkError('teloa/not-found','未提供此员工接口。')
  const row=roleInput(payload,endpoint==='roles/list'?[]:endpoint==='roles/create'?['requestId','fields']:['roleId','expectedVersion','fields'])
  if(endpoint==='roles/create'&&row.fields&&typeof row.fields==='object'&&!Array.isArray(row.fields)&&(row.fields as {kind?:unknown}).kind==='twin')throw new WorkError('teloa/conflict','分身随个人空间默认提供，无需创建。')
  const knowledge=endpoint!=='roles/list'&&row.fields&&typeof row.fields==='object'&&!Array.isArray(row.fields)?(row.fields as {knowledge?:unknown}).knowledge:undefined
  if(checkKnowledge&&Array.isArray(knowledge)&&knowledge.length&&knowledge.every(id=>typeof id==='string'))await checkKnowledge(knowledge as string[])
  const service=await get()
  return endpoint==='roles/list'?service.list(owner,payload):endpoint==='roles/create'?service.create(owner,payload):service.edit(owner,payload)
 }
}
