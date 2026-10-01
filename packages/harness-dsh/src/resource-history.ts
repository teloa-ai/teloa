import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isRecord,isResourceSpec,parseResourceReferences,resourceScopes,type ResourceSpec,type ResourceReference,type ResourceHistoryItem,type ResourceHistoryPage } from '@teloa/contract'
import {resourceMessageSource} from './resource-message-source.ts'

// 从已验证的 DSH 日志投影，只取本会话新增消息；不读取现行目录、不返回资料正文。
export function resourceHistoryPage(ownerId:string,sessionId:string,events:readonly SessionEvent[],beforeSeq?:number,inheritedEventCount=0):ResourceHistoryPage{
  const items:ResourceHistoryItem[]=[],contexts=new Map<string,unknown[]>()
  let turn:number|null=null
  for(const event of events.slice(inheritedEventCount)){
    if(event.type==='turn/start')turn=event.data.turn
    else if(event.type==='turn/end')turn=null
    else if(event.type==='user/message'){
      const message=event.data,text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
      if(message.source.kind==='user'&&text.includes('[[teloa-resource:')){
        let references:ResourceReference[]=[],issue:string|undefined
        try{references=parseResourceReferences(text)}catch{issue='资料引用损坏，原消息已保留，请查看资料读取失败记录。'}
        items.push({seq:event.seq,messageId:message.id,turn,at:new Date(event.time).toISOString(),references,...(issue?{issue}:{})})
      }else if(message.source.kind===resourceMessageSource){
        try{
          const payload:unknown=JSON.parse(text.slice(text.indexOf('\n')+1))
          if(isRecord(payload)&&payload.schema==='teloa.resource-context/v1'&&isRecord(payload.snapshot)&&typeof payload.snapshot.messageId==='string')contexts.set(payload.snapshot.messageId,[...(contexts.get(payload.snapshot.messageId)||[]),payload])
        }catch{/* 无法关联的上下文不作为资料名称或已提供的证据。 */}
      }
    }
  }
  for(const item of items){
    const records=contexts.get(item.messageId)
    if(!records||item.issue)continue
    let previous:ResourceSpec[]|undefined
    for(const payload of records){
      const metadata=checkedMetadata(payload,ownerId,sessionId,item.references)
      if(!metadata||(previous&&JSON.stringify(previous)!==JSON.stringify(metadata))){item.issue='历史资料上下文不匹配，未展示无法核对的资料名称。';previous=undefined;break}
      previous=metadata
    }
    if(previous)item.references=item.references.map((ref,index)=>({...ref,metadata:previous![index]!}))
  }
  const eligible=items.filter(item=>beforeSeq===undefined||item.seq<beforeSeq).reverse(),page=eligible.slice(0,10)
  return {sessionId,items:page,nextBeforeSeq:eligible.length>10?page.at(-1)!.seq:null}
}
function checkedMetadata(payload:unknown,ownerId:string,sessionId:string,refs:ResourceReference[]):ResourceSpec[]|undefined{
  if(!isRecord(payload)||!isRecord(payload.snapshot)||!Array.isArray(payload.contents))return
  const snapshot=payload.snapshot
  if(snapshot.ownerId!==ownerId||snapshot.sessionId!==sessionId||!resourceScopes(snapshot.scopeIds)||!Array.isArray(snapshot.references)||snapshot.references.length!==refs.length||payload.contents.length!==refs.length)return
  const scopeIds=snapshot.scopeIds
  const result:ResourceSpec[]=[]
  for(let i=0;i<refs.length;i++){
    const ref=refs[i]!,record=snapshot.references[i],content=payload.contents[i]
    if(!isRecord(record)||record.id!==ref.id||record.version!==ref.version||!isRecord(content)||content.id!==ref.id||content.version!==ref.version||typeof content.text!=='string'||!isResourceSpec(content)||content.scopeIds.some(scope=>!scopeIds.includes(scope)))return
    result.push({title:content.title,scopeIds:[...content.scopeIds],sourceId:content.sourceId,sourceVersion:content.sourceVersion})
  }
  return result
}
