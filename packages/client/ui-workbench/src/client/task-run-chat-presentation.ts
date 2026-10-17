import type {TaskRunChatPresentation} from './task-run-api.js'
import type {Conversation} from '@teloa/contract'

type ChatNode={kind:string;data:{source:unknown;content:readonly unknown[]}}
/** 只复制展示节点；原日志、原 ContentBlock 和送模输入均不写回。 */
export function projectTaskRunChatNode<Node extends ChatNode>(node:Node,sessionId:string,presentation:TaskRunChatPresentation|null):Node{
 const source=node.data.source
 if(!presentation||presentation.sessionId!==sessionId||node.kind!=='user'||!source||typeof source!=='object'||!('kind'in source)||source.kind!=='user'||!('rpcId'in source)||source.rpcId!==presentation.nativeRequestId)return node
 const attachments=node.data.content.filter(block=>!block||typeof block!=='object'||!('type'in block)||block.type!=='text')
 return {...node,data:{...node.data,content:[{type:'text',text:presentation.goal},...attachments]}}
}

export function taskRunSessionTitle(nativeTitle:string|undefined,sessionId:string|undefined,presentation:TaskRunChatPresentation|null){return presentation&&presentation.sessionId===sessionId?presentation.title:nativeTitle}
export type TaskRunChatSnapshot={status:'idle'|'loading'|'ready'|'failed';value:TaskRunChatPresentation|null;error?:unknown}
export const emptyTaskRunChatSource={getSnapshot:()=>emptySnapshot,subscribe:()=>()=>{},load:()=>Promise.resolve()}
const emptySnapshot:TaskRunChatSnapshot={status:'ready',value:null}
export class TaskRunChatPresentationDirectory{
 private readonly rows=new Map<string,ReturnType<TaskRunChatPresentationDirectory['create']>>()
 private readonly read:(sessionId:string)=>Promise<TaskRunChatPresentation|null>
 constructor(read:(sessionId:string)=>Promise<TaskRunChatPresentation|null>){this.read=read}
 private create(sessionId:string){
  let snapshot:TaskRunChatSnapshot={status:'idle',value:null},epoch=0,pending:Promise<void>|undefined
  const listeners=new Set<()=>void>(),publish=(next:TaskRunChatSnapshot)=>{snapshot=next;for(const listener of listeners)listener()}
  const load=()=>{
   if(pending)return pending
   if(snapshot.status==='ready')return Promise.resolve()
   const token=++epoch;publish({status:'loading',value:null})
   const operation=this.read(sessionId).then(value=>{if(token===epoch)publish({status:'ready',value})},error=>{if(token===epoch)publish({status:'failed',value:null,error})}).finally(()=>{if(pending===operation)pending=undefined})
   pending=operation;return operation
  }
  return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},load,invalidate:()=>{epoch++;pending=undefined;publish({status:'idle',value:null})}}
 }
 forSession(sessionId:string){let row=this.rows.get(sessionId);if(!row){row=this.create(sessionId);this.rows.set(sessionId,row)}return row}
 invalidate=()=>{for(const row of this.rows.values())row.invalidate()}
}

/** 复用同一次已验证预约；失败保持原错误，不将专用恢复降成普通 ensure/adopt。 */
export async function readTaskRunSelectedBinding(directory:TaskRunChatPresentationDirectory,sessionId:string,ordinary:()=>Promise<Conversation>):Promise<Conversation>{
 const source=directory.forSession(sessionId);await source.load();const snapshot=source.getSnapshot()
 if(snapshot.status!=='ready')throw snapshot.error??Error('运行会话归属暂时无法核对。')
 return snapshot.value?.conversation??ordinary()
}
