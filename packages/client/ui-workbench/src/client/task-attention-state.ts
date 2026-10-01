import type {WorkTask} from '@teloa/contract'
import type {TaskAttentionItem} from './task-api.ts'

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
 return attentionKnown&&handoffsKnown&&attention.some(item=>item.task.id===task.id&&item.task.version===task.version&&item.attention===null)&&!handoffs.some(item=>item.taskId===task.id&&item.status==='pending')
}
