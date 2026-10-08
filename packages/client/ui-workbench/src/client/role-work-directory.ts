import type {DigitalRole} from '@teloa/contract'
import type {RoleApi} from './role-api.js'
import type {RoleDelegationApi,RoleDelegationRead} from './role-delegation-api.js'

export type WorkAccessRole=DigitalRole&{workAccess?:RoleDelegationRead|undefined}
/** 业务入口沿用岗位目录，分身资格只来自当前委托服务；未知结果保持不可接工作。 */
export function createRoleWorkDirectory(roles:Pick<RoleApi,'list'>,delegations:Pick<RoleDelegationApi,'get'>){
 return {async list():Promise<WorkAccessRole[]>{
  const directory=await roles.list()
  return Promise.all(directory.map(async(role):Promise<WorkAccessRole>=>{
   if(role.kind!=='twin')return role
   try{const read=await delegations.get(role.id);return {...role,workAccess:read.roleId===role.id&&read.roleVersion===role.version?read:undefined}}
   catch{return {...role,workAccess:undefined}}
  }))
 }}
}
export type RoleWorkDirectory=ReturnType<typeof createRoleWorkDirectory>
