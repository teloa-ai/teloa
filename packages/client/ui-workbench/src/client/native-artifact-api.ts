import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ArtifactMessage, ArtifactImage, NativeArtifactApi } from './artifact-native.ts'
export function nativeArtifactMessages(sessionId:string,entries:readonly SessionEventLikeEntry[]):ArtifactMessage[]{
  const result:ArtifactMessage[]=[]
  for(const entry of entries){
    if(entry.type!=='event')continue
    const event=entry.event
    // 原生 append 标记区分原消息与模型压缩替代副本，流式 chunk 不是独立消息。
    if((event.type!=='user/message'&&event.type!=='assistant/message')||event.surfaceOp!=='append')continue
    const message=event.type==='user/message'&&event.data.source.kind==='user'?event.data:event.type==='assistant/message'?event.data.message:undefined
    if(!message)continue
    const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const images:ArtifactImage[]=message.content.flatMap((block,blockIndex)=>block.type==='image'?[{blockIndex,attachment:structuredClone(block.attachment)}]:[])
    if(!text.trim()&&!images.length)continue
    result.push({sessionId,messageId:message.id,seq:event.seq,role:event.type==='user/message'?'user':'assistant',at:new Date(event.time).toISOString(),text,images,interrupted:event.type==='assistant/message'&&event.data.interrupted===true,omittedBlocks:message.content.filter(block=>block.type!=='text'&&block.type!=='image').length})
  }
  return result
}
export function createNativeArtifactApi(ports:{binding:(id:string)=>SessionBinding;ready?:(id:string)=>Promise<void>;imageUrl:(sessionId:string,image:ArtifactImage)=>Promise<string>}):NativeArtifactApi{
  const resolve=(id:string)=>{
    const binding=ports.binding(id),state=binding.session.getSnapshot()
    if(state.removed||state.openState!=='open')throw Error('原生会话历史尚未就绪，请稍后重试。')
    return binding
  }
  return {
    async read(sessionId,beforeSeq){
      const initial=ports.binding(sessionId)
      if(initial.session.getSnapshot().openState!=='open')await ports.ready?.(sessionId)
      const binding=resolve(sessionId)
      if(binding!==initial)throw Error('会话绑定已变化，请重新打开选择器。')
      let window=binding.eventSource.getSnapshot()
      let rows=nativeArtifactMessages(sessionId,window.entries).filter(item=>beforeSeq===undefined||item.seq<beforeSeq)
      if(!rows.length&&window.hasMore){
        if(binding.session.getSnapshot().loadingOlder)throw Error('原生历史正在加载，请稍后重试。')
        const earliest=window.entries[0]?.event.seq
        await binding.session.loadOlder()
        if(resolve(sessionId)!==binding)throw Error('会话绑定已变化，请重新打开选择器。')
        window=binding.eventSource.getSnapshot()
        const nextEarliest=window.entries[0]?.event.seq
        if(window.hasMore&&(nextEarliest===undefined||(earliest!==undefined&&nextEarliest>=earliest)))throw Error('未能加载更早的原生历史，已有选择已保留，请重试。')
        rows=nativeArtifactMessages(sessionId,window.entries).filter(item=>beforeSeq===undefined||item.seq<beforeSeq)
      }
      rows.reverse()
      const items=rows.slice(0,10),hasMore=rows.length>items.length||window.hasMore
      return {sessionId,items,nextBeforeSeq:hasMore?(items.at(-1)?.seq??beforeSeq??window.entries[0]?.event.seq??0):null}
    },
    async imageUrl(message,image){
      if(!message.images.some(item=>item.blockIndex===image.blockIndex&&JSON.stringify(item.attachment)===JSON.stringify(image.attachment)))throw Error('图片不属于所选原消息。')
      const binding=resolve(message.sessionId),url=await ports.imageUrl(message.sessionId,image)
      if(resolve(message.sessionId)!==binding)throw Error('会话绑定已变化，请重新读取图片。')
      return url
    },
  }
}
