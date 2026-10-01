import type { SessionEvent,UserMessage } from '@deepseek-ai/dsh-session'
import { WorkError,type ResourceFailure,type ResourceRecoveryPage } from '@teloa/contract'

// 日志由 DSH 的持久边界验证；本投影只还原入队事实，不写入任何原生事件。
export function recoveryPage(sessionId:string,events:readonly SessionEvent[],beforeSeq?:number,inheritedEventCount=0):ResourceRecoveryPage{
  const pending:{'next-turn':UserMessage[];'next-step':UserMessage[]}={'next-turn':[],'next-step':[]}
  const failures:ResourceFailure[]=[]
  let turn:number|undefined
  const claimed=new Map<string,UserMessage>()
  for(const event of events.slice(inheritedEventCount)){
    if(event.type==='turn/start'){turn=event.data.turn;claimed.clear()}
    else if(event.type==='agent/inbox/spliced'){
      const {target,start,removedCount=0,inserted,outcome}=event.data,queue=pending[target]
      if(!queue||start<0||start>queue.length||removedCount<0||start+removedCount>queue.length)throw new WorkError('teloa/storage-corrupt','原生队列历史不完整，无法安全恢复请求。')
      const removed=queue.splice(start,removedCount,...inserted)
      if(turn!==undefined&&outcome!=='canceled')for(const message of removed)claimed.set(message.id,message)
    }else if(event.type==='user/message')claimed.delete(event.data.id)
    else if(event.type==='turn/end'){
      const reason=event.data.reason
      if(turn===event.data.turn&&reason.kind==='error'&&reason.error.code.startsWith('teloa/resources/')&&(beforeSeq===undefined||event.seq<beforeSeq)){
        const messages=[...claimed.values()].filter(message=>message.source.kind==='user').map(message=>({id:message.id,text:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),otherContentCount:message.content.filter(block=>block.type!=='text').length}))
        if(messages.length)failures.push({endSeq:event.seq,turn,at:new Date(event.time).toISOString(),code:reason.error.code,reason:reason.error.message,messages})
      }
      turn=undefined;claimed.clear()
    }
  }
  failures.reverse()
  const page=failures.slice(0,10)
  return {sessionId,failures:page,nextBeforeSeq:failures.length>10?page.at(-1)!.endSeq:null}
}
