import {groupMessagePageInput,type GroupMessage,type GroupReadingState} from '@teloa/contract'
const order=(a:GroupMessage,b:GroupMessage)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)
const main=(message:GroupMessage)=>message.rootId===null||'runId'in message&&message.contextMode==='main'
/** 既有真实API浏览器用例的RPC夹具迁移；产品路径不回退全量list。 */
export function groupMessagePageFixture(all:GroupMessage[],raw:unknown){
 const input=groupMessagePageInput(raw),group=all.filter(row=>row.groupId===input.groupId),root=input.rootId?group.find(row=>row.id===input.rootId):undefined,rows=group.filter(row=>input.rootId?row.rootId===input.rootId:main(row)).sort(order),anchor=input.before??input.after??input.around,index=rows.findIndex(row=>row.id===anchor),limit=input.limit
 const start=input.around?Math.max(0,index-Math.floor(limit/2)):input.before?Math.max(0,index-limit):input.after?index+1:Math.max(0,rows.length-limit),end=input.before?index:start+limit,selected=rows.slice(start,end)
 const roots=[...new Set([...selected.filter(row=>row.rootId===null).map(row=>row.id),...(input.topicRoots??[])])]
 return {schema:'teloa.group-message-page/v1',groupId:input.groupId,rootId:input.rootId??null,items:root?[root,...selected]:selected,older:selected.length&&start>0?selected[0]!.id:null,newer:selected.length&&end<rows.length?selected.at(-1)!.id:null,topics:input.rootId?[]:roots.map(rootId=>{const replies=group.filter(row=>row.rootId===rootId).sort(order),people=[...new Map([...replies].reverse().map(row=>[row.authorId,row])).values()];return {rootId,count:replies.length,participants:people.length,replies:people.slice(0,3).sort(order)}})}
}
export function groupMessageReadingFixture(all:GroupMessage[],input:{groupId:string;rootId?:string;messageId?:string},cursors:Record<string,GroupReadingState['cursor']>):GroupReadingState{
 const rows=all.filter(row=>row.groupId===input.groupId&&(input.rootId?row.id===input.rootId||row.rootId===input.rootId:main(row))).sort(order),key=input.groupId+':'+(input.rootId??'main'),message=rows.find(row=>row.id===input.messageId)
 if(message){const old=cursors[key],next={messageId:message.id,createdAt:message.createdAt};if(!old||next.createdAt>old.createdAt||next.createdAt===old.createdAt&&next.messageId>old.messageId)cursors[key]=next}
 const last=rows.at(-1)
 return {schema:'teloa.group-reading/v1',groupId:input.groupId,rootId:input.rootId??null,cursor:cursors[key]??null,latest:last?{messageId:last.id,createdAt:last.createdAt}:null,unreadCount:0}
}
