import test from 'node:test'
import assert from 'node:assert/strict'
import {createProjectCreationDrafts} from '../src/client/project-creation-drafts.ts'
import {createProjectApi} from '../src/client/project-api.ts'
import type {WorkProject} from '@teloa/contract'
const ownerA='10000000-0000-4000-8000-000000000001',ownerB='20000000-0000-4000-8000-000000000001'
const initial={scope:'general',title:'',goal:'',dueDate:null,state:'planning' as const,links:[],references:[]}
const fields={...initial,title:'Reviewed name',goal:'# Original Markdown\n\nKeep **all** text.\n',dueDate:'2026-10-31'}
function setup(){
 const data=new Map<string,string>();let owner=ownerA,generation=1,removeFails=false,writeFails=false,readFails=false
 const storage={getItem:(key:string)=>{if(readFails)throw Error();return data.get(key)??null},setItem:(key:string,value:string)=>{if(writeFails)throw Error();data.set(key,value)},removeItem:(key:string)=>{if(removeFails)throw Error();data.delete(key)}}
 const options={storage,identity:async()=>owner,generation:()=>generation},store=()=>createProjectCreationDrafts(options)
 return {data,store,options,identity:(next:string)=>{owner=next;generation++},removeFails:(value:boolean)=>{removeFails=value},writeFails:(value:boolean)=>{writeFails=value},readFails:(value:boolean)=>{readFails=value}}
}
test('未提交草稿跨服务重建保留原文和手改标题，按本人和入口隔离且不恢复确认',async()=>{
 const s=setup(),one=s.store(),draft=await one.open('overview',null,initial)
 one.write(draft.ticket,{fields,ack:true,titleEdited:true})
 assert.deepEqual((await s.store().open('overview',null,initial)).draft,{fields,ack:false,titleEdited:true})
 assert.equal((await s.store().open('overview','general',initial)).draft.fields.goal,'')
 assert.equal((await s.store().open('workspace','general',initial)).draft.fields.goal,'')
 s.identity(ownerB);assert.equal((await s.store().open('overview',null,initial)).draft.fields.goal,'')
 s.identity(ownerA);assert.equal((await s.store().open('overview',null,initial)).draft.fields.goal,fields.goal)
})

const projectId='30000000-0000-4000-8000-000000000001',otherProjectId='30000000-0000-4000-8000-000000000002'
const editProject=(patch:Partial<WorkProject>={}):WorkProject=>({...fields,goal:'# Original Markdown\n\nKeep **all** text.',id:projectId,ownerId:'self',state:'running',version:4,createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z',...patch})
test('F08 编辑草稿重建恢复空字段、原项目版本与Markdown，不恢复完成确认',async()=>{
 const s=setup(),store=s.store(),project=editProject(),opened=await store.openEdit(project)
 store.writeEdit(opened.ticket,{fields:{...fields,title:'',goal:'# Unsent\n\nKeep **all** text.\n',state:'completed'},ack:true})
 const restored=await s.store().openEdit(editProject({version:8,title:'Remote title',goal:'Remote goal'}))
 assert.deepEqual(restored.project,project);assert.equal(restored.draft.fields.title,'');assert.equal(restored.draft.fields.goal,'# Unsent\n\nKeep **all** text.\n');assert.equal(restored.draft.fields.state,'completed');assert.equal(restored.draft.ack,false);assert.equal(restored.ticket.version,4)
 assert.equal((await s.store().openEdit(editProject({id:otherProjectId}))).draft.fields.goal,'# Original Markdown\n\nKeep **all** text.')
})
test('F08 编辑草稿按本人和连接换代隔离，身份检查期间换代不清稿',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject())
 store.writeEdit(opened.ticket,{fields:{...fields,goal:'Owner A draft'},ack:false})
 s.identity(ownerB);assert.throws(()=>store.writeEdit(opened.ticket,{fields,ack:false}),{code:'teloa/conflict'});await assert.rejects(store.checkEdit(opened.ticket),{code:'teloa/conflict'});await assert.rejects(store.clearEdit(opened.ticket,fields),{code:'teloa/conflict'})
 assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,'# Original Markdown\n\nKeep **all** text.')
 s.identity(ownerA);const restored=await s.store().openEdit(editProject());assert.equal(restored.draft.fields.goal,'Owner A draft')
 let release!:(owner:string)=>void
 const held=createProjectCreationDrafts({...s.options,identity:()=>new Promise<string>(resolve=>{release=resolve})})
 const pending=held.openEdit(editProject());s.identity(ownerB);release(ownerA);await assert.rejects(pending,{code:'teloa/conflict'})
 s.identity(ownerA);assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,'Owner A draft')
})
test('F08 编辑成功只清同项目同版本同输入，迟到回执保留较新草稿',async()=>{
 const s=setup(),store=s.store(),one=await store.openEdit(editProject()),other=await store.openEdit(editProject({id:otherProjectId}))
 store.writeEdit(one.ticket,{fields,ack:false});store.writeEdit(other.ticket,{fields:{...fields,goal:'Other project draft'},ack:false})
 store.writeEdit(one.ticket,{fields:{...fields,goal:'Newer input'},ack:false});await store.clearEdit(one.ticket,fields)
 assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,'Newer input')
 await store.clearEdit(one.ticket,{...fields,goal:'Newer input'})
 const newer=s.store(),version5=await newer.openEdit(editProject({version:5}));newer.writeEdit(version5.ticket,{fields,ack:false})
 await store.clearEdit(one.ticket,fields);assert.equal((await s.store().openEdit(editProject({version:5}))).ticket.version,5);assert.equal(s.data.size,2)
 await newer.clearEdit(version5.ticket,fields);assert.equal(s.data.size,1);assert.equal((await s.store().openEdit(editProject({id:otherProjectId}))).draft.fields.goal,'Other project draft')
})
test('F08 编辑存储写清失败保留原文，读失败或损坏记录不被默认输入覆盖',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject())
 store.writeEdit(opened.ticket,{fields,ack:false});const saved=[...s.data.values()][0]
 s.writeFails(true);assert.throws(()=>store.writeEdit(opened.ticket,{fields:{...fields,goal:'Keep failed write input'},ack:false}),{code:'teloa/recovery-write-failed'});assert.equal((await store.openEdit(editProject())).draft.fields.goal,'Keep failed write input');assert.equal([...s.data.values()][0],saved)
 s.writeFails(false);store.writeEdit(opened.ticket,{fields:{...fields,goal:'Keep failed write input'},ack:false});s.removeFails(true);await assert.rejects(store.clearEdit(opened.ticket,{...fields,goal:'Keep failed write input'}),{code:'teloa/recovery-clear-failed'});assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,'Keep failed write input')
 s.readFails(true);await assert.rejects(s.store().openEdit(editProject()),{code:'teloa/storage-unavailable'});s.readFails(false)
 const key=[...s.data.keys()][0]!,bad='{broken edit draft';s.data.set(key,bad);await assert.rejects(s.store().openEdit(editProject()),{code:'teloa/storage-corrupt'});assert.equal(s.data.get(key),bad)
})
test('F08 编辑草稿不能改变原项目业务和关联，也不能恢复归档或确认授权',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject())
 for(const patch of [{scope:'SOC'},{state:'archived' as const},{links:[{kind:'task' as const,id:otherProjectId}]}])assert.throws(()=>store.writeEdit(opened.ticket,{fields:{...fields,...patch},ack:false}),{code:'teloa/storage-corrupt'})
 assert.equal((await store.openEdit(editProject())).draft.fields.scope,'general');assert.equal(s.data.size,0)
})
test('F08 旧编辑窗口不能覆盖另一个窗口已经保存的较新版本草稿',async()=>{
 const s=setup(),old=s.store(),first=await old.openEdit(editProject()),other=s.store()
 old.writeEdit(first.ticket,{fields,ack:false});const saved=await other.openEdit(editProject());await other.clearEdit(saved.ticket,fields)
 const next=await other.openEdit(editProject({version:5}));other.writeEdit(next.ticket,{fields:{...fields,goal:'New version draft'},ack:false})
 assert.throws(()=>old.writeEdit(first.ticket,{fields:{...fields,goal:'Keep old window input'},ack:false}),{code:'teloa/version-conflict'})
 assert.equal((await s.store().openEdit(editProject({version:5}))).draft.fields.goal,'New version draft');assert.equal((await old.openEdit(editProject())).draft.fields.goal,'Keep old window input')
})
test('F08 迟到清稿不能删除仅增加Markdown首尾空白的较新原文',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject()),submitted={...fields,goal:'Original Markdown'}
 store.writeEdit(opened.ticket,{fields:submitted,ack:false});store.writeEdit(opened.ticket,{fields:{...submitted,goal:' Original Markdown\n'},ack:false})
 await store.clearEdit(opened.ticket,submitted)
 assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,' Original Markdown\n');assert.equal((await store.openEdit(editProject())).draft.fields.goal,' Original Markdown\n')
})
test('F08 冲突审阅必须明确选择，未改字段与关联取最新，恢复只改草稿基线',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject())
 const mine={...opened.draft.fields,goal:' My **unsent** Markdown\n',state:'completed' as const}
 store.writeEdit(opened.ticket,{fields:mine,ack:true})
 const latest=editProject({version:5,title:'Latest title',goal:'Latest goal',dueDate:null,links:[{kind:'task',id:otherProjectId}]})
 const review=await store.reviewEdit(opened.ticket,latest)
 assert.deepEqual(review.conflicts,['goal']);assert.equal((await s.store().openEdit(latest)).ticket.version,4)
 await assert.rejects(store.resumeEdit(review,{}),{code:'teloa/conflict'})
 const resumed=await store.resumeEdit(review,{goal:'draft'})
 assert.equal(resumed.ticket.version,5);assert.equal(resumed.draft.fields.goal,mine.goal);assert.equal(resumed.draft.fields.title,'Latest title');assert.equal(resumed.draft.fields.dueDate,null);assert.deepEqual(resumed.draft.fields.links,latest.links);assert.equal(resumed.draft.fields.state,'completed');assert.equal(resumed.draft.ack,false)
 assert.equal((await s.store().openEdit(latest)).ticket.version,5)
 await store.clearEdit(opened.ticket,mine)
 assert.equal((await s.store().openEdit(latest)).draft.fields.goal,mine.goal)
 assert.throws(()=>store.writeEdit(opened.ticket,{fields:mine,ack:false}),{code:'teloa/conflict'})
})
test('F08 旧冲突审阅不能覆盖新输入、变更的存储或换代身份，写失败保持旧基线',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject()),latest=editProject({version:5,goal:'Latest goal'})
 store.writeEdit(opened.ticket,{fields:{...opened.draft.fields,goal:'First draft'},ack:false})
 const stale=await store.reviewEdit(opened.ticket,latest)
 store.writeEdit(opened.ticket,{fields:{...opened.draft.fields,goal:'Newer draft'},ack:false})
 await assert.rejects(store.resumeEdit(stale,{goal:'draft'}),{code:'teloa/conflict'})
 const review=await store.reviewEdit(opened.ticket,latest),before=[...s.data.values()][0]
 s.writeFails(true);await assert.rejects(store.resumeEdit(review,{goal:'latest'}),{code:'teloa/recovery-write-failed'});s.writeFails(false)
 assert.equal((await store.openEdit(latest)).ticket.version,4);assert.equal((await store.openEdit(latest)).draft.fields.goal,'Newer draft');assert.equal([...s.data.values()][0],before)
 s.identity(ownerB);await assert.rejects(store.resumeEdit(review,{goal:'draft'}),{code:'teloa/conflict'})
})
test('F08 审阅恢复等待身份期间被改写的审阅对象不能替换基线',async()=>{
 const s=setup();let hold=false,release!:(owner:string)=>void
 const store=createProjectCreationDrafts({...s.options,identity:()=>hold?new Promise<string>(resolve=>{release=resolve}):Promise.resolve(ownerA)}),opened=await store.openEdit(editProject())
 store.writeEdit(opened.ticket,{fields:{...opened.draft.fields,goal:'Keep original input'},ack:false})
 const review=await store.reviewEdit(opened.ticket,editProject({version:5,goal:'Latest goal'})),before=[...s.data.values()][0]
 hold=true;const pending=store.resumeEdit(review,{goal:'draft'});review.latest.version=99;release(ownerA)
 await assert.rejects(pending,{code:'teloa/conflict'});assert.equal([...s.data.values()][0],before)
})
test('F08 审阅拒绝跨项目业务归属、归档和伪造对象；外部新草稿使旧审阅失效',async()=>{
 const s=setup(),store=s.store(),opened=await store.openEdit(editProject())
 store.writeEdit(opened.ticket,{fields:{...opened.draft.fields,goal:'First draft'},ack:false})
 for(const patch of [{id:otherProjectId},{ownerId:'other'},{scope:'SOC'},{state:'archived' as const},{version:4}])await assert.rejects(store.reviewEdit(opened.ticket,editProject({version:5,...patch})),{code:'teloa/conflict'})
 const review=await store.reviewEdit(opened.ticket,editProject({version:5,goal:'Latest goal'}))
 await assert.rejects(store.resumeEdit({...review},{goal:'draft'}),{code:'teloa/conflict'})
 await assert.rejects(store.resumeEdit(review,{goal:'draft',title:'draft'}),{code:'teloa/conflict'})
 const other=s.store(),newer=await other.openEdit(editProject());other.writeEdit(newer.ticket,{fields:{...newer.draft.fields,goal:'External newer input'},ack:false})
 await assert.rejects(store.resumeEdit(review,{goal:'draft'}),{code:'teloa/conflict'});assert.equal((await s.store().openEdit(editProject())).draft.fields.goal,'External newer input')
})
test('连接换代和身份检查期间切换不能写入或提交旧草稿',async()=>{
 const s=setup(),store=s.store(),draft=await store.open('overview',null,initial)
 s.identity(ownerB);assert.throws(()=>store.write(draft.ticket,{fields,ack:false}),{code:'teloa/conflict'})
 let calls=0;const api=createProjectApi(async()=>{calls++;throw Error()},undefined,undefined,undefined,store)
 await assert.rejects(api.create(fields,draft.ticket),{code:'teloa/conflict'});assert.equal(calls,0)
 let release!:(value:string)=>void
 const held=createProjectCreationDrafts({...s.options,identity:()=>new Promise<string>(resolve=>{release=resolve})})
 const pending=held.open('overview',null,initial);s.identity(ownerA);release(ownerB)
 await assert.rejects(pending,{code:'teloa/conflict'});assert.equal(s.data.size,0)
})
test('未知创建结果刷新后恢复原请求，仅清原入口草稿且不发草稿身份到宿主',async()=>{
 const s=setup(),store=s.store(),draft=await store.open('overview',null,initial),other=await store.open('workspace','general',initial)
 for(const entry of [draft,other])store.write(entry.ticket,{fields,ack:false,titleEdited:true})
 let saved:string|null=null;const journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}},calls:unknown[]=[]
 const first=createProjectApi(async(_endpoint,input)=>{calls.push(input);throw Error('lost reply')},journal,undefined,undefined,store)
 await assert.rejects(first.create(fields,draft.ticket));assert.ok(saved)
 const row={...fields,goal:fields.goal.trim(),id:ownerB,ownerId:'self',version:1,createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'}
 const resumed=createProjectApi(async(_endpoint,input)=>{calls.push(input);return row},journal,undefined,undefined,s.store())
 s.identity(ownerB);await assert.rejects(resumed.recover(),{code:'teloa/conflict'});assert.equal(calls.length,1)
 s.identity(ownerA);await resumed.recover();assert.deepEqual(calls[0],calls[1]);assert.deepEqual(Object.keys(calls[1] as object).sort(),['fields','requestId'])
 assert.equal((await s.store().open('overview',null,initial)).draft.fields.goal,'')
 assert.equal((await s.store().open('workspace','general',initial)).draft.fields.goal,fields.goal);assert.equal(saved,null)
})
test('清稿失败保留请求身份，恢复后不重复创建；新草稿不被旧回执删除',async()=>{
 const s=setup(),store=s.store(),draft=await store.open('overview',null,initial);store.write(draft.ticket,{fields,ack:false})
 let saved:string|null=null;const journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}},ids=new Set<string>()
 const api=createProjectApi(async(_endpoint,input)=>{ids.add((input as {requestId:string}).requestId);return {...fields,goal:fields.goal.trim(),id:ownerB,ownerId:'self',version:1,createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'}},journal,undefined,undefined,store)
 s.removeFails(true);await assert.rejects(api.create(fields,draft.ticket),{code:'teloa/recovery-clear-failed'});assert.ok(api.pendingFields());assert.ok(saved)
 s.removeFails(false);store.write(draft.ticket,{fields:{...fields,goal:'New unsent content'},ack:false})
 await api.recover();assert.equal(ids.size,1);assert.equal(saved,null)
 assert.equal((await s.store().open('overview',null,initial)).draft.fields.goal,'New unsent content')
})
test('业务成功但回执尚在等待时切换身份，不能跳转或清理原请求及草稿',async()=>{
 const s=setup(),store=s.store(),draft=await store.open('overview',null,initial);store.write(draft.ticket,{fields,ack:false})
 let saved:string|null=null,release!:(value:unknown)=>void,entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}}
 const api=createProjectApi(async()=>{entered();return new Promise(resolve=>{release=resolve})},journal,undefined,undefined,store)
 const pending=api.create(fields,draft.ticket);await started;s.identity(ownerB)
 release({...fields,goal:fields.goal.trim(),id:ownerB,ownerId:'self',version:1,createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'})
 await assert.rejects(pending,{code:'teloa/conflict'});assert.ok(saved);assert.ok(api.pendingFields())
 s.identity(ownerA);assert.equal((await s.store().open('overview',null,initial)).draft.fields.goal,fields.goal)
})
test('损坏草稿和存储故障显式失败，保留损坏原件并禁止恢复状态或关系',async()=>{
 const s=setup(),store=s.store(),draft=await store.open('overview',null,initial);store.write(draft.ticket,{fields,ack:false})
 const key=[...s.data.keys()][0]!,bad=JSON.stringify({version:1,draft:{fields:{...fields,state:'running'}}});s.data.set(key,bad)
 await assert.rejects(s.store().open('overview',null,initial),{code:'teloa/storage-corrupt'});assert.equal(s.data.get(key),bad)
 s.data.delete(key);s.writeFails(true);assert.throws(()=>store.write(draft.ticket,{fields,ack:false}),{code:'teloa/recovery-write-failed'});assert.equal(s.data.size,0)
})
