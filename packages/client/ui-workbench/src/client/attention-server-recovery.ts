import type {AttentionServerRecovery} from './attention-item.js'
import type {PendingRequest} from './pending-request-api.js'

/** 服务端目录不返回原载荷；界面只把“有一项请求待核对”投影为需要你事项。 */
export function serverRecoveryItems(rows:readonly PendingRequest[],title:string):AttentionServerRecovery[]{
 return rows.map(row=>({id:'recovery:server:'+row.requestId,kind:'review',source:'server-recovery',target:{kind:'pending-request',requestId:row.requestId},title,reason:{kind:'message',key:'attention.recovery.serverRequest'},scope:'general',occurredAt:row.updatedAt}))
}
