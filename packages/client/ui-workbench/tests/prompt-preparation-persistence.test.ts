import assert from 'node:assert/strict'
import test from 'node:test'
import {PromptPreparation,preparationStorageKey,type PreparationStorage} from '../src/client/prompt-preparation.ts'

// BIZ-004 会话侧：创建说明「准备进会话但未发送」时关闭浏览器，重开同一会话要还能看到可恢复的待发送卡片，
// 不能只剩空白会话。持久化只保存待发送/失效记录，已带入、已放弃的记录不恢复，也不伪造已发送。
const fake=(initial?:string)=>{
 let value=initial??null
 const storage:PreparationStorage={read:()=>value,write:next=>{value=next},clear:()=>{value=null}}
 return {storage,raw:()=>value}
}
const row=(patch:Record<string,unknown>={})=>({id:'p1',sourceId:'home:s1',sourceKind:'home' as const,sourceVersion:1,sessionId:'session-1',title:'创建说明',text:'帮我建一名资料研究员',status:'pending' as const,...patch})

test('准备记录在重开后仍可恢复：待发送提示跨页面存活',()=>{
 const {storage}=fake()
 const first=new PromptPreparation(storage)
 first.prepare(row())
 assert.ok(storage.read(),'必须写入持久化存储')
 const reopened=new PromptPreparation(storage)
 assert.deepEqual(reopened.getSnapshot(),[row()])
})

test('已带入、已放弃、过期的准备记录不恢复，避免把旧草稿当成未发送',()=>{
 const {storage}=fake()
 storage.write(JSON.stringify({schema:'teloa.prompt-preparation/v1',savedAt:new Date().toISOString(),rows:[row({id:'a'}),row({id:'b',status:'inserted'}),row({id:'c',status:'dismissed'}),row({id:'d',status:'stale'})]}))
 const reopened=new PromptPreparation(storage)
 assert.deepEqual(reopened.getSnapshot(),[row({id:'a'}),row({id:'d',status:'stale'})])
})

test('旧格式或损坏记录被丢弃而不是抛错，也不阻塞下一次准备',()=>{
 const corrupted=['不是 JSON','{"rows":"x"}','[]','{"schema":"other","rows":[]}']
 for(const raw of corrupted){
  const {storage}=fake(raw)
  const preparation=new PromptPreparation(storage)
  assert.deepEqual(preparation.getSnapshot(),[])
  preparation.prepare(row())
  assert.equal(preparation.getSnapshot().length,1)
 }
})

test('超过三天的未发送记录不再恢复，数量上限也不无限增长',()=>{
 const stale={schema:'teloa.prompt-preparation/v1',savedAt:'2026-01-01T00:00:00.000Z',rows:[row()]}
 assert.deepEqual(new PromptPreparation(fake(JSON.stringify(stale)).storage).getSnapshot(),[])
 const {storage}=fake(JSON.stringify({schema:'teloa.prompt-preparation/v1',savedAt:new Date().toISOString(),rows:Array.from({length:40},(_,index)=>row({id:'p'+index}))}))
 assert.equal(new PromptPreparation(storage).getSnapshot().length,10)
})

test('带入与放弃后持久化同步移除，避免下次重开又出现已处理记录',()=>{
 const {storage}=fake()
 const preparation=new PromptPreparation(storage)
 preparation.prepare(row())
 preparation.dismiss('p1')
 assert.deepEqual(new PromptPreparation(storage).getSnapshot(),[])
 preparation.prepare(row({id:'p2'}))
 preparation.insert('p2','session-1',{draft:'',attachmentIds:[],phase:'plain'},false,{setDraft:()=>{}})
 assert.deepEqual(new PromptPreparation(storage).getSnapshot(),[])
})

test('存储键固定，换实例也读同一份恢复记录',()=>{
 assert.equal(preparationStorageKey,'teloa.prompt-preparation/v1')
 const {storage,raw}=fake()
 new PromptPreparation(storage).prepare(row())
 assert.match(raw()??'',/teloa\.prompt-preparation\/v1|"rows":\[/)
 assert.deepEqual(new PromptPreparation(fake(raw()!).storage).getSnapshot(),[row()])
})
