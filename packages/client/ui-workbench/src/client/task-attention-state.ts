import type {WorkTask} from '@teloa/contract'
import type {TaskAttentionItem,TaskNativeApproval} from './task-api.ts'
import type {ConversationOpenResult} from './binding-client.ts'

type Versioned={id:string;version:number}
type HandoffState={taskId:string;status:string}

export function mergeTaskAttention(current:TaskAttentionItem[],incoming:WorkTask[],tasks:Versioned[]):TaskAttentionItem[]{
 const accepted=incoming.filter(row=>{const existing=tasks.find(task=>task.id===row.id);return !existing||existing.version<=row.version})
 const changed=new Set(accepted.map(row=>row.id)),next=current.filter(item=>!changed.has(item.task.id))
 for(const task of accepted){
  if(task.state==='blocked')next.push({task,attention:{kind:'error',reason:'task-blocked'}})
  else if(task.state==='waiting')next.push({task,attention:{kind:'review',reason:'task-waiting'}})
 }
 return next
}

export function isVerifiedNoAttention(task:Versioned,attentionKnown:boolean,attention:TaskAttentionItem[],handoffsKnown:boolean,handoffs:HandoffState[]):boolean{
 return attentionKnown&&handoffsKnown&&attention.some(item=>item.task.id===task.id&&item.task.version===task.version&&item.attention===null&&!item.nativeApproval&&!item.nativeApprovalUnknown)&&!handoffs.some(item=>item.taskId===task.id&&item.status==='pending')
}

/** 打开前重读原任务快照，失效或换轮的入口不能跳到另一次执行。 */
export async function openTaskNativeApproval(target:TaskNativeApproval&{taskId:string},read:()=>Promise<{items:TaskAttentionItem[]}>,open:(sessionId:string,mayOpen:()=>boolean)=>Promise<ConversationOpenResult>,current:()=>boolean):Promise<boolean>{
 const snapshot=await read()
 if(!current())return false
 const row=snapshot.items.find(item=>item.task.id===target.taskId)
 if(row?.task.state!=='running'||row.nativeApproval?.runId!==target.runId||row.nativeApproval.sessionId!==target.sessionId)return false
 const result=await open(target.sessionId,current)
 return result==='opened'&&current()
}
