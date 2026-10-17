import type {AttentionServerRecovery} from './attention-item.js'
import type {PendingRequest} from './pending-request-api.js'

/** 目录不返回原载荷；用操作名称和脱敏摘要区分待核对事项，预览仍按原请求身份读取。 */
export function serverRecoveryItems(rows:readonly PendingRequest[],title:string,operation?:(endpoint:string)=>string):AttentionServerRecovery[]{
 return rows.map(row=>({id:'recovery:server:'+row.requestId,kind:'review',source:'server-recovery',target:{kind:'pending-request',requestId:row.requestId},title:(operation?.(row.endpoint)??title)+(row.summary?' · '+row.summary:''),reason:{kind:'message',key:'attention.recovery.serverRequest'},scope:'general',occurredAt:row.updatedAt}))
}
