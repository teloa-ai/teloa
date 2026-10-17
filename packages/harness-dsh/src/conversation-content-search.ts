import {WorkError,isReservedExecutionSessionId} from '@teloa/contract'

type Binding={sessionId:string;status:string;purpose?:string|undefined}
type Source={header:{id:string;origin?:string|undefined}}
type Document={sessionId:string;type:string;surface:string;text:string;source:{kind:string;form?:string|undefined}}
export type ConversationContentSearchPorts={list:()=>Promise<readonly Binding[]>;sessions:(signal:AbortSignal)=>Promise<readonly Source[]>;filter:(sessionId:string,query:string)=>Promise<readonly Document[]>}
const allowed=(rows:readonly Binding[])=>new Set(rows.filter(row=>row.status==='ready'&&row.purpose!=='task-run'&&!isReservedExecutionSessionId(row.sessionId)).map(row=>row.sessionId))
const snippet=(text:string,query:string)=>{
 const plain=text.replace(/\s+/gu,' ').trim(),index=plain.toLowerCase().indexOf(query.toLowerCase()),start=Math.max(0,Array.from(plain.slice(0,Math.max(0,index))).length-50),points=Array.from(plain)
 return (start?'…':'')+points.slice(start,start+240).join('')+(start+240<points.length?'…':'')
}

/** 沿 DSH 原生语义文档过滤；只读本人显式接入的目录，不另建索引或激活执行会话。 */
export async function searchConversationContent(ports:ConversationContentSearchPorts,input:unknown,signal:AbortSignal):Promise<{items:{sessionId:string;snippet:string}[];hasMore:boolean}>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof (input as {query?:unknown}).query!=='string')throw new WorkError('teloa/invalid-input','正文查询格式不正确。')
 const query=(input as {query:string}).query.trim().replace(/\s+/gu,' ')
 if(!query||query.length>1000||query.includes('\0'))throw new WorkError('teloa/invalid-input','正文查询为空、过长或含非法字符。')
 signal.throwIfAborted()
 const visible=allowed(await ports.list());signal.throwIfAborted()
 if(!visible.size)return {items:[],hasMore:false}
 const candidates=(await ports.sessions(signal)).filter(row=>visible.has(row.header.id)&&row.header.origin!=='subagent');signal.throwIfAborted()
 const items:{sessionId:string;snippet:string}[]=[],seen=new Set<string>();let hasMore=candidates.length>1000
 for(const source of candidates.slice(0,1000)){
  signal.throwIfAborted()
  const id=source.header.id
  if(seen.has(id))continue
  seen.add(id)
  const documents=await ports.filter(id,query);signal.throwIfAborted()
  if(documents.some(doc=>doc.sessionId!==id||!['user/message','assistant/message'].includes(doc.type)||doc.surface!=='current'||typeof doc.text!=='string'||!doc.source||typeof doc.source.kind!=='string'))throw new WorkError('teloa/invalid-host-response','原生正文检索返回了不匹配的来源。')
  // 用户正文、模型回复及可见通知属于聊天；自动注入的指令和环境快照属于上下文。
  const match=documents.filter(doc=>doc.type==='assistant/message'||doc.source.kind==='user'||doc.source.form==='notice').at(-1)
  if(match)items.push({sessionId:id,snippet:snippet(match.text,query)})
  if(items.length>50){hasMore=true;break}
 }
 // 在读取完成后复核当前归属，不能发布已离开本人目录的迟到正文。
 const current=allowed(await ports.list());signal.throwIfAborted()
 return {items:items.slice(0,50).filter(row=>current.has(row.sessionId)),hasMore}
}
