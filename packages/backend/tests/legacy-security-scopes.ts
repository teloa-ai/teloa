import type {Pool} from 'pg'
import {BusinessScopeService} from '../src/index.ts'

/**
 * 这些用例以「已有安全运营 / 应用安全业务的存量库」为前提。新装不再预登记 SOC/AppSec，
 * 这里在引导本人空间后显式补上既有标签行（与存量库一致），用例本身的业务语义不变。
 */
export async function withLegacySecurityScopes<T extends {id:string}>(pool:Pool,ownerId:string,space:Promise<T>|T):Promise<T>{
 const personal=await space
 for(const [scope,title] of [['SOC','安全运营'],['AppSec','应用安全']] as const)await BusinessScopeService.ensure(pool,ownerId,{scope,title,kind:'builtin',spaceId:personal.id})
 return personal
}
