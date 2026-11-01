import type {TaskRunChatPresentation} from './task-run-api.js'
import type {Conversation} from '@teloa/contract'
import {useEffect,useState} from 'react'

type ChatNode={kind:string;data:{source:unknown;content:readonly unknown[]}}
/** 只复制展示节点；原日志、原 ContentBlock 和送模输入均不写回。 */
export function projectTaskRunChatNode<Node extends ChatNode>(node:Node,sessionId:string,presentation:TaskRunChatPresentation|null):Node{
 const source=node.data.source
 if(!presentation||presentation.sessionId!==sessionId||node.kind!=='user'||!source||typeof source!=='object'||!('kind'in source)||source.kind!=='user'||!('rpcId'in source))return node
 const goal=source.rpcId===presentation.nativeRequestId?presentation.goal:presentation.userMessages?.find(row=>row.nativeRequestId===source.rpcId)?.goal
 if(goal===undefined)return node
 const attachments=node.data.content.filter(block=>!block||typeof block!=='object'||!('type'in block)||block.type!=='text')
 return {...node,data:{...node.data,content:[{type:'text',text:goal},...attachments]}}
}

export function taskRunSessionTitle(nativeTitle:string|undefined,sessionId:string|undefined,presentation:TaskRunChatPresentation|null,conversation?:Conversation){
 if(presentation&&presentation.sessionId===sessionId)return presentation.title
 if(conversation&&conversation.sessionId===sessionId)return conversation.purpose==='task-run'?conversation.title:nativeTitle
 return sessionId?.startsWith('task-run-')?undefined:nativeTitle
}
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
  const load=(refresh=false)=>{
   if(pending)return pending
   if(snapshot.status==='ready'&&!refresh)return Promise.resolve()
   const token=++epoch;publish({status:'loading',value:null})
   const operation=this.read(sessionId).then(value=>{if(token===epoch)publish({status:'ready',value})},error=>{if(token===epoch)publish({status:'failed',value:null,error})}).finally(()=>{if(pending===operation)pending=undefined})
   pending=operation;return operation
  }
  return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},load,invalidate:()=>{epoch++;pending=undefined;publish({status:'idle',value:null})}}
 }
 forSession(sessionId:string){let row=this.rows.get(sessionId);if(!row){row=this.create(sessionId);this.rows.set(sessionId,row)}return row}
 invalidate=()=>{for(const row of this.rows.values())row.invalidate()}
}

const emptyTitles:ReadonlyMap<string,string>=new Map()
export function watchTaskRunConversationTitles(ids:readonly string[],directory:TaskRunChatPresentationDirectory,changed:(titles:ReadonlyMap<string,string>)=>void):()=>void{
 let active=true
 const sources=ids.map(id=>({id,source:directory.forSession(id)}))
 const publish=()=>{if(active)changed(new Map(sources.flatMap(({id,source})=>{const snapshot=source.getSnapshot(),value=snapshot.value;return snapshot.status==='ready'&&value?.sessionId===id?[[id,value.title] as const]:[]})))}
 const off=sources.map(({source})=>source.subscribe(()=>{publish();if(active&&source.getSnapshot().status==='idle')void source.load()}));publish()
 for(const {source} of sources)void source.load()
 return ()=>{active=false;for(const dispose of off)dispose()}
}
/** 共用现有本人只读缓存；显示名不写回预约，换目录或连接后迟到回包不覆盖当前视图。 */
export function useTaskRunConversationTitles(conversations:readonly Conversation[],directory:TaskRunChatPresentationDirectory|undefined):ReadonlyMap<string,string>{
 const key=JSON.stringify(conversations.filter(row=>row.purpose==='task-run'&&row.status==='ready').map(row=>row.sessionId).sort())
 const [read,setRead]=useState<{directory:TaskRunChatPresentationDirectory;key:string;titles:ReadonlyMap<string,string>}>()
 useEffect(()=>{
  if(!directory)return
  return watchTaskRunConversationTitles(JSON.parse(key) as string[],directory,titles=>setRead({directory,key,titles}))
 },[directory,key])
 return read&&read.directory===directory&&read.key===key?read.titles:emptyTitles
}

/** 明确打开时重新核对规范 Run；同次在途读共享，原预约始终只读。 */
export async function readTaskRunSelectedBinding(directory:TaskRunChatPresentationDirectory,sessionId:string,ordinary:()=>Promise<Conversation>):Promise<Conversation>{
 const source=directory.forSession(sessionId);await source.load(true);const snapshot=source.getSnapshot()
 if(snapshot.status!=='ready')throw snapshot.error??Error('运行会话归属暂时无法核对。')
 return snapshot.value?.conversation??ordinary()
}
