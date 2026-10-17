import {WorkError,type TaskDraftCreateInput,type WorkTask} from '@teloa/contract'
import type {ObjectConversationService} from '@teloa/backend'

type Ports={owner:string;create:(input:TaskDraftCreateInput,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<WorkTask>;list:()=>Promise<WorkTask[]>;conversation:(id:string)=>Promise<{id:string;ownerId:string;sessionId:string;status:string}>;links:Pick<ObjectConversationService,'list'|'change'>}
/** 草稿与其不可变创建回执先保存；来源索引单独核对。重放不会升级原聊天或撤销后来解除的关联。 */
export async function createPlatformTaskDraft(ports:Ports,input:TaskDraftCreateInput,signal:AbortSignal,revalidate:()=>Promise<void>):Promise<WorkTask>{
 signal.throwIfAborted();await revalidate()
 const task=await ports.create(input,signal,revalidate)
 if(task.ownerId!==ports.owner||task.version!==1||task.scope!==input.fields.scope)throw new WorkError('teloa/invalid-host-response','任务创建回执与本人或原请求不一致。')
 const conversation=await ports.conversation(input.sessionId)
 if(conversation.ownerId!==ports.owner||conversation.sessionId!==input.sessionId||conversation.status!=='ready')throw new WorkError('teloa/forbidden','原任务已保存，创建来源尚未完成核对。')
 const sources=await ports.links.list(ports.owner,{kind:'task',objectId:task.id}),source=sources.find(row=>row.sessionId===input.sessionId)
 if(source){
  if(source.kind!=='task'||source.objectId!==task.id||source.conversationId!==conversation.id||source.sourceOnly!==true)throw new WorkError('teloa/conflict','原聊天已有不同工作关联，不会改变它的执行上下文。')
 }else{
  const current=(await ports.list()).find(row=>row.id===task.id)
  if(!current||current.ownerId!==ports.owner||current.scope!==task.scope)throw new WorkError('teloa/invalid-host-response','原任务已保存，当前任务身份尚未完成核对。')
  await ports.links.change(ports.owner,{requestId:input.requestId,kind:'task',objectId:task.id,expectedObjectVersion:current.version,sessionId:input.sessionId,expectedLinkVersion:0,action:'link',sourceOnly:true},signal,revalidate)
 }
 await revalidate();signal.throwIfAborted();return task
}
