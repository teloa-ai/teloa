import type {RoleService} from '../packages/backend/src/work/roles.ts'

export const seedRoleNames:Record<string,{name:string;legacyName:string}>
export function ensureNamedSeedRole(input:{
 pool:RoleService['pool'];service:RoleService;ownerId:string;requestId:string;key:string;fields:Record<string,unknown>
}):ReturnType<RoleService['create']>
export function preserveSeedObjectNames<T extends {
 scope:string;type:string;id:string;version:number;fields:Array<{label:string;value:string}>
}>(pool:RoleService['pool'],ownerId:string,items:T[]):Promise<T[]>
