import test from 'node:test'
import assert from 'node:assert/strict'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {InputState,ComposerAttachment,DraftAttachmentId} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {persistNativeDraftAttachments} from '../src/client/native-draft-attachments.ts'
import {validDraftFile,type DraftAttachmentStore,type SavedDraftAttachments} from '../src/client/draft-attachment-store.ts'
function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},set(next:T){value=next;for(const fn of [...listeners])fn()}}}
const empty=():InputState=>({draft:'原生文字草稿',draftRev:0,attachmentIds:[],occurrences:[],queue:[],phase:'plain'})
function fixture(saved:SavedDraftAttachments|null=null,read?:()=>Promise<SavedDraftAttachments|null>,write?:(value:SavedDraftAttachments)=>Promise<void>,initial:InputState=empty()){
 const rows=new Map<string,SavedDraftAttachments>();if(saved)rows.set(JSON.stringify([saved.namespace,saved.sessionId]),saved)
 const key=(n:string,s:string)=>JSON.stringify([n,s]),store:DraftAttachmentStore={read:read??(async(n,s)=>rows.get(key(n,s))??null),write:write??(async row=>{rows.set(key(row.namespace,row.sessionId),row)}),remove:async(n,s)=>{rows.delete(key(n,s))}}
 const input=source(initial),session=source({openState:'open',pendingSubmissions:[] as unknown[]}),unknown=source(false),currentSession=source('A'),identity=source('owner-A'),history=source({entries:[] as any[]})
 const registry=new Map<string,ComposerAttachment>(),notices:string[]=[],created:File[]=[];let count=0
 const put=(id:string,file:File)=>{registry.set(id,{kind:'file',id,file} as ComposerAttachment);return brandString<DraftAttachmentId>(id)}
 const coordinator=persistNativeDraftAttachments({namespace:'owner-A',sessionId:'A',store,current:()=>identity.getSnapshot()==='owner-A',reviewCurrent:()=>currentSession.getSnapshot()==='A',identity,history,input,session,unknown,
  resolve:ids=>ids.flatMap(id=>registry.has(id)?[registry.get(id)!]:[]),create:files=>files.map(file=>{created.push(file);const id=put('restored-'+ ++count,file);return registry.get(id)!}),add:ids=>{input.set({...input.getSnapshot(),attachmentIds:[...input.getSnapshot().attachmentIds,...ids.map(id=>brandString<DraftAttachmentId>(id))]});return true},release:items=>{for(const row of items)registry.delete(row.id)},notice:reason=>{notices.push(reason)}})
 return {coordinator,input,session,unknown,currentSession,identity,history,registry,notices,created,put,rows,read:()=>rows.get(key('owner-A','A'))}
}
const file=()=>new File(['new synthetic attachment\n'],'keep.txt',{type:'text/plain',lastModified:1234})
const saved=(inflight=false):SavedDraftAttachments=>({namespace:'owner-A',sessionId:'A',afterSeq:-1,files:[{id:'old-file',file:file(),inflight}]})
test('正常reload以原File恢复同owner/SID附件，文字不覆盖、不发送；换新runtime id',async()=>{
 const f=fixture(saved());await f.coordinator.flush()
 assert.equal(f.created.length,1);assert.equal(await f.created[0]!.text(),'new synthetic attachment\n')
 assert.equal(f.input.getSnapshot().draft,'原生文字草稿');assert.deepEqual(f.input.getSnapshot().attachmentIds,['restored-1']);assert.equal(f.read()?.files[0]?.inflight,false);f.coordinator.dispose()
})
test('明确删除立即清同项；原生受理并释放后清已消费附件',async()=>{
 for(const accepted of [false,true]){
  const f=fixture();await f.coordinator.ready
  f.put('a',file());f.input.set({...empty(),attachmentIds:['a'] as any});await f.coordinator.flush();assert.equal(f.read()?.files.length,1)
  if(accepted)f.session.set({openState:'open',pendingSubmissions:[{}]})
  f.input.set(empty());f.registry.delete('a');f.session.set({openState:'open',pendingSubmissions:[]});await f.coordinator.flush();assert.equal(f.read(),undefined);f.coordinator.dispose()
 }
})
test('乐观清空/序列化中仍保留File；发送失败或取消恢复原draft对象',async()=>{
 const f=fixture();await f.coordinator.ready;f.put('a',file());f.input.set({...empty(),attachmentIds:['a'] as any});await f.coordinator.flush()
 f.input.set(empty());f.session.set({openState:'open',pendingSubmissions:[{}]});await f.coordinator.flush();assert.equal(f.read()?.files[0]?.inflight,true)
 f.session.set({openState:'open',pendingSubmissions:[]});f.input.set({...empty(),attachmentIds:['a'] as any});await f.coordinator.flush();assert.equal(f.read()?.files[0]?.inflight,false);f.coordinator.dispose()
})
test('刷新遇inflight或unknown只保全，不自动重挂或发送',async()=>{
 const a=fixture(saved(true));await a.coordinator.flush();assert.equal(a.created.length,0);assert.equal(a.read()?.files.length,1);assert.ok(a.notices.includes('unconfirmed'));a.coordinator.dispose()
 const b=fixture(saved());b.unknown.set(true);await b.coordinator.flush();assert.equal(b.created.length,0);assert.equal(b.read()?.files.length,1);b.coordinator.dispose()
})
test('已受理输入晚于保存水位：崩溃后不把已发送附件当草稿重复挂入',async()=>{
 const f=fixture(saved());f.history.set({entries:[{type:'event',event:{type:'user/message',seq:2,data:{source:{kind:'user'}}}}]});await f.coordinator.flush();assert.equal(f.created.length,0);assert.equal(f.read()?.files[0]?.inflight,true);assert.ok(f.notices.includes('unconfirmed'));f.coordinator.dispose()
})
test('晚到读取不覆盖新输入、切换身份或已销毁binding',async()=>{
 for(const mode of ['edit','identity','dispose'] as const){
  let done!:(row:SavedDraftAttachments)=>void;const f=fixture(null,()=>new Promise(resolve=>{done=resolve}))
  if(mode==='edit')f.input.set({...empty(),draft:'后来编辑',draftRev:1})
  if(mode==='identity')f.identity.set('owner-B')
  if(mode==='dispose')f.coordinator.dispose()
  done(saved());await f.coordinator.flush();assert.equal(f.created.length,0);assert.equal(f.input.getSnapshot().attachmentIds.length,0);f.coordinator.dispose()
 }
})
test('晚到旧附件只留待核对；当前新File确实保存，reload不把旧File混回',async()=>{
 let done!:(row:SavedDraftAttachments)=>void
 const f=fixture(null,()=>new Promise(resolve=>{done=resolve}))
 const newer=new File(['current synthetic file'],'new.txt',{type:'text/plain',lastModified:4321})
 f.input.set({...empty(),draft:'新编辑',draftRev:1,attachmentIds:[f.put('new-id',newer)]})
 done(saved());await f.coordinator.flush()
 const stored=f.read()!
 assert.equal(f.created.length,0);assert.equal(f.input.getSnapshot().draft,'新编辑')
 assert.equal(stored.files.find(row=>row.id==='old-file')?.needsReview,true)
 assert.equal(stored.files.find(row=>row.id==='old-file')?.inflight,false)
 const current=stored.files.find(row=>row.id==='new-id')!
 assert.equal(await current.file.text(),'current synthetic file');assert.equal(current.file.lastModified,4321)
 f.coordinator.dispose()
 // 正常原生 reload 也恢复本人刚才的文字草稿。
 const reload=fixture(stored,undefined,undefined,{...empty(),draft:'新编辑'});await reload.coordinator.flush()
 assert.deepEqual(reload.created.map(row=>row.name),['new.txt'])
 assert.equal(await reload.created[0]!.text(),'current synthetic file')
 assert.equal(reload.read()?.files.find(row=>row.id==='old-file')?.needsReview,true)
 assert.ok(reload.notices.includes('changed'));reload.coordinator.dispose()
})
test('迟到读取遇纯文字编辑后仍可继续保存后来选择的File',async()=>{
 let done!:(row:SavedDraftAttachments)=>void
 const f=fixture(null,()=>new Promise(resolve=>{done=resolve}))
 f.input.set({...empty(),draft:'后来编辑',draftRev:1});done(saved());await f.coordinator.flush()
 assert.equal(f.read()?.files[0]?.needsReview,true);assert.equal(f.created.length,0)
 f.input.set({...f.input.getSnapshot(),draftRev:2,attachmentIds:[f.put('later',file())]});await f.coordinator.flush()
 assert.ok(f.read()?.files.some(row=>row.id==='later'&&!row.needsReview))
 assert.equal(await f.read()!.files.find(row=>row.id==='later')!.file.text(),'new synthetic attachment\n')
 assert.equal(f.input.getSnapshot().draft,'后来编辑');f.coordinator.dispose()
})
test('needsReview显式阻止自动恢复，旧无标志或false记录保持可恢复',async()=>{
 for(const review of [undefined,false,true]){
  const row=saved();if(review!==undefined)row.files[0]!.needsReview=review
  const f=fixture(row);await f.coordinator.flush()
  assert.equal(f.created.length,review===true?0:1)
  if(review===true){assert.equal(f.read()?.files[0]?.needsReview,true);assert.ok(f.notices.includes('changed'))}
  f.coordinator.dispose()
 }
})
test('另一owner/SID缓存不暴露；文件名/类型/大小使用真实File对象校验',async()=>{
 for(const row of [{...saved(),namespace:'owner-B'},{...saved(),sessionId:'B'}]){const f=fixture(row);await f.coordinator.flush();assert.equal(f.created.length,0);f.coordinator.dispose()}
 assert.ok(validDraftFile(file()));assert.equal(validDraftFile(new File(['x'],'../secret.txt')),false);assert.equal(validDraftFile(new File(['x'],'keep.txt',{type:'not-a-mime'})),false);assert.equal(validDraftFile({name:'fake',size:1,type:'text/plain'}),false)
})
test('存储失败明确通知，File仍由原生registry持有，不伪称已持久化',async()=>{
 const f=fixture(null,async()=>{throw Error('storage unavailable')});await f.coordinator.flush();assert.ok(f.notices.includes('unavailable'));f.coordinator.dispose()
 const writing=fixture(null,undefined,async()=>{throw Error('quota')});await writing.coordinator.ready;writing.put('keep',file());writing.input.set({...empty(),attachmentIds:['keep'] as any});await writing.coordinator.flush();assert.ok(writing.notices.includes('unavailable'));assert.ok(writing.registry.has('keep'));assert.equal(writing.read(),undefined);writing.coordinator.dispose()
})
test('删除部分附件不清除其他文件；文字变更同步语义水位，重复快照不重复保存 File',async()=>{
 let writes=0;const f=fixture(null,undefined,async()=>{writes++});await f.coordinator.ready
 f.put('a',file());f.put('b',file());f.input.set({...empty(),attachmentIds:['a','b'] as any});await f.coordinator.flush();assert.equal(writes,1)
 f.input.set({...f.input.getSnapshot(),draft:'只改文字',draftRev:1});await f.coordinator.flush();assert.equal(writes,2)
 f.input.set({...f.input.getSnapshot()});await f.coordinator.flush();assert.equal(writes,2)
 f.input.set({...f.input.getSnapshot(),attachmentIds:['b'] as any});f.registry.delete('a');await f.coordinator.flush();assert.equal(writes,3);assert.ok(f.registry.has('b'));f.coordinator.dispose()
})

async function recordedDraft(){
 const f=fixture();await f.coordinator.ready
 f.input.set({...empty(),attachmentIds:[f.put('selected',file())]})
 await f.coordinator.flush();const row=f.read()!;f.coordinator.dispose();return row
}
test('正常native hydrate只改变draftRev：旧缓存同语义仍恢复，绝不标needsReview',async()=>{
 let done!:(row:SavedDraftAttachments)=>void
 const f=fixture(null,()=>new Promise(resolve=>{done=resolve}))
 f.input.set({...empty(),draftRev:3})
 done(saved());await f.coordinator.flush()
 assert.equal(f.created.length,1);assert.equal(f.read()?.files[0]?.needsReview,undefined)
 assert.equal(await f.created[0]!.text(),await file().text());f.coordinator.dispose()
})
test('新保存的语义水位允许冷载入文字；迟到真实编辑仍留旧File待核对',async()=>{
 const row=await recordedDraft()
 for(const edited of [false,true]){
  let done!:(row:SavedDraftAttachments)=>void
  const f=fixture(null,()=>new Promise(resolve=>{done=resolve}),undefined,{...empty(),draft:''})
  // 原生持久草稿载入会递增编辑器修订号；它不是用户编辑来源。
  f.input.set({...empty(),draftRev:4,draft:edited?'真正后来编辑':'原生文字草稿'})
  done(row);await f.coordinator.flush()
  assert.equal(f.created.length,edited?0:1)
  assert.equal(f.read()?.files.some(item=>item.needsReview),edited)
  assert.equal(f.input.getSnapshot().draft,edited?'真正后来编辑':'原生文字草稿');f.coordinator.dispose()
 }
})

test('引用runtime编号变化不误判编辑；同文字但真实引用目标变化必须待核对',async()=>{
 const occurrence={occurrenceId:1,source:'synthetic-reference',ref:'owned-A',offset:0,length:7,label:'本人资料',clipboardText:'原生文字草稿'}
 const original=fixture();await original.coordinator.ready
 original.input.set({...empty(),occurrences:[occurrence],attachmentIds:[original.put('selected',file())]})
 await original.coordinator.flush();const row=original.read()!;original.coordinator.dispose()
 for(const ref of ['owned-A','owned-B']){
  let done!:(row:SavedDraftAttachments)=>void
  const f=fixture(null,()=>new Promise(resolve=>{done=resolve}),undefined,{...empty(),draft:''})
  f.input.set({...empty(),draftRev:6,occurrences:[{...occurrence,occurrenceId:9,ref}]})
  done(row);await f.coordinator.flush()
  assert.equal(f.created.length,ref==='owned-A'?1:0)
  assert.equal(f.read()?.files.some(item=>item.needsReview),ref!=='owned-A');f.coordinator.dispose()
 }
})

test('真实异步摘要期间新的编辑或owner撤回先发生，不按旧快照恢复',async()=>{
 const row=await recordedDraft()
 for(const change of ['edit','owner'] as const){
  const f=fixture(row);await f.coordinator.ready;await Promise.resolve()
  assert.equal(f.created.length,0)
  if(change==='edit')f.input.set({...empty(),draft:'摘要计算时本人编辑',draftRev:1})
  else f.identity.set('owner-B')
  await f.coordinator.flush();assert.equal(f.created.length,0)
  if(change==='edit')assert.equal(f.read()?.files[0]?.needsReview,true)
  f.coordinator.dispose()
 }
})

test('本人逐项确认旧File才加入原生草稿，保留当前File与文字；从不自动创建或发送',async()=>{
 const row=saved();row.files[0]!.needsReview=true
 const f=fixture(row);await f.coordinator.flush()
 assert.equal(f.created.length,0);assert.equal(f.coordinator.review.getSnapshot().files[0]?.name,'keep.txt')
 assert.equal(await f.coordinator.review.file('old-file')!.text(),await file().text())
 const current=new File(['本人新File'],'current.ts',{type:'text/plain',lastModified:55})
 const id=f.put('current',current);f.input.set({...empty(),attachmentIds:[id]});await f.coordinator.flush()
 assert.equal(await f.coordinator.review.add('old-file'),true)
 await f.coordinator.flush()
 assert.equal(f.created.length,1);assert.deepEqual(f.input.getSnapshot().attachmentIds,['current','restored-1'])
 assert.equal(f.input.getSnapshot().draft,'原生文字草稿');assert.equal(f.coordinator.review.getSnapshot().files.length,0)
 assert.equal(f.read()?.files.length,2);assert.equal(await f.coordinator.review.add('old-file'),false)
 assert.equal(f.created.length,1);f.coordinator.dispose()
})
test('移除待核对副本不调用原生create/add；关闭列表等只读操作不消耗File',async()=>{
 const row=saved();row.files[0]!.needsReview=true
 const f=fixture(row);await f.coordinator.flush()
 f.coordinator.review.getSnapshot();f.coordinator.review.getSnapshot()
 assert.equal(f.read()?.files.length,1);assert.equal(f.created.length,0)
 assert.equal(await f.coordinator.review.remove('old-file'),true);await f.coordinator.flush()
 assert.equal(f.created.length,0);assert.equal(f.read(),undefined);assert.equal(f.input.getSnapshot().attachmentIds.length,0);f.coordinator.dispose()
})
test('确认动作异步等待期间编辑/切owner/进入发送不加入旧File；unknown亦不可确认',async()=>{
 for(const change of ['edit','owner','sid','phase','unknown'] as const){
  const row=saved();row.files[0]!.needsReview=true
  const f=fixture(row);await f.coordinator.flush()
  const action=f.coordinator.review.add('old-file')
  if(change==='edit')f.input.set({...empty(),draft:'按钮点击后本人编辑',draftRev:1})
  if(change==='owner')f.identity.set('owner-B')
  if(change==='sid')f.currentSession.set('B')
  if(change==='phase')f.session.set({openState:'open',pendingSubmissions:[{}]})
  if(change==='unknown')f.unknown.set(true)
  assert.equal(await action,false);await f.coordinator.flush();assert.equal(f.created.length,0)
  assert.equal(f.input.getSnapshot().attachmentIds.length,0);assert.equal(f.read()?.files[0]?.needsReview,true);f.coordinator.dispose()
 }
})

test('移除保存失败仍保留可取原File，不伪称已删除；本人可稍后重试',async()=>{
 const row=saved();row.files[0]!.needsReview=true;row.files.push({...row.files[0]!,id:'another-old-file'})
 const f=fixture(row,undefined,async()=>{throw Error('本轮合成存储失败')});await f.coordinator.flush()
 assert.equal(await f.coordinator.review.remove('old-file'),false)
 assert.equal(f.coordinator.review.getSnapshot().files.length,2)
 assert.equal(await f.coordinator.review.file('old-file')!.text(),await file().text())
 assert.ok(f.notices.includes('unavailable'));f.coordinator.dispose()
})
