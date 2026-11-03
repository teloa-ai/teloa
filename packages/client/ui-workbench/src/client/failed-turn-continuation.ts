import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'

export type FailedRequest={failureSeq:number;turn:number;messageSeq:number;messageId:string;requestId:string;text:string}
export type ContinuationFacts={owner:string|null;binding:object;current:boolean;ready:boolean;blocked:boolean;running:boolean;pending:boolean;unknown:boolean;editable:boolean;empty:boolean;entries:readonly SessionEventLikeEntry[]}
export type FailedTurnContinuation={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>string;available:(seq:number)=>boolean;continue:(seq:number)=>Promise<void>}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** 只认本人已实际受理的原始纯文本；附件、多内容块或未知来源不能被静默删去后重提。 */
function originalText(event:Extract<SessionEventLikeEntry,{type:'event'}>['event']):{messageId:string;requestId:string;text:string}|undefined{
 if(event.type!=='user/message')return
 const {source,content,id}=event.data
 if(source.kind!=='user'||!('rpcId'in source)||typeof source.rpcId!=='string'||!uuid.test(source.rpcId)||'principal'in source||!uuid.test(id)||content.length!==1)return
 const part=content[0]
 // 正常 SessionInput 的默认 sink 会 trim；无法原样重提的文本不给动作，不能静默改写原文。
 if(!part||part.type!=='text'||Object.keys(part).some(key=>key!=='type'&&key!=='text')||!part.text.trim()||part.text!==part.text.trim()||part.text.startsWith('/'))return
 return {messageId:id,requestId:source.rpcId,text:part.text}
}

/** 本轮已知错误、唯一原本人请求且没有工具动作；原失败记录从不替换或删除。 */
export function latestRetryableRequest(entries:readonly SessionEventLikeEntry[]):FailedRequest|undefined{
 const events=entries.flatMap(row=>row.type==='event'?[row.event]:[])
 let end=-1
 for(let i=0;i<events.length;i++)if(events[i]?.type==='turn/end')end=i
 const failure=events[end]
 if(!failure||failure.type!=='turn/end'||failure.data.reason.kind!=='error')return
 if(events.slice(end+1).some(event=>event.type==='turn/start'||event.type==='step/start'||event.type==='user/message'||event.type==='agent/inbox/spliced'&&event.data.inserted.length>0))return
 let start=-1
 for(let i=0;i<end;i++){const event=events[i];if(event?.type==='turn/start'&&event.data.turn===failure.data.turn)start=i}
 if(start<0)return
 const turn=events.slice(start,end)
 if(turn.some(event=>event.type.startsWith('tool/'))||!turn.some(event=>event.type==='step/start'&&event.data.turn===failure.data.turn))return
 const users=turn.filter(event=>event.type==='user/message'&&event.data.source.kind==='user')
 if(users.length!==1)return
 const original=users[0]!,text=originalText(original)
 return text?{failureSeq:failure.seq,turn:failure.data.turn,messageSeq:original.seq,...text}:undefined
}
export function latestContinuableFailure(entries:readonly SessionEventLikeEntry[]):number|undefined{return latestRetryableRequest(entries)?.failureSeq}

export function createFailedTurnContinuation(ports:{read:()=>ContinuationFacts;subscribe:(listener:()=>void)=>()=>void;eligible:()=>Promise<string|undefined>;send:(text:string,request:FailedRequest)=>void}):FailedTurnContinuation{
 let pending=false
 const attempted=new Set<string>(),listeners=new Set<()=>void>(),notify=()=>{for(const listener of listeners)listener()}
 const candidate=()=>{
  try{const f=ports.read()
   if(pending||!f.owner||!f.current||!f.ready||f.blocked||f.running||f.pending||f.unknown||!f.editable||!f.empty)return
   const request=latestRetryableRequest(f.entries)
   return request&&!attempted.has(request.requestId)?request:undefined
  }catch{return undefined}
 }
 return {
  subscribe:listener=>{listeners.add(listener);const off=ports.subscribe(listener);return()=>{listeners.delete(listener);off()}},
  getSnapshot:()=>String(candidate()?.failureSeq??''),available:seq=>candidate()?.failureSeq===seq,
  async continue(seq){
   const original=candidate()
   if(original?.failureSeq!==seq)throw Error('原失败或当前输入已变化，未重试。')
   const before=ports.read();pending=true;notify()
   try{
    const identity=await ports.eligible()
    if(identity===undefined||await ports.eligible()!==identity)throw Error('原会话业务或权限已变化，未重试。')
    pending=false
    const current=ports.read(),latest=candidate()
    if(current.binding!==before.binding||current.owner!==before.owner||!latest||JSON.stringify(latest)!==JSON.stringify(original))throw Error('会话、原请求或草稿已变化，未重试。')
    // 从这一刻起结果可能未知：正常输入机负责序列化/准入，不再用此动作重发旧身份。
    pending=true;attempted.add(original.requestId)
    ports.send(original.text,original)
   }finally{pending=false;notify()}
  },
 }
}
