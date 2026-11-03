import type {ComposerAttachment,InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import type {DraftAttachmentStore,SavedDraftFile} from './draft-attachment-store.ts'
import {validDraftFile} from './draft-attachment-store.ts'
type Source<T>={getSnapshot:()=>T;subscribe:(listener:()=>void)=>()=>void}
type Ports={namespace:string;sessionId:string;store:DraftAttachmentStore;current:()=>boolean;reviewCurrent:()=>boolean;identity:Source<unknown>;history:Source<{entries:readonly SessionEventLikeEntry[]}>;input:Source<InputState>;session:Source<{openState:string;pendingSubmissions:readonly unknown[]}>;unknown:Source<boolean>;resolve:(ids:readonly string[])=>readonly ComposerAttachment[];create:(files:readonly File[])=>readonly ComposerAttachment[];add:(ids:readonly string[])=>boolean;release:(rows:readonly ComposerAttachment[])=>void;notice:(reason:'unavailable'|'unconfirmed'|'changed')=>void}

export type DraftAttachmentReviewRow={id:string;name:string;type:string;size:number}
export type DraftAttachmentReview={getSnapshot:()=>{files:readonly DraftAttachmentReviewRow[];enabled:boolean};subscribe:(listener:()=>void)=>()=>void;add:(id:string)=>Promise<boolean>;remove:(id:string)=>Promise<boolean>;file:(id:string)=>File|undefined}
export function createDraftAttachmentReviews(){
 let snapshot:ReadonlyMap<string,DraftAttachmentReview>=new Map()
 const listeners=new Set<()=>void>(),key=(namespace:string,sessionId:string)=>JSON.stringify([namespace,sessionId])
 return {getSnapshot:()=>snapshot,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},key,
  register(namespace:string,sessionId:string,review:DraftAttachmentReview){
   const id=key(namespace,sessionId);snapshot=new Map(snapshot).set(id,review);for(const fn of listeners)fn()
   return()=>{if(snapshot.get(id)!==review)return;const next=new Map(snapshot);next.delete(id);snapshot=next;for(const fn of listeners)fn()}
  },
 }
}

// draftRev 是原生编辑器修订号，正常 seed/hydrate 也递增；不等同本人修改。
const draftSemantics=(input:InputState)=>JSON.stringify([input.draft,input.occurrences.map(row=>({source:row.source,ref:row.ref,offset:row.offset,length:row.length,label:row.label,clipboardText:row.clipboardText,invalid:row.invalid===true}))])
const fingerprint=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')

/** File 的恢复仍经原生 createDrafts/addAttachments；纯文本、引用和发送均由原生输入拥有。 */
export function persistNativeDraftAttachments(ports:Ports){
 let disposed=false,loaded=false,scheduled=false,signature='',writes=Promise.resolve(),work=Promise.resolve(),reported=new Set<string>(),writeFailures=0
 const files=new Map<string,SavedDraftFile>(),parked=new Set<string>(),restore=new Set<string>()
 const initialSemantics=draftSemantics(ports.input.getSnapshot())
 let savedAfterSeq=-1,savedFingerprint:string|undefined,reviewBusy=false
 const reviewListeners=new Set<()=>void>()
 let reviewSnapshot:{files:readonly DraftAttachmentReviewRow[];enabled:boolean}={files:[],enabled:false}
 const events=()=>ports.history.getSnapshot().entries.flatMap(row=>row.type==='event'?[row.event]:[])
 const sequence=()=>events().reduce((last,event)=>Math.max(last,event.seq),-1)
 const valid=()=>{try{return !disposed&&ports.current()}catch{return false}}
 const notice=(reason:'unavailable'|'unconfirmed'|'changed')=>{if(valid()&&!reported.has(reason)){reported.add(reason);try{ports.notice(reason)}catch{/* 原生作用域已退休时不向另一输入投递。 */}}}
 const canAct=()=>loaded&&valid()&&ports.reviewCurrent()&&!reviewBusy&&ports.session.getSnapshot().openState==='open'&&ports.input.getSnapshot().phase==='plain'&&!ports.session.getSnapshot().pendingSubmissions.length&&!ports.unknown.getSnapshot()
 const publishReview=()=>{
  const next={files:valid()?[...files.values()].filter(row=>row.needsReview&&!row.inflight).map(row=>({id:row.id,name:row.file.name,type:row.file.type,size:row.file.size})):[],enabled:canAct()}
  if(JSON.stringify(next)===JSON.stringify(reviewSnapshot))return
  reviewSnapshot=next;for(const fn of reviewListeners)fn()
 }
 const queueWrite=()=>{
  const semantics=draftSemantics(ports.input.getSnapshot())
  const rows=[...files.values()],next=JSON.stringify([semantics,rows.map(row=>[row.id,row.inflight,row.needsReview,row.file.name,row.file.size,row.file.type,row.file.lastModified])])
  if(next===signature)return
  signature=next
  const value={namespace:ports.namespace,sessionId:ports.sessionId,afterSeq:sequence(),files:rows}
  writes=writes.then(async()=>rows.length?ports.store.write({...value,draftFingerprint:await fingerprint(semantics)}):ports.store.remove(ports.namespace,ports.sessionId)).catch(()=>{writeFailures++;signature='';notice('unavailable')})
 }
 const reconcile=async()=>{
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
   const semantics=draftSemantics(input),historySnapshot=ports.history.getSnapshot(),sessionSnapshot=ports.session.getSnapshot()
   const changed=savedFingerprint?await fingerprint(semantics)!==savedFingerprint:semantics!==initialSemantics
   // 摘要计算期间仍可能切换 owner、编辑、受理或停止；只在原快照仍有效时挂回。
   if(!valid())return
   if(ports.input.getSnapshot()!==input||ports.history.getSnapshot()!==historySnapshot||ports.session.getSnapshot()!==sessionSnapshot){update();return}
   if(changed||input.attachmentIds.length){
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
 function update(){if(!disposed&&!scheduled){scheduled=true;work=work.then(reconcile).catch(()=>{notice('unavailable')}).then(publishReview)}}
 const off=[ports.identity.subscribe(update),ports.history.subscribe(update),ports.input.subscribe(update),ports.session.subscribe(update),ports.unknown.subscribe(update)]
 const ready=ports.store.read(ports.namespace,ports.sessionId).then(saved=>{
  if(disposed)return
  savedAfterSeq=saved?.afterSeq??-1;savedFingerprint=saved?.draftFingerprint
  for(const row of saved?.files??[]){files.set(row.id,row);parked.add(row.id);if(!row.inflight&&!row.needsReview)restore.add(row.id)}
  if((saved?.files??[]).some(row=>row.needsReview))notice('changed')
  if((saved?.files??[]).some(row=>row.inflight))notice('unconfirmed')
  loaded=true;update()
 }).catch(()=>{notice('unavailable')})
 const flush=async()=>{await ready;let pending;do{pending=work;await pending}while(pending!==work);await writes}
 const act=async(id:string,add:boolean)=>{
  if(!canAct())return false
  const before={input:ports.input.getSnapshot(),session:ports.session.getSnapshot(),history:ports.history.getSnapshot()}
  const same=()=>valid()&&ports.reviewCurrent()&&ports.input.getSnapshot()===before.input&&ports.session.getSnapshot()===before.session&&ports.history.getSnapshot()===before.history&&!ports.unknown.getSnapshot()
  reviewBusy=true;publishReview()
  try{
   await flush()
   const row=files.get(id)
   if(!same()||!row?.needsReview||row.inflight){notice('changed');return false}
   if(add){
    let created:readonly ComposerAttachment[]=[]
    try{
     created=ports.create([row.file])
     if(created.length!==1||!same()||!ports.add(created.map(item=>item.id))){ports.release(created);notice('changed');return false}
    }catch{ports.release(created);notice('unavailable');return false}
    for(const item of created)files.set(item.id,{id:item.id,file:item.file,inflight:false})
   }
   const failedBefore=writeFailures
   files.delete(id);parked.delete(id);queueWrite();await writes
   if(!add&&writeFailures!==failedBefore){files.set(id,row);parked.add(id);signature='';return false}
   return true
  }finally{reviewBusy=false;publishReview();update()}
 }
 const review:DraftAttachmentReview={getSnapshot:()=>reviewSnapshot,subscribe:fn=>{reviewListeners.add(fn);return()=>{reviewListeners.delete(fn)}},add:id=>act(id,true),remove:id=>act(id,false),file:id=>{const row=files.get(id);return canAct()&&row?.needsReview&&!row.inflight?row.file:undefined}}
 return {ready,flush,review,dispose:()=>{if(disposed)return;disposed=true;for(const stop of off)stop();publishReview()}}
}
