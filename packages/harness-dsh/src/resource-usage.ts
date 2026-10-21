import {WorkError,type Conversation,type ResourceUsagePage,type WorkResource} from '@teloa/contract'
import type {Session} from '@deepseek-ai/dsh-session'
import {resourceHistoryPage} from './resource-history.ts'
import {readSessionEvents} from './session-events.ts'

/** 本人查询已获准查看的资料，再逐一核对本人历史访问权；不以会话的通用绑定范围猜测历史引用。 */
export async function resourceUsagePage(owner:string,resource:WorkResource,conversations:readonly Conversation[],read:(id:string)=>Promise<Session>,cursor?:string):Promise<ResourceUsagePage>{
 if(resource.ownerId!==owner)throw new WorkError('teloa/forbidden','资料不可访问。')
 const candidates=conversations.filter(row=>row.ownerId===owner&&row.status==='ready'&&row.purpose!=='task-run').sort((a,b)=>a.sessionId<b.sessionId?-1:a.sessionId>b.sessionId?1:0)
 const rows=candidates.filter(row=>cursor===undefined||row.sessionId>cursor).slice(0,21),page=rows.slice(0,20)
 const result:ResourceUsagePage={resourceId:resource.id,version:resource.version,items:[],related:[],relatedMore:false,scanned:page.length,unavailable:0,nextCursor:rows.length>20?page.at(-1)!.sessionId:null}
 // 四个读取一组，错误明确计入未完成核对，不能当成未引用。
 for(let index=0;index<page.length;index+=4)await Promise.all(page.slice(index,index+4).map(async row=>{
  try{
   const session=await read(row.sessionId)
   if(session.id!==row.sessionId)throw Error('历史身份不一致')
   const history=resourceHistoryPage(owner,row.sessionId,readSessionEvents(session),undefined,session.inheritedEventCount,{id:resource.id}),item=history.items[0]
   if(item)result.items.push({sessionId:row.sessionId,title:row.title,messageId:item.messageId,at:item.at,version:item.references.find(ref=>ref.id===resource.id)!.version})
  }catch{result.unavailable++}
 }))
 result.items.sort((a,b)=>b.at.localeCompare(a.at)||a.sessionId.localeCompare(b.sessionId));return result
}
