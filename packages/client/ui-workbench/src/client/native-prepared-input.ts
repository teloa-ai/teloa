import {encodeResourceReference} from '@teloa/contract'
import type {InputState,InsertTextRequest,InsertReferenceRequest} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {PreparedInputPort,PreparedInputSnapshot} from './prompt-preparation.ts'

type Target={state:{getSnapshot:()=>InputState;subscribe:(listener:()=>void)=>()=>void};running:boolean;text:(request:InsertTextRequest)=>true|undefined;reference:(request:InsertReferenceRequest)=>true|undefined}
/** 仅使用公开会话事件和输入快照，不直接访问原生编辑器。 */
export function nativePreparedInput(resolve:()=>Target):PreparedInputPort{
 const read=():PreparedInputSnapshot=>{const target=resolve();return {...target.state.getSnapshot(),running:target.running}}
 const write=(revision:number,apply:(target:Target,snapshot:InputState)=>true|undefined,verify:(snapshot:InputState)=>boolean)=>new Promise<PreparedInputSnapshot>((accept,reject)=>{
  const target=resolve(),before=target.state.getSnapshot()
  if(target.running||before.phase!=='plain'||before.attachmentIds.length||before.draftRev!==revision){reject(Error('原生输入已变化，未继续带入。'));return}
  let applied=false,settled=false,off=()=>{}
  const finish=(error?:Error,snapshot?:PreparedInputSnapshot)=>{if(settled)return;settled=true;off();clearTimeout(timer);if(error)reject(error);else accept(snapshot!)}
  const check=()=>{
   if(!applied||settled)return
   try{const current=resolve(),snapshot=current.state.getSnapshot();if(snapshot.draftRev<=revision)return
    if(current.running||snapshot.phase!=='plain'||snapshot.draftRev!==revision+1||!verify(snapshot))throw Error('输入在带入期间发生变化，请核对已带入内容。')
    finish(undefined,{...snapshot,running:current.running})
   }catch(error){finish(error instanceof Error?error:Error('无法核对原生输入。'))}
  }
  const timer=setTimeout(()=>finish(Error('原生输入框尚未确认收到内容，请核对输入框后继续。')),3000)
  off=target.state.subscribe(check)
  try{applied=apply(target,before)===true;if(!applied)finish(Error('原生输入拒绝本次带入，已保留待完成资料。'));else check()}catch(error){finish(error instanceof Error?error:Error('无法带入原生输入。'))}
 })
 return {read,
  text:(text,revision)=>write(revision,(target,snapshot)=>target.text({text,span:{start:0,end:0,draftRev:revision}}),snapshot=>snapshot.draft===text),
  // 输入事件使用检测坐标；引用出现后与剪贴板文本长度不同。统一插在开头，避免推算原生坐标。
  reference:(resource,revision)=>{const ref=encodeResourceReference(resource);return write(revision,(target,snapshot)=>target.reference({reference:{source:'teloa-resources',ref,label:resource.title,appearance:'file',clipboardText:ref},span:{start:0,end:0,draftRev:revision}}),snapshot=>snapshot.occurrences.some(row=>row.source==='teloa-resources'&&row.ref===ref&&!row.invalid))},
 }
}
