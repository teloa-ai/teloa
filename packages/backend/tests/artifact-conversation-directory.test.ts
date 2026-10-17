import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {SavedArtifactSource,SavedArtifactVersion} from '@teloa/contract'
import {listConversationArtifacts} from '../src/work/artifact-conversation-directory.ts'

const stamp='2026-10-17T00:00:00.000Z'
function fixture(){
 const owner='owner',session:SavedArtifactSource={kind:'session',id:'chat',scope:'general',version:'binding',title:'当前会话'}
 const original=randomUUID(),producer=randomUUID(),artifactId=randomUUID(),tasks=new Map<string,Record<string,unknown>>()
 const addTask=(id:string,scope='general')=>tasks.set(id,{id,owner_id:owner,definition:{title:'任务',goal:'完成工作',scope},version:2,state:'completed',assignee_role_id:null,assignee_role_version:null,created_at:new Date(stamp),updated_at:new Date(stamp)})
 addTask(original);addTask(producer)
 const source:SavedArtifactSource={kind:'task',id:original,scope:'general',version:'1',title:'原成果任务'}
 const version=(number:number):SavedArtifactVersion=>({artifactId,ownerId:owner,number,source,content:{title:'成果',sections:[{id:'result-0',title:'正文',text:'v'+number}],snapshotIds:[],note:'正式版本'},createdAt:stamp})
 const link=(id:string,sourceOnly=true)=>({owner_id:owner,session_id:'chat',conversation_id:'binding',kind:'task',object_id:id,version:1,object_version:1,source_only:sourceOnly,active:true,scope_id:'general'})
 const state={links:[link(producer)],scopes:new Set<string>(),queries:[] as string[],taskLists:[] as string[],onList:()=>{}}
 const pool={query:async(sql:string,args:unknown[])=>{
  state.queries.push(sql)
  if(sql.includes('from teloa_object_conversations')){
   assert.match(sql,/owner_id=\$1 and session_id=\$2 and kind='task' and active=true/)
   assert.doesNotMatch(sql,/source_only=false/)
   return {rows:state.links.filter(row=>row.owner_id===args[0]&&row.session_id===args[1]&&row.kind==='task'&&row.active).sort((a,b)=>a.object_id.localeCompare(b.object_id))}
  }
  if(sql.startsWith('select * from teloa_tasks')){assert.match(sql,/where owner_id=\$1 and id=\$2/);const row=tasks.get(args[1] as string);return {rows:row?.owner_id===args[0]?[row]:[]}}
  if(sql.includes('to_regclass'))return {rows:[{name:'teloa_business_scopes'}]}
  if(sql.startsWith('select scope from teloa_business_scopes'))return {rows:state.scopes.has(args[1] as string)?[{scope:args[1]}]:[]}
  throw Error('未预期的查询：'+sql)
 }} as unknown as Pool
 const ports={listSource:async()=>[] as SavedArtifactVersion[],listTask:async(_owner:string,task:SavedArtifactSource)=>{
  state.taskLists.push(task.id);state.onList()
  return task.id===original?[version(4)]:[{...version(2),producer:{taskId:producer,taskVersion:2,runId:randomUUID()}}]
 }}
 return {owner,session,original,producer,artifactId,tasks,source,version,link,state,pool,ports,read:()=>listConversationArtifacts(pool,owner,session,ports)}
}

test('主聊来源关联与员工明确任务关联均可读取；续改保持原归属且不提升到别处的新版本',async()=>{
 const f=fixture(),r=await f.read()
 assert.equal(r.sessionId,'chat');assert.equal(r.artifacts.length,1);assert.equal(r.artifacts[0]!.number,2)
 assert.deepEqual(r.artifacts[0]!.source,f.source);assert.equal(r.artifacts[0]!.producer?.taskId,f.producer)
 f.state.links=[f.link(f.producer,false)]
 assert.equal((await f.read()).artifacts[0]!.number,2)
 assert.ok(f.state.queries.every(sql=>!sql.includes('from teloa_conversation_work_requests')))
})
test('原来源与后继生产任务同时关联时按可见版本去重，保留原source',async()=>{
 const f=fixture();f.state.links.push(f.link(f.original))
 const r=await f.read();assert.equal(r.artifacts.length,1);assert.equal(r.artifacts[0]!.number,4);assert.deepEqual(r.artifacts[0]!.source,f.source)
})
test('不沿其他会话/他人/员工身份读取任务，已解除关联不提供任务成果',async()=>{
 const f=fixture();f.state.links=[{...f.link(f.original),session_id:'other'},{...f.link(f.original),owner_id:'other'},{...f.link(f.original),kind:'role'},{...f.link(f.producer),active:false}]
 assert.deepEqual(await f.read(),{sessionId:'chat',artifacts:[]});assert.deepEqual(f.state.taskLists,[])
})
test('读取期间解除关联，或绑定身份已经换过，不能返回先前拿到的正文',async()=>{
 const f=fixture();f.state.onList=()=>{f.state.links=[]}
 await assert.rejects(f.read(),{code:'teloa/version-conflict'})
 f.state.links=[{...f.link(f.producer),conversation_id:'old-binding'}]
 await assert.rejects(f.read(),{code:'teloa/storage-corrupt'})
})
test('关联任务缺失或不属于本人时显式失败，不降级为无成果',async()=>{
 const f=fixture();f.tasks.get(f.producer)!.owner_id='other'
 await assert.rejects(f.read(),{code:'teloa/forbidden'});assert.deepEqual(f.state.taskLists,[])
})
test('关联任务业务与原成果业务分别核对；未知范围不以general生产者代授权',async()=>{
 const f=fixture();f.source.scope='hidden'
 await assert.rejects(f.read(),{code:'teloa/forbidden'})
 f.state.scopes.add('hidden');assert.equal((await f.read()).artifacts.length,1)
 f.tasks.get(f.producer)!.definition={title:'任务',goal:'完成工作',scope:'revoked'};f.state.links[0]!.scope_id='revoked'
 await assert.rejects(f.read(),{code:'teloa/forbidden'})
})
test('目录读取期间任务业务变化或业务被撤回时不返回旧结果',async()=>{
 const f=fixture();f.state.onList=()=>{f.tasks.get(f.producer)!.definition={title:'任务',goal:'完成工作',scope:'changed'}}
 await assert.rejects(f.read(),{code:'teloa/version-conflict'})
 const g=fixture();g.session.scope='business';g.state.scopes.add('business');g.state.onList=()=>{g.state.scopes.clear()}
 await assert.rejects(g.read(),{code:'teloa/forbidden'})
})
test('重复版本内容冲突不能静默挑一份，纯会话直接成果仍可见',async()=>{
 const f=fixture();f.ports.listSource=async()=>[{...f.version(2),content:{...f.version(2).content,note:'矛盾版本'}}]
 await assert.rejects(f.read(),{code:'teloa/storage-corrupt'})
 f.state.links=[];f.ports.listSource=async()=>[{...f.version(1),source:f.session}]
 const r=await f.read();assert.equal(r.artifacts.length,1);assert.deepEqual(r.artifacts[0]!.source,f.session)
})
