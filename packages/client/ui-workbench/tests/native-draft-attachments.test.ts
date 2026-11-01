import test from 'node:test'
import assert from 'node:assert/strict'
import type {InputState,ComposerAttachment} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {persistNativeDraftAttachments} from '../src/client/native-draft-attachments.ts'
import {validDraftFile,type DraftAttachmentStore,type SavedDraftAttachments} from '../src/client/draft-attachment-store.ts'
function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},set(next:T){value=next;for(const fn of [...listeners])fn()}}}
const empty=():InputState=>({draft:'原生文字草稿',draftRev:0,attachmentIds:[],occurrences:[],queue:[],phase:'plain'})
function fixture(saved:SavedDraftAttachments|null=null,read?:()=>Promise<SavedDraftAttachments|null>,write?:(value:SavedDraftAttachments)=>Promise<void>){
 const rows=new Map<string,SavedDraftAttachments>();if(saved)rows.set(JSON.stringify([saved.namespace,saved.sessionId]),saved)
 const key=(n:string,s:string)=>JSON.stringify([n,s]),store:DraftAttachmentStore={read:read??(async(n,s)=>rows.get(key(n,s))??null),write:write??(async row=>{rows.set(key(row.namespace,row.sessionId),row)}),remove:async(n,s)=>{rows.delete(key(n,s))}}
 const input=source(empty()),session=source({openState:'open',pendingSubmissions:[] as unknown[]}),unknown=source(false),identity=source('owner-A'),history=source({entries:[] as any[]})
 const registry=new Map<string,ComposerAttachment>(),notices:string[]=[],created:File[]=[];let count=0
 const put=(id:string,file:File)=>{registry.set(id,{kind:'file',id,file} as ComposerAttachment);return id as InputState['attachmentIds'][number]}
 const coordinator=persistNativeDraftAttachments({namespace:'owner-A',sessionId:'A',store,current:()=>identity.getSnapshot()==='owner-A',identity,history,input,session,unknown,
  resolve:ids=>ids.flatMap(id=>registry.has(id)?[registry.get(id)!]:[]),create:files=>files.map(file=>{created.push(file);const id=put('restored-'+ ++count,file);return registry.get(id)!}),add:ids=>{input.set({...input.getSnapshot(),attachmentIds:ids as InputState['attachmentIds']});return true},release:items=>{for(const row of items)registry.delete(row.id)},notice:reason=>{notices.push(reason)}})
 return {coordinator,input,session,unknown,identity,history,registry,notices,created,put,rows,read:()=>rows.get(key('owner-A','A'))}
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
 const reload=fixture(stored);await reload.coordinator.flush()
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
test('删除部分附件不清除其他文件；反复同步不重复保存 File',async()=>{
 let writes=0;const f=fixture(null,undefined,async()=>{writes++});await f.coordinator.ready
 f.put('a',file());f.put('b',file());f.input.set({...empty(),attachmentIds:['a','b'] as any});await f.coordinator.flush();assert.equal(writes,1)
 f.input.set({...f.input.getSnapshot(),draft:'只改文字',draftRev:1});await f.coordinator.flush();assert.equal(writes,1)
 f.input.set({...f.input.getSnapshot(),attachmentIds:['b'] as any});f.registry.delete('a');await f.coordinator.flush();assert.equal(writes,2);assert.ok(f.registry.has('b'));f.coordinator.dispose()
})
