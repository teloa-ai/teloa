import {WorkError,isRecord,readRetrievalCitationPath,readRetrievalSearchResult,retrievalCitationPath,readProjectContextCitation,projectCitationSelector,projectCitationMatches,projectCitationTurnSources,type ProjectContextCitation,type ProjectContextCitationRequest,type RetrievalSearchHit} from '@teloa/contract'
import type {ConversationPlanEvents} from './conversation-plans.ts'
import {readTaskReferenceCitationPath,readTaskReferenceCitation,type TaskReferenceCitationRequest,type TaskReferenceCitation} from '@teloa/contract'
export type RetrievalCitation={sessionId:string;resourceId:string;resourceVersion:number;sourceId:string;sourceVersion:string;title:string;excerpts:{text:string;heading:string|null;lines:[number,number];chars:[number,number]}[]}
export type RetrievalCitationEvents={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>ConversationPlanEvents}
export type RetrievalCitationPort={sessionId:string;events:RetrievalCitationEvents;current:()=>boolean;available:(id:string,version?:number,sourceVersion?:string)=>Promise<boolean>;projectSource?:(input:ProjectContextCitationRequest,signal?:AbortSignal)=>Promise<unknown>;taskSource?:(input:TaskReferenceCitationRequest,signal?:AbortSignal)=>Promise<unknown>;openResource:(address:string)=>void}
export const retrievalCitationTabId='@teloa/client-ui-workbench/retrieval-source',retrievalCitationTabKind='teloa.retrieval-source'
const unavailable=()=>new WorkError('teloa/source-unavailable','此引用来源暂不可用，请返回原会话重新核对。')
const legacy=/^(?:local_material|knowledge)_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const isRetrievalCitationLink=(path:string)=>path.startsWith('teloa-source/')||legacy.test(path)||!!projectCitationSelector(path)
export async function readTaskCitation(port:RetrievalCitationPort,request:TaskReferenceCitationRequest,signal?:AbortSignal):Promise<TaskReferenceCitation>{
 if(!port.current()||request.sessionId!==port.sessionId||!readTaskReferenceCitationPath(request.path)||!port.taskSource)throw unavailable()
 const result=readTaskReferenceCitation(await port.taskSource(request,signal));signal?.throwIfAborted()
 if(!port.current()||result.sessionId!==request.sessionId||result.citationPath!==request.path)throw unavailable()
 return result
}
/** 只从真实同轮工具调用/回执补入口；普通消息中的相似 JSON 不形成来源。 */
export function taskTurnCitations(entries:ConversationPlanEvents['entries'],turn:number):{path:string;title:string;version:number}[]{
 const calls=new Map<string,{id:string;version:string}>(),found=new Map<string,{path:string;title:string;version:number}>()
 for(const {event} of entries){
  const data=event.data;if(!isRecord(data)||data.turn!==turn)continue
  if(event.type==='tool/call'&&data.name==='mcp__teloa_reference__read_reference'&&typeof data.callId==='string'&&isRecord(data.arguments)&&typeof data.arguments.id==='string'&&typeof data.arguments.version==='string')calls.set(data.callId,{id:data.arguments.id,version:data.arguments.version})
  if(event.type!=='tool/result'||data.error||!isRecord(data.message))continue
  const message=data.message,call=typeof message.toolCallId==='string'?calls.get(message.toolCallId):undefined
  if(!call||message.isError||!isRecord(message.source)||message.source.kind!=='tool'||message.source.callId!==message.toolCallId||!Array.isArray(message.content))continue
  try{
   const value=JSON.parse(message.content.filter(isRecord).filter(row=>row.type==='text').map(row=>row.text).join('\n')),citation=readTaskReferenceCitationPath(value.citationPath)
   if(!citation||value.schema!=='teloa.reference/v1'||value.id!==call.id||value.source!==call.id||value.version!==call.version||citation.sourceVersion!==call.version||typeof value.title!=='string'||!Array.isArray(value.references)||!value.references.some((ref:unknown)=>isRecord(ref)&&ref.id===citation.resourceId&&ref.version===citation.resourceVersion))continue
   found.set(value.citationPath,{path:value.citationPath,title:value.title,version:citation.resourceVersion})
  }catch{/* 损坏或非匹配的回执不补来源。 */}
 }
 return [...found.values()]
}
export function projectCitationRequest(sessionId:string,path:string,turn:number):ProjectContextCitationRequest|undefined{
 const selector=projectCitationSelector(path);if(!selector||!Number.isSafeInteger(turn)||turn<1)return
 return 'id'in selector?{sessionId,turn,...selector}:{sessionId,turn,reference:path}
}
export async function readProjectCitation(port:RetrievalCitationPort,request:ProjectContextCitationRequest,signal?:AbortSignal):Promise<ProjectContextCitation>{
 if(!port.current()||request.sessionId!==port.sessionId||!port.projectSource)throw unavailable()
 const result=readProjectContextCitation(await port.projectSource(request,signal));signal?.throwIfAborted()
 const selector='reference'in request?projectCitationSelector(request.reference):request
 if(!port.current()||result.sessionId!==request.sessionId||result.turn!==request.turn||!selector||!projectCitationMatches(result,selector))throw unavailable()
 return result
}
// 此处只识别已出现的历史内联链接；代码、转义文字和图片不是来源入口，不替代官方Markdown渲染。
function citationProse(text:string):string{
 const lines:string[]=[];let fence:{char:string;length:number}|undefined
 for(const line of text.split('\n')){
  const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if(fence){if(marker&&marker[1]![0]===fence.char&&marker[1]!.length>=fence.length&&!marker[2]!.trim())fence=undefined;continue}
  if(marker){fence={char:marker[1]![0]!,length:marker[1]!.length};continue}
  if(/^(?: {4}|\t)/.test(line))continue
  lines.push(line)
 }
 return lines.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,'').replace(/\\./g,'')
}
/** 英文自定义scheme被官方Markdown安全降为文字；仅为原回复实际引用且唯一匹配的来源补原生轮尾入口。 */
export function projectTurnAliasCitations(entries:ConversationPlanEvents['entries'],sessionId:string,turn:number):{path:string;source:{kind:string;id:string;title:string;version:number}}[]{
 const {rows}=projectCitationTurnSources(entries.map(row=>row.event),sessionId,turn),found=new Map<string,{path:string;source:typeof rows[number]['source']}>()
 for(const {event} of entries){
  if(event.type!=='assistant/message'||!isRecord(event.data)||event.data.turn!==turn||!isRecord(event.data.message)||!Array.isArray(event.data.message.content))continue
  const text=citationProse(event.data.message.content.filter(isRecord).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n'))
  for(const match of text.matchAll(/(?<!!)\[[^\]\r\n]{1,240}\]\(((?:memory|rule|brief|project):[a-f0-9-]{36})\)/gi)){
   const path=match[1]!,selector=projectCitationSelector(path);if(!selector)continue
   const matches=rows.filter(row=>projectCitationMatches(row.source,selector));if(matches.length!==1)continue
   const source=matches[0]!.source;found.set(JSON.stringify([source.kind,source.id,source.version,source.hash]),{path,source})
  }
 }
 return [...found.values()]
}
const identity=(hit:RetrievalSearchHit)=>JSON.stringify([hit.resourceId,hit.resourceVersion,hit.sourceId,hit.sourceVersion])
/** 按需 read 与 search 共用来源导航，但 read 的 4,000 UTF-16 字符限额不是检索摘录的字节限额。 */
function readKnowledgeHit(value:unknown,input:unknown,sessionId:string):RetrievalSearchHit|undefined{
 try{
  const args=typeof input==='string'?JSON.parse(input):input
  if(!isRecord(args)||Object.keys(args).some(key=>!['resourceId','resourceVersion','sourceVersion','offset','length'].includes(key))||!isRecord(value))return
  const keys=['resourceId','resourceVersion','title','sourceId','sourceVersion','chars','lines','excerpt','totalChars','nextOffset','notice','citationPath']
  if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))return
  const offset=args.offset??0,length=args.length??2000
  if(!Number.isSafeInteger(offset)||(offset as number)<0||!Number.isSafeInteger(length)||(length as number)<1||(length as number)>4000)return
  if(typeof value.citationPath!=='string')return
  const citation=readRetrievalCitationPath(value.citationPath)
  if(!citation||citation.sessionId!==sessionId||citation.resourceId!==args.resourceId||citation.resourceVersion!==args.resourceVersion||citation.sourceVersion!==args.sourceVersion)return
  if(value.resourceId!==citation.resourceId||value.resourceVersion!==citation.resourceVersion||value.sourceVersion!==citation.sourceVersion)return
  if(typeof value.title!=='string'||!value.title.trim()||value.title.length>200||typeof value.sourceId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value.sourceId))return
  if(!Array.isArray(value.chars)||value.chars.length!==2||value.chars.some((n,i)=>n!==citation.chars[i])||typeof value.excerpt!=='string'||!value.excerpt.trim())return
  const [start,end]=citation.chars,text=value.excerpt,total=value.totalChars
  if(!Number.isSafeInteger(total)||(total as number)<end||text.length!==end-start||typeof value.notice!=='string')return
  if(start!==offset&&!(start===(offset as number)-1&&/^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)))return
  const limit=Math.min(total as number,start+(length as number))
  if(end!==limit&&end!==limit-1&&!(length===1&&end===start+2))return
  if(value.nextOffset!==(end<(total as number)?end:null))return
  if(!Array.isArray(value.lines)||value.lines.length!==2||!value.lines.every(n=>Number.isSafeInteger(n)&&n>=0)||value.lines[1]<value.lines[0])return
  if(value.lines[1]-value.lines[0]!==text.slice(0,Math.max(0,text.length-1)).split('\n').length-1)return
  return {resourceId:citation.resourceId,resourceVersion:citation.resourceVersion,sourceVersion:citation.sourceVersion,sourceId:value.sourceId,title:value.title,chars:citation.chars,lines:[value.lines[0],value.lines[1]],excerpt:text,heading:null,score:0,citationPath:value.citationPath}
 }catch{return}
}
function trustedHits(entries:ConversationPlanEvents['entries'],sessionId:string):RetrievalSearchHit[]{
 const calls=new Map<string,number>(),hits:RetrievalSearchHit[]=[]
 const reads=new Map<string,{turn:number;input:unknown}>(),seen=new Set<string>(),ambiguous=new Set<string>(),readHits:{callId:string;hit:RetrievalSearchHit}[]=[]
 for(const {event} of entries){
  const data=event.data;if(!isRecord(data)||!Number.isSafeInteger(data.turn))continue
  if(event.type==='tool/call'&&typeof data.callId==='string'){
   if(seen.has(data.callId))ambiguous.add(data.callId)
   seen.add(data.callId)
   if(data.name==='teloa_knowledge_read')reads.set(data.callId,{turn:data.turn as number,input:data.arguments})
  }
  if(event.type==='tool/call'&&data.name==='teloa_knowledge_search'&&typeof data.callId==='string')calls.set(data.callId,data.turn as number)
  if(event.type!=='tool/result'||data.error||!isRecord(data.message))continue
  const message=data.message
  if(message.isError||typeof message.toolCallId!=='string'||!isRecord(message.source)||message.source.kind!=='tool'||message.source.callId!==message.toolCallId||!Array.isArray(message.content))continue
  const read=reads.get(message.toolCallId),trustedRead=read&&read.turn===data.turn&&!ambiguous.has(message.toolCallId)&&message.role==='tool'
  if(!trustedRead&&calls.get(message.toolCallId)!==data.turn)continue
  try{
   const parsed=JSON.parse(message.content.filter(isRecord).filter(item=>item.type==='text').map(item=>item.text).join('\n'))
   if(trustedRead){
    const hit=readKnowledgeHit(parsed,read.input,sessionId);if(hit)readHits.push({callId:message.toolCallId,hit})
    continue
   }
   if(calls.get(message.toolCallId)!==data.turn)continue
   const value=readRetrievalSearchResult(parsed)
   for(const hit of value.results)if(hit.citationPath===undefined||readRetrievalCitationPath(hit.citationPath)?.sessionId===sessionId)hits.push(hit)
  }catch{/* 原回执损坏、调用不匹配或会话不一致不能产生来源入口。 */}
 }
 return [...hits,...readHits.filter(row=>!ambiguous.has(row.callId)).map(row=>row.hit)]
}
/** 旧 sourceId 只在本会话真实工具回执中唯一映射到固定原件；相同原件的多个片段保留。 */
export function resolveRetrievalCitation(entries:ConversationPlanEvents['entries'],sessionId:string,path:string):RetrievalCitation|undefined{
 const citation=readRetrievalCitationPath(path),hits=trustedHits(entries,sessionId)
 if(citation&&citation.sessionId!==sessionId)return
 const matched=citation?hits.filter(hit=>retrievalCitationPath(sessionId,hit)===path):legacy.test(path)?hits.filter(hit=>hit.sourceId===path):[]
 if(!matched.length||new Set(matched.map(identity)).size!==1)return
 const original=matched[0]!,rows=hits.filter(hit=>identity(hit)===identity(original))
 if(rows.some(hit=>hit.title!==original.title))return
 const excerpts=new Map<string,RetrievalCitation['excerpts'][number]>()
 for(const hit of rows){const key=hit.chars.join('-'),prior=excerpts.get(key);if(prior&&prior.text!==hit.excerpt)return;excerpts.set(key,{text:hit.excerpt,heading:hit.heading,lines:hit.lines,chars:hit.chars})}
 return {sessionId,resourceId:original.resourceId,resourceVersion:original.resourceVersion,sourceId:original.sourceId,sourceVersion:original.sourceVersion,title:original.title,excerpts:[...excerpts.values()].sort((a,b)=>a.chars[0]-b.chars[0]||a.chars[1]-b.chars[1])}
}
export function retrievalSourceAddress(sessionId:string,path:string):string{
 if(readTaskReferenceCitationPath(path))return 'dsh-resource://teloa-source/'+encodeURIComponent(sessionId)+'/task/'+encodeURIComponent(path)
 if(readRetrievalCitationPath(path)?.sessionId===sessionId)return 'dsh-resource://'+path
 if(legacy.test(path))return 'dsh-resource://teloa-source/'+encodeURIComponent(sessionId)+'/legacy/'+path
 throw unavailable()
}
export function readRetrievalSourceAddress(address:string):{sessionId:string;path:string;project?:ProjectContextCitationRequest;task?:TaskReferenceCitationRequest}|undefined{
 const prefix='dsh-resource://teloa-source/'
 if(!address.startsWith(prefix))return
 const path=address.slice('dsh-resource://'.length),citation=readRetrievalCitationPath(path)
 if(citation)return {sessionId:citation.sessionId,path}
 const parts=address.slice(prefix.length).split('/')
 try{const sessionId=decodeURIComponent(parts[0]!);if(sessionId&&sessionId.length<=128&&encodeURIComponent(sessionId)===parts[0]&&!/[\x00-\x20\x7f/\\]/.test(sessionId)){
  if(parts.length===2&&parts[1]==='unavailable')return {sessionId,path:''}
  if(parts.length===3&&parts[1]==='legacy'&&legacy.test(parts[2]!))return {sessionId,path:parts[2]!}
  if(parts.length===3&&parts[1]==='task'){const path=decodeURIComponent(parts[2]!);if(encodeURIComponent(path)===parts[2]&&readTaskReferenceCitationPath(path))return {sessionId,path,task:{sessionId,path}}}
  if(parts.length===5&&parts[1]==='project'&&/^[1-9][0-9]*$/.test(parts[2]!)){const path=parts[3]+'/'+parts[4],project=projectCitationRequest(sessionId,path,Number(parts[2]));if(project)return {sessionId,path,project}}
 }}catch{return}
 return
}
/** 不取当前正文替换原版本；原件撤回、会话关闭或原工具回执被撤下均不可打开。 */
export async function openRetrievalCitation(port:RetrievalCitationPort,path:string,turn?:number):Promise<void>{
 if(!port.current())throw unavailable()
 if(readTaskReferenceCitationPath(path)){
  await readTaskCitation(port,{sessionId:port.sessionId,path})
  port.openResource(retrievalSourceAddress(port.sessionId,path));return
 }
 if(projectCitationSelector(path)){
  const request=projectCitationRequest(port.sessionId,path,turn??0);if(!request)throw unavailable()
  const source=await readProjectCitation(port,request)
  port.openResource('dsh-resource://teloa-source/'+encodeURIComponent(port.sessionId)+'/project/'+source.turn+'/'+source.kind+'/'+source.id);return
 }
 const reference=resolveRetrievalCitation(port.events.getSnapshot().entries,port.sessionId,path)
 if(!reference||!await port.available(reference.resourceId,reference.resourceVersion,reference.sourceVersion)||!port.current())throw unavailable()
 const current=resolveRetrievalCitation(port.events.getSnapshot().entries,port.sessionId,path)
 if(!current||JSON.stringify(current)!==JSON.stringify(reference))throw unavailable()
 port.openResource(retrievalSourceAddress(port.sessionId,path))
}
export function retrievalTurnCitations(entries:ConversationPlanEvents['entries'],sessionId:string,turn:number):{path:string;reference:RetrievalCitation}[]{
 const subset=entries.filter(({event})=>isRecord(event.data)&&event.data.turn===turn),result=new Map<string,{path:string;reference:RetrievalCitation}>()
 for(const hit of trustedHits(subset,sessionId)){
  const path=retrievalCitationPath(sessionId,hit),reference=resolveRetrievalCitation(entries,sessionId,path)
  if(reference)result.set(identity(hit),{path,reference})
 }
 return [...result.values()]
}
/** 固定 DSH alpha.3 的 Markdown 本地链接以 button/title=decoded path 呈现；不替换其 renderer。 */
export function installRetrievalCitationNavigation(container:HTMLElement,current:()=>RetrievalCitationPort|undefined){
 const destination=(event:Event)=>{
  const target=event.target instanceof Element?event.target.closest('button[title],a[href]'):null
  if(!target)return
  const path=target.getAttribute(target.tagName==='A'?'href':'title')??''
  const turn=Number(target.closest('[data-chat-turn]')?.getAttribute('data-chat-turn')),selector=projectCitationSelector(path)
  // 裸hash也可能是普通文件名；仅在原轮次快照确有该来源时接管导航，最终许可仍由宿主核对。
  if(selector&&'hash'in selector){const port=current();if(!port||!projectCitationTurnSources(port.events.getSnapshot().entries.map(row=>row.event),port.sessionId,turn).rows.some(row=>projectCitationMatches(row.source,selector)))return}
  return isRetrievalCitationLink(path)?{path,turn}:undefined
 }
 const click=(event:MouseEvent)=>{
  const link=destination(event);if(!link)return
  event.preventDefault();event.stopImmediatePropagation()
  const port=current();if(!port?.current())return
  void openRetrievalCitation(port,link.path,link.turn).catch(()=>{if(port.current())port.openResource('dsh-resource://teloa-source/'+encodeURIComponent(port.sessionId)+'/unavailable')})
 }
 container.addEventListener('click',click,true)
 return ()=>container.removeEventListener('click',click,true)
}
const navigationOwners=new WeakMap<HTMLElement,{port:RetrievalCitationPort;count:number;dispose:()=>void}>()
export function retainRetrievalCitationNavigation(container:HTMLElement,port:RetrievalCitationPort){
 let owner=navigationOwners.get(container)
 if(!owner||owner.port!==port){owner?.dispose();owner={port,count:0,dispose:installRetrievalCitationNavigation(container,()=>port)};navigationOwners.set(container,owner)}
 const retained=owner;retained.count++
 return ()=>{if(--retained.count===0){retained.dispose();if(navigationOwners.get(container)===retained)navigationOwners.delete(container)}}
}
