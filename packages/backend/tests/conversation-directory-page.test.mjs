import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {ConversationService} from '../src/work/conversations.ts'
import {RoleRunConversationDirectory} from '../src/work/role-run-conversation-directory.ts'

const owner='owner',date='2026-11-01T00:00:00.000Z'
function row(id,actor=owner){return {id,ownerId:actor,title:id,scopeIds:['general'],version:1,status:'ready',requestedSessionId:id,sessionId:id,createdAt:date,requestId:randomUUID()}}
test('普通首屏不等待员工链；各页合并等于旧 list，历史不截断且不写入',async()=>{
 const rows=Array.from({length:5},(_,i)=>row('ordinary-'+i)),managed=Array.from({length:4},(_,i)=>({...row('managed-'+i),purpose:'task-run'}))
 let writes=0,managedReads=0
 const service=new ConversationService({read:async()=>rows,write:async()=>{writes++}},{create:async()=>{throw Error('not called')},inspect:async()=>{}},{id:randomUUID,now:()=>date},undefined,async()=>managed,async(_owner,input)=>{
  managedReads++;const offset=input.cursor===undefined?0:Number(input.cursor)
  return {items:managed.slice(offset,offset+input.limit),...(offset+input.limit<managed.length?{nextCursor:String(offset+input.limit)}:{})}
 })
 const first=await service.listPage(owner,{limit:2},true)
 assert.deepEqual(first.items,rows.slice(0,2));assert.equal(managedReads,0)
 const all=[...first.items];let cursor=first.nextCursor
 while(cursor){const page=await service.listPage(owner,{limit:2,cursor},true);all.push(...page.items);cursor=page.nextCursor}
 assert.deepEqual(all,await service.list(owner,{},true));assert.equal(new Set(all.map(r=>r.sessionId)).size,9);assert.equal(writes,0)
})
test('owner/普通目录快照变化及缺失分页依赖必须拒绝，旧 list 仍可用',async()=>{
 const rows=[row('A'),row('B')],repository={read:async()=>rows,write:async()=>{throw Error('no writes')}},host={create:async()=>'',inspect:async()=>{}}
 const service=new ConversationService(repository,host,{id:randomUUID,now:()=>date})
 const first=await service.listPage(owner,{limit:1})
 await assert.rejects(service.listPage('other',{cursor:first.nextCursor}),{code:'teloa/conflict'})
 rows[0]={...rows[0],title:'renamed'}
 await assert.rejects(service.listPage(owner,{cursor:first.nextCursor}),{code:'teloa/conflict'})
 const missing=new ConversationService(repository,host,{id:randomUUID,now:()=>date},undefined,async()=>[])
 await assert.rejects(missing.listPage(owner,{},true),{code:'teloa/dependency-unavailable'})
 assert.equal((await missing.list(owner,{},true)).length,2)
 for(const input of [{limit:0},{limit:33},{cursor:'garbage'},{owner:'other'}])await assert.rejects(service.listPage(owner,input),{code:'teloa/invalid-input'})
})

function runFixture(){
 const roleId=randomUUID(),taskId=randomUUID(),stamp=new Date(date),calls=[],candidates=Array.from({length:5},(_,i)=>({id:randomUUID(),task_id:taskId,role_id:roleId,session_id:'managed-'+i}))
 const role={id:roleId,owner_id:owner,version:1,state:'active',created_at:stamp,updated_at:stamp,definition:{name:'岗位',kind:'employee',scopes:['SOC'],duty:'核验',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}}
 const task={id:taskId,owner_id:owner,version:1,state:'completed',assignee_role_id:roleId,assignee_role_version:1,created_at:stamp,updated_at:stamp,definition:{title:'任务',goal:'核验',scope:'SOC',groupId:null,skills:[]}}
 const pool={query:async(sql,args)=>{assert.match(sql,/where owner_id=\$1/);assert.equal(args[0],owner);return {rows:candidates}},connect:async()=>({query:async(sql,args)=>{
  if(sql.includes('teloa_tasks')){assert.equal(args[0],owner);return {rows:[task]}}
  if(sql.includes('teloa_roles')){assert.equal(args[0],owner);return {rows:[role]}}
  return {rows:[]}
 },release(){}})}
 const directory=new RoleRunConversationDirectory(pool,async(actor,id,signal)=>{
  signal?.throwIfAborted();assert.equal(actor,owner);calls.push(id)
  const saved=candidates.find(r=>r.session_id===id)
  return {conversation:{...row(id),purpose:'task-run',run:{taskId,taskVersion:1,roleId,roleVersion:1,agentPresetId:'teloa-standard'}},currentRunId:saved.id,run:{id:saved.id,taskId,roleId,roleVersion:1,sessionId:id,createdAt:date,linkVersion:1,state:'completed',inputText:JSON.stringify({task:{id:taskId,title:'任务',scope:'SOC'}})}}
 })
 return {directory,candidates,calls}
}
test('运行页只规范核验本页候选，使用真实 Task/Role parser；旧 list 校验函数同源',async()=>{
 const f=runFixture(),first=await f.directory.listPage(owner,{limit:2})
 assert.equal(first.items.length,2);assert.equal(f.calls.length,2)
 const all=[...first.items];let cursor=first.nextCursor
 while(cursor){const page=await f.directory.listPage(owner,{limit:2,cursor});all.push(...page.items);cursor=page.nextCursor}
 assert.equal(all.length,5);assert.equal(f.calls.length,5)
 assert.deepEqual(all.map(r=>r.sessionId),(await f.directory.list(owner)).map(r=>r.conversation.sessionId))
})
test('候选换版游标拒绝；取消不读取页面；规范预约归属不符仍按旧规则拒绝',async()=>{
 const f=runFixture(),first=await f.directory.listPage(owner,{limit:1})
 f.candidates[1].id=randomUUID()
 await assert.rejects(f.directory.listPage(owner,{cursor:first.nextCursor}),{code:'teloa/conflict'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(f.directory.listPage(owner,{},controller.signal));assert.equal(f.calls.length,1)
 const broken=new RoleRunConversationDirectory(f.directory.pool,async()=>{throw new WorkError('teloa/storage-corrupt','broken history')})
 await assert.rejects(broken.listPage(owner,{}),{code:'teloa/storage-corrupt'})
 const foreign=new RoleRunConversationDirectory(f.directory.pool,async(...args)=>{const view=await f.directory.readSession(...args);return {...view,conversation:{...view.conversation,ownerId:'other'}}})
 const hidden=await foreign.listPage(owner,{limit:1})
 assert.deepEqual(hidden.items,[]);assert.ok(hidden.nextCursor,'被拒项不让后面的合法历史消失')
})
