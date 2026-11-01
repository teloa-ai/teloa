import type {ComposerAttachment,InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import type {DraftAttachmentStore,SavedDraftFile} from './draft-attachment-store.ts'
import {validDraftFile} from './draft-attachment-store.ts'
type Source<T>={getSnapshot:()=>T;subscribe:(listener:()=>void)=>()=>void}
type Ports={namespace:string;sessionId:string;store:DraftAttachmentStore;current:()=>boolean;identity:Source<unknown>;history:Source<{entries:readonly SessionEventLikeEntry[]}>;input:Source<InputState>;session:Source<{openState:string;pendingSubmissions:readonly unknown[]}>;unknown:Source<boolean>;resolve:(ids:readonly string[])=>readonly ComposerAttachment[];create:(files:readonly File[])=>readonly ComposerAttachment[];add:(ids:readonly string[])=>boolean;release:(rows:readonly ComposerAttachment[])=>void;notice:(reason:'unavailable'|'unconfirmed'|'changed')=>void}

/** File 的恢复仍经原生 createDrafts/addAttachments；纯文本、引用和发送均由原生输入拥有。 */
export function persistNativeDraftAttachments(ports:Ports){
 let disposed=false,loaded=false,scheduled=false,signature='',writes=Promise.resolve(),reported=false
 const files=new Map<string,SavedDraftFile>(),parked=new Set<string>(),restore=new Set<string>()
 const initialRevision=ports.input.getSnapshot().draftRev
 let savedAfterSeq=-1
 const events=()=>ports.history.getSnapshot().entries.flatMap(row=>row.type==='event'?[row.event]:[])
 const sequence=()=>events().reduce((last,event)=>Math.max(last,event.seq),-1)
 const valid=()=>{try{return !disposed&&ports.current()}catch{return false}}
 const notice=(reason:'unavailable'|'unconfirmed'|'changed')=>{if(valid()&&!reported){reported=true;try{ports.notice(reason)}catch{/* 原生作用域已退休时不向另一输入投递。 */}}}
 const queueWrite=()=>{
  const rows=[...files.values()],next=JSON.stringify(rows.map(row=>[row.id,row.inflight,row.needsReview,row.file.name,row.file.size,row.file.type,row.file.lastModified]))
  if(next===signature)return
  signature=next
  const value={namespace:ports.namespace,sessionId:ports.sessionId,afterSeq:sequence(),files:rows}
  writes=writes.then(()=>rows.length?ports.store.write(value):ports.store.remove(ports.namespace,ports.sessionId)).catch(()=>{signature='';notice('unavailable')})
 }
 const reconcile=()=>{
  scheduled=false
  if(!loaded||!valid()||ports.session.getSnapshot().openState!=='open')return
  let input=ports.input.getSnapshot()
  if(restore.size){
   const history=events()
   if(history.some(event=>event.seq>savedAfterSeq&&(event.type==='user/message'||event.type==='agent/inbox/spliced'&&event.data.inserted.length>0))){
    // 入队已受理而本页尚未来得及清 IndexedDB 的崩溃窗口，不把旧副本当未发送草稿重挂。
    for(const id of restore)files.set(id,{...files.get(id)!,inflight:true})
    restore.clear();notice('unconfirmed');queueWrite();return
   }
   if(sequence()<savedAfterSeq)return
   if(input.draftRev!==initialRevision||input.attachmentIds.length){
    // 旧副本留待核对；放弃本次自动恢复不应阻止保存本人后来新选的 File。
    for(const id of restore)files.set(id,{...files.get(id)!,needsReview:true})
    restore.clear();notice('changed')
   }else{
   if(input.phase!=='plain'||ports.session.getSnapshot().pendingSubmissions.length||ports.unknown.getSnapshot()){notice('unconfirmed');return}
   const saved=[...restore].map(id=>files.get(id)!)
   let created:readonly ComposerAttachment[]=[]
   try{
    created=ports.create(saved.map(row=>row.file))
    if(created.length!==saved.length||!valid()||!ports.add(created.map(row=>row.id))){ports.release(created);notice('changed');return}
   }catch{ports.release(created);notice('unavailable');return}
   for(const id of restore){files.delete(id);parked.delete(id)}
   restore.clear()
   for(const row of created)files.set(row.id,{id:row.id,file:row.file,inflight:false})
   input=ports.input.getSnapshot()
   }
  }
  const selected=new Set<string>(input.attachmentIds),resolved=ports.resolve(input.attachmentIds)
  if(resolved.length!==selected.size||resolved.some(row=>!validDraftFile(row.file))){notice('unavailable');return}
  for(const row of resolved)files.set(row.id,{id:row.id,file:row.file,inflight:false})
  for(const [id,row]of files){
   if(selected.has(id)||parked.has(id))continue
   // 默认发送会先清 editor，再序列化。registry 仍持有对象时保留 File，不能误当已消费。
   // 只有原生已接受并释放，或本人明确删除并释放的对象才从同代持久记录移除。
   if(ports.resolve([id]).length)files.set(id,{...row,inflight:true})
   else files.delete(id)
  }
  queueWrite()
 }
 function update(){if(!disposed&&!scheduled){scheduled=true;queueMicrotask(()=>{try{reconcile()}catch{notice('unavailable')}})}}
 const off=[ports.identity.subscribe(update),ports.history.subscribe(update),ports.input.subscribe(update),ports.session.subscribe(update),ports.unknown.subscribe(update)]
 const ready=ports.store.read(ports.namespace,ports.sessionId).then(saved=>{
  if(disposed)return
  savedAfterSeq=saved?.afterSeq??-1
  for(const row of saved?.files??[]){files.set(row.id,row);parked.add(row.id);if(!row.inflight&&!row.needsReview)restore.add(row.id)}
  if((saved?.files??[]).some(row=>row.needsReview))notice('changed')
  if((saved?.files??[]).some(row=>row.inflight))notice('unconfirmed')
  loaded=true;update()
 }).catch(()=>{notice('unavailable')})
 return {ready,flush:async()=>{await ready;await Promise.resolve();await writes},dispose:()=>{if(disposed)return;disposed=true;for(const stop of off)stop()}}
}
