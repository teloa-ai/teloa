import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {WorkError,taskReferenceCitationPath} from '@teloa/contract'
import {readTaskRunReferenceCitation} from '../src/work/task-run-reference.ts'
const taskId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',text='固定全文',sourceVersion=createHash('sha256').update(text).digest('hex'),sessionId='trusted-task-session'
const knowledge={id,version:1,title:'固定资料',sourceId:'local_material_test',sourceVersion,scopeIds:['general'],text},path=taskReferenceCitationPath({taskId,resourceId:id,resourceVersion:1,sourceVersion})
function fixture(){
 const state={current:true,withdrawn:false,changed:false,owner:'owner',released:false,queries:[] as string[]}
 const run={id:'33333333-3333-4333-8333-333333333333',taskId,sessionId,state:'ended',evidence:{state:'ended',reason:'completed'},stopRequestedAt:null,knowledge:[knowledge]}
 const db={query:async(q:string)=>{state.queries.push(q);return {rows:[]}},release:()=>{state.released=true}}
 const ports={pool:{connect:async()=>db},runs:{sessionRun:async(owner:string)=>owner===state.owner?{...run,...(state.withdrawn?{state:'withdrawn',evidence:null}:{})}:null,citationScopeInTransaction:async()=>{if(!state.current)throw new WorkError('teloa/forbidden','当前岗位或范围已撤回');return {taskId,sessionId,scope:'general'}}},read:async()=>state.changed?[{...knowledge,text:'更新版本'}]:[knowledge]}
 return {state,ports:ports as never}
}
test('已结束任务来源经只读当前范围重验返回原固定全文',async()=>{
 const f=fixture(),value=await readTaskRunReferenceCitation(f.ports,'owner',{sessionId,path},new AbortController().signal)
 assert.deepEqual(value,{taskId,resourceId:id,resourceVersion:1,sourceVersion,sessionId,sourceId:knowledge.sourceId,title:knowledge.title,text,citationPath:path})
 assert.deepEqual(f.state.queries,['begin','commit']);assert.equal(f.state.released,true)
})
test('其他主体、会话、撤回、失效范围或固定正文变化均不能读取',async()=>{
 for(const kind of ['owner','session','withdrawn','scope','changed','version']){
  const f=fixture();if(kind==='withdrawn')f.state.withdrawn=true;if(kind==='scope')f.state.current=false;if(kind==='changed')f.state.changed=true
  await assert.rejects(readTaskRunReferenceCitation(f.ports,kind==='owner'?'other':'owner',{sessionId:kind==='session'?'other':sessionId,path:kind==='version'?path.replace('/1/','/2/'):path},new AbortController().signal))
 }
})
test('取消不返回正文，也不接受客户端自报授权',async()=>{
 const f=fixture(),c=new AbortController();c.abort()
 await assert.rejects(readTaskRunReferenceCitation(f.ports,'owner',{sessionId,path},c.signal))
 await assert.rejects(readTaskRunReferenceCitation(f.ports,'owner',{sessionId,path,owner:'owner'},new AbortController().signal))
})

test('真实TaskRunService只读范围允许已结项；普通执行口仍拒绝终态，当前撤权均拒绝',async()=>{
 const {TaskRunService}=await import('../src/work/task-runs.ts')
 const {createRunRoleSnapshot}=await import('../src/work/run-role-snapshot.ts'),{readStoredRole}=await import('../src/work/roles.ts')
 const roleId='44444444-4444-4444-8444-444444444444',owner='owner',date=new Date('2026-10-30T00:00:00Z')
 const taskRow={id:taskId,owner_id:owner,version:4,content_version:1,state:'completed',assignee_role_id:roleId,assignee_role_version:1,definition:{title:'任务',goal:'核对原资料',scope:'general',groupId:null,skills:[]},created_at:date,updated_at:date}
 const roleRow={id:roleId,owner_id:owner,version:1,state:'active',definition:{name:'员工',kind:'employee',scopes:['general'],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}},created_at:date,updated_at:date}
 const link={active:true,source_only:false,version:1,conversation_id:'conversation'}
 const run={roleSnapshot:createRunRoleSnapshot(readStoredRole(roleRow),{kind:'task',taskId,taskContentVersion:1},null),id:'33333333-3333-4333-8333-333333333333',taskId,taskVersion:1,roleId,roleVersion:1,sessionId,linkVersion:1,state:'ended',evidence:{state:'ended',reason:'completed'},stopRequestedAt:null,knowledge:[knowledge],inputText:JSON.stringify({task:{id:taskId,version:1,title:'任务',goal:'核对原资料',scope:'general'}})}
 const db={query:async(sql:string)=>{
  if(sql.startsWith('select role_id'))return {rows:[{role_id:roleId}]}
  if(sql.includes('from teloa_roles'))return {rows:[roleRow]}
  if(sql.includes('from teloa_task_runs'))return {rows:[{role_id:roleId}]}
  if(sql.startsWith('select execution_authorization'))return {rows:[{}]}
  if(sql.includes('from teloa_tasks'))return {rows:[taskRow]}
  if(sql.includes('from teloa_object_conversations'))return {rows:[link]}
  if(sql.includes('to_regclass'))return {rows:[{relation:null,present:false}]}
  throw Error('未预期SQL '+sql)
 }}
 const service=new TaskRunService({} as never,{id:()=>run.id,now:()=>date.toISOString()},async()=>({id:'conversation',sessionId,ownerId:owner,status:'ready'}))
 // 固定持久Run读口作为依赖；当前任务/角色/会话/授权使用真实方法与真实契约解析。
 ;(service as any).readVerified=async()=>run
 assert.deepEqual(await service.citationScopeInTransaction(db as never,owner,run.id),{taskId,taskVersion:1,sessionId,linkVersion:1,scope:'general'})
 await assert.rejects(service.executionScopeInTransaction(db as never,owner,{runId:run.id}),{code:'teloa/conflict'})
 for(const [row,key,replacement] of [[roleRow,'state','paused'],[roleRow,'version',2],[taskRow,'state','cancelled'],[taskRow,'content_version',2],[link,'active',false]] as const){
  const original=(row as any)[key];(row as any)[key]=replacement
  await assert.rejects(service.citationScopeInTransaction(db as never,owner,run.id),String(key)+' '+String(replacement))
  ;(row as any)[key]=original
 }
 const before=taskRow.definition.scope;taskRow.definition.scope='other';await assert.rejects(service.citationScopeInTransaction(db as never,owner,run.id));taskRow.definition.scope=before
})
