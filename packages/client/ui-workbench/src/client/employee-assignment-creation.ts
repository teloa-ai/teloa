import {roleSupportsScope,type DigitalRole} from '@teloa/contract'
import type {CollaborationScope} from './collaboration-preview.js'
import type {ConversationObject} from './object-conversations.js'

type AssignmentRole=Pick<DigitalRole,'id'|'name'|'kind'|'state'|'version'|'scopes'>
const denied=(code:string)=>Object.assign(Error(),{code})

/** 新交办只消费刚读回的在岗员工；聊天历史、分身同意及未决任务都不在此转换。 */
export function employeeAssignmentCreation(roles:readonly AssignmentRole[],roleId:string,expectedVersion:number,scope?:CollaborationScope){
 const role=roles.find(row=>row.id===roleId)
 if(!role)throw denied('teloa/source-unavailable')
 if(role.version!==expectedVersion)throw denied('teloa/version-conflict')
 if(role.kind!=='employee'||role.state!=='active')throw denied('teloa/forbidden')
 if(scope!==undefined&&!roleSupportsScope(role.scopes,scope))throw denied('teloa/forbidden')
 const scopes=scope===undefined?[...new Set(role.scopes.filter(Boolean))]:[scope]
 if(!scopes.length)throw denied('teloa/forbidden')
 const object:ConversationObject={kind:'role',id:role.id,title:role.name,version:role.version,canStart:true}
 return {object,scopes,taskCreation:true as const}
}
