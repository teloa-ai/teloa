import type {ConversationPlanEvents} from './conversation-plans.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

const key=(sessionId:string)=>'teloa.task-creation/v1:'+sessionId
/** 原生事件源的方法依赖接收者，传给 React 时保留该归属。 */
export function taskCreationEventSource(source:{getSnapshot:()=>ConversationPlanEvents;subscribe:(listener:()=>void)=>()=>void}){
 return {getSnapshot:()=>source.getSnapshot(),subscribe:(listener:()=>void)=>source.subscribe(listener)}
}
export function rememberTaskCreation(storage:WorkbenchNavigationStorage,sessionId:string,scope:string):void{storage.setItem(key(sessionId),JSON.stringify({scope}))}
export function forgetTaskCreation(storage:WorkbenchNavigationStorage,sessionId:string):void{storage.removeItem(key(sessionId))}
export function readTaskCreation(storage:WorkbenchNavigationStorage,sessionId:string):{scope:string}|undefined{
 try{const value=JSON.parse(storage.getItem(key(sessionId))??'null');if(value&&typeof value.scope==='string'&&value.scope.length>0)return {scope:value.scope}}catch{/* 损坏或不可用的存储不恢复入口。 */}
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'
/** 只认本轮本人输入、原生终轮及实际工具调用；助手的口头保存声明不是回执。 */
export function taskCreationWithoutDispatch(snapshot:ConversationPlanEvents):string|undefined{
 const events=snapshot.entries.map(entry=>entry.event)
 let start=events.length-1
 while(start>=0&&events[start]!.type!=='turn/start')start--
 if(start<0)return
 const turn=events.slice(start+1)
 if(!turn.some(event=>event.type==='turn/end'))return
 if(turn.some(event=>event.type==='tool/call'&&record(event.data)&&event.data.name==='teloa_work_dispatch'))return
 const users=turn.filter(event=>event.type==='user/message'&&record(event.data)&&record(event.data.source)&&event.data.source.kind==='user')
 const text=users.flatMap(event=>record(event.data)&&Array.isArray(event.data.content)?event.data.content.filter(record).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text as string):[]).join('\n').trim()
 return text||undefined
}
