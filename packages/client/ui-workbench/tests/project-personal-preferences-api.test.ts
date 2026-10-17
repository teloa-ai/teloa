import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createProjectRuntimeApi} from '../src/client/project-runtime-api.ts'
const journal=()=>{let value:string|null=null;return {read:()=>value,write:(next:string)=>{value=next},clear:()=>{value=null}}}
test('损坏个人恢复请求可单独丢弃，保留个人草稿及项目请求、草稿与预约',async()=>{
 const p=randomUUID(),store=journal(),calls:string[]=[],draft={expectedVersion:0,entryId:null,topic:'回答方式',markdown:'保留后续编辑'},api=createProjectRuntimeApi(async endpoint=>{calls.push(endpoint);throw Error('lost')},store),settings={projectId:p,version:0,automatic:'paused' as const,readPersonal:false,resources:[]}
 api.setDraft(p,settings);api.reserveCreation(p,'原预约','enabled');await assert.rejects(api.configure(settings));api.personal.setDraft(draft)
 const raw=JSON.parse(store.read()!);raw.personal.pending={endpoint:'broken',input:{}};store.write(JSON.stringify(raw));const restored=createProjectRuntimeApi(async()=>{assert.fail('丢弃不得访问服务器')},store)
 assert.ok(restored.personal.recoveryError());assert.equal(restored.personal.discard(),true);assert.equal(restored.personal.recoveryError(),undefined);assert.deepEqual(restored.personal.draft(),draft);assert.deepEqual(restored.pending(p),api.pending(p));assert.deepEqual(restored.draft(p),settings);assert.equal(restored.creation(p)?.title,'原预约');assert.equal(calls.length,1)
})

test('本人偏好未知保存跨刷新原样恢复，与项目草稿隔离，不覆盖后来编辑的内容',async()=>{
 const projectId=randomUUID(),store=journal(),calls:any[]=[],draft={expectedVersion:0,entryId:null,topic:'回答方式',markdown:'先给结论'},api=createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);throw Error('timeout')},store)
 assert.ok(api.personal,'本人偏好编辑API尚未接线')
 api.setDraft(projectId,{projectId,version:0,automatic:'decisions',readPersonal:false,resources:[]})
 api.personal.setDraft(draft);await assert.rejects(api.personal.save(draft));api.personal.setDraft({...draft,markdown:'后续编辑'})
 const restored=createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);return {version:2,entries:[{id:randomUUID(),version:1,topic:draft.topic,markdown:draft.markdown}]}},store)
 await restored.personal.recover()
 assert.equal(calls[0][1].requestId,calls[1][1].requestId);assert.equal(restored.personal.pending(),undefined)
 assert.equal(restored.personal.draft()?.markdown,'后续编辑');assert.ok(restored.draft(projectId))
})

test('本人偏好保存和撤回只发送显式操作，损坏响应与不同内容不能冒充恢复',async()=>{
 const id=randomUUID(),store=journal(),api=createProjectRuntimeApi(async()=>{throw Error('lost')},store)
 assert.ok(api.personal)
 await assert.rejects(api.personal.withdraw({expectedVersion:1,entryId:id}))
 await assert.rejects(api.personal.save({expectedVersion:1,entryId:id,topic:'不同操作',markdown:'不能改投'}))
 assert.throws(()=>api.personal.setDraft({expectedVersion:1,entryId:null,topic:'坏\u000b主题',markdown:'正文'}))
 const malformed=createProjectRuntimeApi(async()=>({version:1,entries:[{id,version:1,topic:'主题',markdown:'泄漏\u000b内容'}]}))
 await assert.rejects(malformed.personal.get())
})

test('项目条目采用先持久原请求，未知结果复用本人恢复入口，不发送正文或改写其他草稿',async()=>{
 const projectId=randomUUID(),entryId=randomUUID(),store=journal(),calls:any[]=[],draft={expectedVersion:0,entryId:null,topic:'本人草稿',markdown:'保留后续输入'}
 const input={projectId,entryId,entryVersion:3,expectedPersonalVersion:0},source={projectId,entryId,entryVersion:3,basisHash:'a'.repeat(64)}
 const api=createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);assert.equal(JSON.parse(store.read()!).personal.pending.input.requestId,(input as any).requestId,'请求前已写入原本人journal');throw Error('timeout')},store)
 assert.equal(typeof api.personal.publish,'function','缺少项目条目明确采用入口')
 api.personal.setDraft(draft);await assert.rejects(api.personal.publish(input))
 const restored=createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);return {version:1,entries:[{id:randomUUID(),version:1,topic:'项目约定',markdown:'服务端固定原文',source}]}},store)
 const result=await restored.personal.recover();assert.deepEqual(result.entries[0]!.source,source)
 assert.equal(calls[0][0],'project-runtime/publish-personal');assert.deepEqual(calls[0][1],{...input,requestId:calls[0][1].requestId});assert.deepEqual(calls[1],calls[0]);assert.equal(restored.personal.pending(),undefined);assert.deepEqual(restored.personal.draft(),draft)
})

test('采用CAS冲突保意图且不循环，旧请求成功重放允许来源已被本人编辑或撤回',async()=>{
 const input={projectId:randomUUID(),entryId:randomUUID(),entryVersion:2,expectedPersonalVersion:4},store=journal();let calls=0
 const api=createProjectRuntimeApi(async()=>{calls++;throw Object.assign(Error('conflict'),{code:'teloa/conflict',rejected:true})},store)
 assert.equal(typeof api.personal.publish,'function')
 await assert.rejects(api.personal.publish(input));assert.equal(calls,1);assert.equal(api.personal.pending()?.endpoint,'publish-personal');assert.deepEqual((api.personal.pending() as any).input,{...input,requestId:(api.personal.pending() as any).input.requestId})
 const restored=createProjectRuntimeApi(async()=>({version:7,entries:[{id:randomUUID(),version:2,topic:'本人已改',markdown:'后来编辑正文'}]}),store)
 await restored.personal.recover();assert.equal(restored.personal.pending(),undefined,'来源清除不将已成功旧操作锁为未知，也不重建')
 await assert.rejects(api.personal.publish(input));assert.equal(api.personal.discard(),true);assert.equal(api.personal.pending(),undefined)
})

test('个人偏好回执兼容普通条目，并严格校验可选固定来源',async()=>{
 const base={id:randomUUID(),version:1,topic:'约定',markdown:'原文'},source={projectId:randomUUID(),entryId:randomUUID(),entryVersion:2,basisHash:'b'.repeat(64)}
 const read=(entry:unknown)=>createProjectRuntimeApi(async()=>({version:1,entries:[entry]})).personal.get()
 assert.deepEqual((await read(base)).entries,[base]);assert.deepEqual((await read({...base,source})).entries,[{...base,source}])
 for(const wrong of [null,{...source,entryVersion:0},{...source,projectId:'foreign'},{...source,basisHash:'bad'},{...source,extra:true}])await assert.rejects(read({...base,source:wrong}))
})
