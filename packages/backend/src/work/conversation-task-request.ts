import type {PoolClient} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'
import {readStoredConversationWorkRequest} from './conversation-work.ts'
import {lockConversationTaskParent,workRequestChildId,type ConversationTaskIdentity} from './conversation-work-task-protection.ts'
export type {ConversationTaskIdentity} from './conversation-work-task-protection.ts'

/** 仅宿主内部调用；公共 Task 输入不接收此身份，也不能用相同 fields 代替父归属。 */
export async function conversationTaskRequest(db:PoolClient,owner:string,value:unknown){
 const row=taskInput(value,['sessionId','requestId','roleId'])
 const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
 if(typeof owner!=='string'||!owner.trim()||owner.length>128||typeof row.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.sessionId)||!uuid(row.requestId)||!uuid(row.roleId))throw new WorkError('teloa/invalid-input','原交办任务身份不正确。')
 const identity:ConversationTaskIdentity={sessionId:row.sessionId,requestId:row.requestId.toLowerCase(),roleId:row.roleId.toLowerCase()},requestId=workRequestChildId(identity.requestId,'task',identity.roleId)
 const parent=await lockConversationTaskParent(db,owner,requestId,identity)
 if(!parent)throw new WorkError('teloa/conflict','原交办任务身份不存在。')
 const request=readStoredConversationWorkRequest(parent.row),target=request.targets[0]
 if(request.kind!=='task'||!target||request.targets.length!==1||target.roleId!==identity.roleId)throw new WorkError('teloa/forbidden','原交办的固定员工不一致。')
 // 与既有 dispatch 原字节兼容；原指令及其引用完整保留，不从当前会话或调用方重建。
 const goal=request.goal+(request.sourceText?'\n\n本人原指令（保留原始引用，不改变员工权限）：\n'+request.sourceText:'')
 const assignee={roleId:target.roleId,expectedVersion:target.roleVersion}
 return {identity,parent,request,task:{requestId,fields:{title:request.title,goal,scope:target.scope},assignee},business:request.reference?{requestId,reference:request.reference,title:request.title,goal,assignee}:null}
}
