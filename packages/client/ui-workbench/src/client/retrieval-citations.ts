import {WorkError,isRecord,readRetrievalCitationPath,readRetrievalSearchResult,retrievalCitationPath,type RetrievalSearchHit} from '@teloa/contract'
import type {ConversationPlanEvents} from './conversation-plans.ts'
export type RetrievalCitation={sessionId:string;resourceId:string;resourceVersion:number;sourceId:string;sourceVersion:string;title:string;excerpts:{text:string;heading:string|null;lines:[number,number];chars:[number,number]}[]}
export type RetrievalCitationEvents={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>ConversationPlanEvents}
export type RetrievalCitationPort={sessionId:string;events:RetrievalCitationEvents;current:()=>boolean;available:(id:string)=>Promise<boolean>;openResource:(address:string)=>void}
export const retrievalCitationTabId='@teloa/client-ui-workbench/retrieval-source',retrievalCitationTabKind='teloa.retrieval-source'
const unavailable=()=>new WorkError('teloa/source-unavailable','此引用来源暂不可用，请返回原会话重新核对。')
const legacy=/^(?:local_material|knowledge)_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const isRetrievalCitationLink=(path:string)=>path.startsWith('teloa-source/')||legacy.test(path)
const identity=(hit:RetrievalSearchHit)=>JSON.stringify([hit.resourceId,hit.resourceVersion,hit.sourceId,hit.sourceVersion])
function trustedHits(entries:ConversationPlanEvents['entries'],sessionId:string):RetrievalSearchHit[]{
 const calls=new Map<string,number>(),hits:RetrievalSearchHit[]=[]
 for(const {event} of entries){
  const data=event.data;if(!isRecord(data)||!Number.isSafeInteger(data.turn))continue
  if(event.type==='tool/call'&&data.name==='teloa_knowledge_search'&&typeof data.callId==='string')calls.set(data.callId,data.turn as number)
  if(event.type!=='tool/result'||data.error||!isRecord(data.message))continue
  const message=data.message
  if(message.isError||typeof message.toolCallId!=='string'||calls.get(message.toolCallId)!==data.turn||!isRecord(message.source)||message.source.kind!=='tool'||message.source.callId!==message.toolCallId||!Array.isArray(message.content))continue
  try{
   const value=readRetrievalSearchResult(JSON.parse(message.content.filter(isRecord).filter(item=>item.type==='text').map(item=>item.text).join('\n')))
   for(const hit of value.results)if(hit.citationPath===undefined||readRetrievalCitationPath(hit.citationPath)?.sessionId===sessionId)hits.push(hit)
  }catch{/* 原回执损坏、调用不匹配或会话不一致不能产生来源入口。 */}
 }
 return hits
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
 if(readRetrievalCitationPath(path)?.sessionId===sessionId)return 'dsh-resource://'+path
 if(legacy.test(path))return 'dsh-resource://teloa-source/'+encodeURIComponent(sessionId)+'/legacy/'+path
 throw unavailable()
}
export function readRetrievalSourceAddress(address:string):{sessionId:string;path:string}|undefined{
 const prefix='dsh-resource://teloa-source/'
 if(!address.startsWith(prefix))return
 const path=address.slice('dsh-resource://'.length),citation=readRetrievalCitationPath(path)
 if(citation)return {sessionId:citation.sessionId,path}
 const parts=address.slice(prefix.length).split('/')
 try{const sessionId=decodeURIComponent(parts[0]!);if(sessionId&&sessionId.length<=128&&encodeURIComponent(sessionId)===parts[0]&&!/[\x00-\x20\x7f/\\]/.test(sessionId)){
  if(parts.length===2&&parts[1]==='unavailable')return {sessionId,path:''}
  if(parts.length===3&&parts[1]==='legacy'&&legacy.test(parts[2]!))return {sessionId,path:parts[2]!}
 }}catch{return}
 return
}
/** 不取当前正文替换原版本；原件撤回、会话关闭或原工具回执被撤下均不可打开。 */
export async function openRetrievalCitation(port:RetrievalCitationPort,path:string):Promise<void>{
 if(!port.current())throw unavailable()
 const reference=resolveRetrievalCitation(port.events.getSnapshot().entries,port.sessionId,path)
 if(!reference||!await port.available(reference.resourceId)||!port.current())throw unavailable()
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
  return isRetrievalCitationLink(path)?{path}:undefined
 }
 const click=(event:MouseEvent)=>{
  const link=destination(event);if(!link)return
  event.preventDefault();event.stopImmediatePropagation()
  const port=current();if(!port?.current())return
  void openRetrievalCitation(port,link.path).catch(()=>{if(port.current())port.openResource('dsh-resource://teloa-source/'+encodeURIComponent(port.sessionId)+'/unavailable')})
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
