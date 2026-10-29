import {WorkError,type DigitalRole} from '@teloa/contract'
import type {ResourceActor} from '@teloa/backend'

/** 员工普通单聊的检索授权：只来自服务端可信会话关联的岗位，不接受模型参数或会话绑定里的 general 占位范围。 */
export type RoleRetrievalAuthorization={actor:ResourceActor;targetScopes:string[];knowledgeIds:readonly string[]}
export type RoleRetrievalPorts={
 owner:string
 requestedRoleId:(sessionId:string)=>Promise<string|null>
 role:(roleId:string)=>Promise<DigitalRole|null>
 /** 当前员工原引用到独立内容 head 的可信服务端解析；不接受工具参数。 */
 resolveKnowledge?:(role:DigitalRole)=>Promise<readonly string[]>
}

export async function roleRetrievalAuthorization(sessionId:string,ports:RoleRetrievalPorts):Promise<RoleRetrievalAuthorization|null>{
 const roleId=await ports.requestedRoleId(sessionId)
 if(roleId===null)return null
 const role=await ports.role(roleId)
 if(!role||role.id!==roleId||role.ownerId!==ports.owner)throw new WorkError('teloa/forbidden','员工身份已失效，请重新打开员工会话。')
 const scopes=[...new Set(role.scopes)]
 if(!scopes.length||scopes.some(scope=>typeof scope!=='string'||!scope))throw new WorkError('teloa/forbidden','员工的业务范围已撤回，不能检索资料。')
 // 员工的资料清单是检索的硬上限；空清单表示没有可检索资料，不能回落到全部资料。
 const references=ports.resolveKnowledge?await ports.resolveKnowledge(role):role.knowledge
 const knowledgeIds=[...new Set(references.filter(id=>typeof id==='string'&&id.length>0))]
 return {actor:{ownerId:ports.owner,kind:'agent',scopeIds:scopes},targetScopes:scopes,knowledgeIds}
}
