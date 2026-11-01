import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'

export type ContinuationFacts={owner:string|null;binding:object;current:boolean;ready:boolean;blocked:boolean;running:boolean;pending:boolean;unknown:boolean;editable:boolean;empty:boolean;entries:readonly SessionEventLikeEntry[]}
export type FailedTurnContinuation={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>string;available:(seq:number)=>boolean;continue:(seq:number,text:string)=>Promise<void>}

/** 只续办最新的、尚未发生工具动作的已知失败；不重放原输入或 provider request。 */
export function latestContinuableFailure(entries:readonly SessionEventLikeEntry[]):number|undefined{
 const events=entries.flatMap(row=>row.type==='event'?[row.event]:[])
 let end=-1
 for(let i=0;i<events.length;i++)if(events[i]?.type==='turn/end')end=i
 const failure=events[end]
 if(!failure||failure.type!=='turn/end'||failure.data.reason.kind!=='error')return
 if(events.slice(end+1).some(event=>event.type==='turn/start'||event.type==='step/start'||event.type==='user/message'||event.type==='agent/inbox/spliced'&&event.data.inserted.length>0))return
 let start=-1
 for(let i=0;i<end;i++){const event=events[i];if(event?.type==='turn/start'&&event.data.turn===failure.data.turn)start=i}
 if(start<0||events.slice(start,end).some(event=>event.type.startsWith('tool/')))return
 return failure.seq
}

export function createFailedTurnContinuation(ports:{read:()=>ContinuationFacts;subscribe:(listener:()=>void)=>()=>void;eligible:()=>Promise<boolean>;send:(text:string)=>void}):FailedTurnContinuation{
 let pending=false
 const listeners=new Set<()=>void>(),notify=()=>{for(const listener of listeners)listener()}
 const candidate=()=>{
  try{const f=ports.read()
   return !pending&&f.owner&&f.current&&f.ready&&!f.blocked&&!f.running&&!f.pending&&!f.unknown&&f.editable&&f.empty?latestContinuableFailure(f.entries):undefined
  }catch{return undefined}
 }
 return {
  subscribe:listener=>{listeners.add(listener);const off=ports.subscribe(listener);return()=>{listeners.delete(listener);off()}},
  getSnapshot:()=>String(candidate()??''),available:seq=>candidate()===seq,
  async continue(seq,text){
   if(candidate()!==seq)throw Error('原失败或当前输入已变化，未继续发送。')
   const before=ports.read();pending=true;notify()
   try{
    if(!await ports.eligible())throw Error('此会话不属于可继续的本人普通工作。')
    // 远程身份核对期间允许切换/编辑，但迟到结果不能向新作用域发送。
    pending=false
    const current=ports.read()
    if(current.binding!==before.binding||current.owner!==before.owner||candidate()!==seq)throw Error('会话或草稿已变化，未继续发送。')
    pending=true
    ports.send(text)
   }finally{pending=false;notify()}
  },
 }
}
