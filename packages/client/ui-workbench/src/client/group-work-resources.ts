import type {MessageReference,WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
export type GroupWorkResourcePort={api:Pick<ResourceApi,'directory'>;identity?:unknown;open:(reference:MessageReference&{kind:'work-resource'})=>void}
/** 与服务端同一范围：跨业务群 general 不隐式获得其它业务资料；引用与员工授权分别由本人提交。 */
export function groupWorkResourceCandidates(rows:readonly WorkResource[],scope:string):WorkResource[]{
 return rows.filter(row=>row.status==='active'&&row.scopeIds.every(value=>value===scope))
}
