import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {ConversationService,FileConversationRepository} from '../src/work/conversations.ts'

const owner='local:assistant-test',title='Teloa 小松鼠助手'
const temporary:string[]=[]
after(async()=>{await Promise.all(temporary.map(path=>rm(path,{recursive:true,force:true})))})
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'teloa-assistant-'));temporary.push(directory)
 const repository=new FileConversationRepository(join(directory,'conversations.json'))
 const created:string[]=[],pinned:string[]=[],existing=new Set<string>();let failCreate=false,failPin=false
 const host={create:async(id:string)=>{created.push(id);existing.add(id);if(failCreate){failCreate=false;throw Error('unknown create')}return id},inspect:async(id:string)=>{assert.ok(existing.has(id))},pinAssistantTitle:async(id:string)=>{pinned.push(id);if(failPin){failPin=false;throw Error('unknown title')}}}
 const identity={id:randomUUID,now:()=> '2026-10-13T00:00:00Z'},service=new ConversationService(repository,host,identity)
 const verify=async(_id:string,register:()=>Promise<void>)=>{await register();return true}
 return {repository,host,identity,service,created,pinned,verify,failCreate:()=>{failCreate=true},failPin:()=>{failPin=true}}
}
test('服务端本人主聊并发请求、不同浏览器和重启恢复同一身份，不依赖客户端requestId',async()=>{
 const f=await fixture()
 const rows=await Promise.all(Array.from({length:8},()=>f.service.ensureAssistant(owner,{},f.verify)))
 assert.equal(new Set(rows.map(row=>row.sessionId)).size,1);assert.equal(f.created.length,1)
 const main=rows[0];assert.ok(main);assert.equal(main.purpose,'assistant');assert.equal(main.title,title)
 const restarted=new ConversationService(f.repository,f.host,f.identity)
 assert.equal((await restarted.ensureAssistant(owner,{},f.verify)).sessionId,main.sessionId)
 assert.equal((await f.repository.read()).length,1)
 assert.notEqual((await restarted.ensureAssistant('local:other',{},f.verify)).sessionId,main.sessionId)
})
test('未知创建与标题回包保留服务端预约，重试恢复原身份和固定工作区',async()=>{
 const f=await fixture();f.failCreate()
 await assert.rejects(f.service.ensureAssistant(owner,{workspaceId:'original'},f.verify),/unknown create/)
 const pending=(await f.repository.read())[0];assert.ok(pending);assert.equal(pending.status,'pending');assert.equal(pending.purpose,'assistant')
 f.failPin();await assert.rejects(f.service.ensureAssistant(owner,{},f.verify),/unknown title/)
 const ready=await f.service.ensureAssistant(owner,{},f.verify)
 assert.equal(ready.sessionId,pending.sessionId);assert.equal(ready.requestedWorkspaceId,'original')
 assert.equal(new Set(f.created).size,1);assert.equal((await f.repository.read()).length,1)
})
test('唯一核验的旧主聊原地登记，不改其他历史；重命名投影不影响服务端身份',async()=>{
 const f=await fixture(),legacy=await f.service.create(owner,{requestId:randomUUID(),title})
 const ordinary=await f.service.create(owner,{requestId:randomUUID(),title:'普通工作'})
 const checked:string[]=[]
 const assistant=await f.service.ensureAssistant(owner,{},async(id,register)=>{checked.push(id);if(id!==legacy.sessionId)return false;await register();return true})
 assert.equal(assistant.id,legacy.id);assert.equal(assistant.requestId,legacy.requestId);assert.equal(assistant.purpose,'assistant')
 assert.deepEqual(checked,[legacy.sessionId,legacy.sessionId]);assert.equal(f.created.length,2)
 assert.equal((await f.service.bySession(owner,ordinary.sessionId)).purpose,undefined)
 assert.equal((await f.service.bySession(owner,legacy.sessionId)).purpose,'assistant')
 assert.equal((await f.service.ensureAssistant(owner,{},async()=>{throw Error('must not guess again')})).id,legacy.id)
})
test('多个核验候选、员工/业务旧归属和旧pending不猜测合并',async()=>{
 const f=await fixture()
 const a=await f.service.create(owner,{requestId:randomUUID(),title}),b=await f.service.create(owner,{requestId:randomUUID(),title})
 await assert.rejects(f.service.ensureAssistant(owner,{},f.verify),{code:'teloa/conflict'})
 assert.equal((await f.repository.read()).some(row=>row.purpose==='assistant'),false)
 const assistant=await f.service.ensureAssistant(owner,{},async(id,register)=>{if(id!==b.sessionId)return false;await register();return true})
 assert.equal(assistant.sessionId,b.sessionId);assert.notEqual(assistant.sessionId,a.sessionId)
 const g=await fixture();g.failCreate();await assert.rejects(g.service.create(owner,{requestId:randomUUID(),title}))
 await assert.rejects(g.service.ensureAssistant(owner,{},g.verify),{code:'teloa/binding-pending'});assert.equal((await g.repository.read()).length,1)
})
test('助手用途不能由普通创建伪造或重放，未接标题服务不写预约',async()=>{
 const f=await fixture()
 await assert.rejects(f.service.create(owner,{requestId:randomUUID(),title,purpose:'assistant'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.ensureAssistant(owner,{ownerId:'other'},f.verify),{code:'teloa/invalid-input'})
 const a=await f.service.ensureAssistant(owner,{},f.verify)
 await assert.rejects(f.service.create(owner,{requestId:a.requestId,title}),{code:'teloa/conflict'})
 await assert.rejects(f.repository.write([...(await f.repository.read()),{...a,id:randomUUID(),sessionId:randomUUID(),requestedSessionId:randomUUID(),requestId:randomUUID()}]),{code:'teloa/storage-corrupt'})
 const g=await fixture(),bare=new ConversationService(g.repository,{create:g.host.create,inspect:g.host.inspect},g.identity)
 await assert.rejects(bare.ensureAssistant(owner,{},g.verify),{code:'teloa/dependency-unavailable'})
 assert.equal((await g.repository.read()).length,0)
})
test('旧上下文在登记锁内变化不选其他历史，不落助手用途或新会话',async()=>{
 const f=await fixture(),legacy=await f.service.create(owner,{requestId:randomUUID(),title});let reads=0
 await assert.rejects(f.service.ensureAssistant(owner,{},async()=>++reads===1),{code:'teloa/conflict'})
 const saved=(await f.repository.read())[0];assert.ok(saved);assert.equal(saved.sessionId,legacy.sessionId)
 assert.equal(saved.purpose,undefined);assert.equal(f.created.length,1)
})
test('旧主聊已归档或不能核验时不另建；已归档的副本不妨碍唯一有效主聊',async()=>{
 const f=await fixture(),a=await f.service.create(owner,{requestId:randomUUID(),title})
 await assert.rejects(f.service.ensureAssistant(owner,{},async()=>false),{code:'teloa/conflict'})
 assert.equal(f.created.length,1)
 const b=await f.service.create(owner,{requestId:randomUUID(),title})
 const main=await f.service.ensureAssistant(owner,{},async(id,register)=>{if(id===a.sessionId)return false;await register();return true})
 assert.equal(main.id,b.id);assert.equal(f.created.length,2)
})
test('助手原生回包身份不匹配时保留原pending，不固定或登记其他历史',async()=>{
 const f=await fixture(),service=new ConversationService(f.repository,{...f.host,create:async()=> 'unrequested-native-history'},f.identity)
 await assert.rejects(service.ensureAssistant(owner,{},f.verify),{code:'teloa/invalid-host-response'})
 const rows=await f.repository.read();assert.equal(rows.length,1);const pending=rows[0];assert.ok(pending);assert.equal(pending.status,'pending')
 assert.equal(pending.sessionId,pending.requestedSessionId);assert.notEqual(pending.sessionId,'unrequested-native-history');assert.deepEqual(f.pinned,[])
})
