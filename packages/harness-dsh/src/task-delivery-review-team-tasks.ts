import {isDeepStrictEqual} from 'node:util'
import {isRecord} from '@teloa/contract'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {TeamTaskSnapshot} from '@deepseek-ai/dsh-experimental-agent-team/types'

type TaskEvent=Extract<SessionEvent,{type:'team/task'}>
type Receipt=Readonly<{name:string;callSeq:number;resultSeq:number;arguments:string;isError:boolean;text:string}>
const exact=(value:unknown,required:readonly string[],optional:readonly string[]=[])=>isRecord(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key))
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string')
const taskFields=['id','revision','subject','description','status','blockedBy','writeScopes'] as const
function readTask(value:unknown):TeamTaskSnapshot|undefined{
 if(!exact(value,taskFields,['ownerId'])||!isRecord(value)||typeof value.id!=='string'||!/^task-[1-9]\d*$/.test(value.id)||!Number.isSafeInteger(Number(value.id.slice(5)))||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||typeof value.subject!=='string'||typeof value.description!=='string'||!['pending','in_progress','completed','deleted'].includes(String(value.status))||typeof value.status!=='string'||!strings(value.blockedBy)||!strings(value.writeScopes)||value.ownerId!==undefined&&(typeof value.ownerId!=='string'||!value.ownerId))return undefined
 return value as unknown as TeamTaskSnapshot
}

/** 官方 v2 TeamTaskSnapshot 只是一份任务簿快照，不证明有子 Agent 执行。
 * 这里核对原 call/result 与归属，不持有或回写第二份 Team 状态；其他 Team 事件仍由收集器拒绝。
 */
export function proveRunTaskBook(events:readonly TaskEvent[],receipts:readonly Receipt[],sessionId:string):boolean{
 const mutations=receipts.filter(row=>!row.isError&&(row.name==='team_task_create'||row.name==='team_task_update'))
 if(events.length!==mutations.length)return false
 const proven=new Map<string,TeamTaskSnapshot>(),used=new Set<Receipt>()
 for(const event of events){
  if(!exact(event.data,['version','teamId','task'])||event.data.version!==2||event.data.teamId!==sessionId)return false
  const task=readTask(event.data.task)
  if(!task||task.ownerId!==undefined&&task.ownerId!==sessionId)return false
  const matches=mutations.filter(row=>row.callSeq<event.seq&&event.seq<row.resultSeq),receipt=matches[0]
  if(matches.length!==1||!receipt||used.has(receipt))return false
  let args:unknown,view:unknown
  try{args=JSON.parse(receipt.arguments);view=JSON.parse(receipt.text)}catch{return false}
  if(!isRecord(args)||!isRecord(view)||!exact(view,[...taskFields,'ready','writeScopeWarnings'],['ownerName'])||typeof view.ready!=='boolean'||!strings(view.writeScopeWarnings)||view.ownerName!==undefined&&(typeof view.ownerName!=='string'||!view.ownerName)||task.ownerId===undefined&&view.ownerName!==undefined||task.ownerId!==undefined&&view.ownerName===undefined||taskFields.some(key=>!isDeepStrictEqual(task[key],view[key])))return false
  if(task.blockedBy.some(id=>!proven.has(id)||id===task.id)||new Set(task.blockedBy).size!==task.blockedBy.length)return false
  if(receipt.name==='team_task_create'){
   if(!exact(args,['subject','description'],['blocked_by','write_scopes'])||typeof args.subject!=='string'||typeof args.description!=='string'||args.blocked_by!==undefined&&!strings(args.blocked_by)||args.write_scopes!==undefined&&!strings(args.write_scopes)||proven.has(task.id)||task.revision!==1||task.status!=='pending'||task.ownerId!==undefined||task.subject!==args.subject.trim()||task.description!==args.description.trim()||!isDeepStrictEqual(task.blockedBy,args.blocked_by??[]))return false
  }else{
   if(!exact(args,['task_id','expected_revision','action'],['subject','description','write_scopes','blocked_by','owner']))return false
   const previous=proven.get(task.id)
   if(!previous||previous.status==='deleted'||args.task_id!==task.id||args.expected_revision!==previous.revision||task.revision!==previous.revision+1||typeof args.action!=='string')return false
   const expected:{-readonly [K in keyof TeamTaskSnapshot]:TeamTaskSnapshot[K]}={...previous,revision:task.revision}
   switch(args.action){
    case 'claim':if(previous.status!=='pending')return false;expected.status='in_progress';expected.ownerId=sessionId as never;break
    case 'release':if(previous.status!=='in_progress')return false;expected.status='pending';delete expected.ownerId;break
    case 'complete':if(previous.status!=='in_progress')return false;expected.status='completed';break
    case 'reopen':if(previous.status!=='completed')return false;expected.status='pending';delete expected.ownerId;break
    case 'edit':
     if(args.subject===undefined&&args.description===undefined&&args.write_scopes===undefined)return false
     if(args.subject!==undefined){if(typeof args.subject!=='string')return false;expected.subject=args.subject.trim()}
     if(args.description!==undefined){if(typeof args.description!=='string')return false;expected.description=args.description.trim()}
     if(args.write_scopes!==undefined){if(!strings(args.write_scopes))return false;expected.writeScopes=task.writeScopes}
     break
    case 'set_dependencies':if(!strings(args.blocked_by))return false;expected.blockedBy=args.blocked_by as never;break
    case 'reassign':
     if(!['pending','in_progress'].includes(previous.status))return false
     if(args.owner===undefined||typeof args.owner==='string'&&!args.owner.trim()){expected.status='pending';delete expected.ownerId}
     else{if(typeof args.owner!=='string'||task.ownerId!==sessionId||view.ownerName!==args.owner.trim())return false;expected.status='in_progress';expected.ownerId=sessionId as never}
     break
    case 'delete':expected.status='deleted';break
    default:return false
   }
   if(!isDeepStrictEqual(expected,task))return false
  }
  proven.set(task.id,task);used.add(receipt)
 }
 return used.size===mutations.length
}
