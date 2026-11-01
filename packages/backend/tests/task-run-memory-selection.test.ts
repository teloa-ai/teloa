import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {RunRoleMemory} from '../src/work/role-memory.ts'
import {assertTaskRunMemoryCurrent,selectTaskRunMemory} from '../src/work/task-run-memory-selection.ts'
import {TaskRunService,roleMemoryNotice} from '../src/work/task-runs.ts'

const memory=(id:string=randomUUID()):RunRoleMemory=>({id,version:1,title:'本例经验',markdown:'仅本例的合成经验。',contentHash:createHash('sha256').update('仅本例的合成经验。').digest('hex'),source:{kind:'self-feedback' as const,id:randomUUID(),version:1},visibility:{kind:'private' as const,scopeIds:[]}})
test('省略沿原授权读口，空选择不读记忆，明确选择必须精确解析全部当前项',async()=>{
 const first=memory(),second=memory(),calls:unknown[]=[]
 const load=async(ids?:readonly string[])=>{calls.push(ids);return ids?[first]:[first,second]}
 assert.deepEqual(await selectTaskRunMemory(undefined,load),[first,second])
 assert.deepEqual(await selectTaskRunMemory([],load),[]);assert.deepEqual(calls,[undefined])
 assert.deepEqual(await selectTaskRunMemory([first.id.toUpperCase()],load),[first]);assert.deepEqual(calls.at(-1),[first.id])
 for(const returned of [[],[second],[first,second]])await assert.rejects(selectTaskRunMemory([first.id],async()=>returned),{code:'teloa/forbidden'})
 await assert.rejects(selectTaskRunMemory([first.id],async()=>{throw Object.assign(Error('失效来源'),{code:'teloa/version-conflict'})}),{code:'teloa/version-conflict'})
})
test('执行前只重验冻结身份：撤回、改版及额外项均拒绝，空选择不查记忆',async()=>{
 const item=memory(),seen:unknown[]=[]
 await assertTaskRunMemoryCurrent([item],async ids=>{seen.push(ids);return [item]})
 assert.deepEqual(seen,[[item.id]])
 for(const rows of [[],[{...item,version:2}],[item,memory()]])await assert.rejects(assertTaskRunMemoryCurrent([item],async()=>rows),{code:'teloa/version-conflict'})
 await assertTaskRunMemoryCurrent([],async()=>{throw Error('空选择不能重查或补回记忆')})
})

function fixed(selection?:string[],contents:ReturnType<typeof memory>[]=selection?.length?[memory(selection[0])]:[]){
 const requestId=randomUUID(),taskId=randomUUID(),roleId=randomUUID(),sessionId='task-run-'+requestId
 const row={id:randomUUID(),owner_id:'synthetic-owner',request_id:requestId,request_spec:{requestId,taskId,expectedTaskVersion:1,roleId,expectedRoleVersion:1,sessionId,expectedLinkVersion:1,...selection===undefined?{}:{selectedMemoryIds:selection}},task_id:taskId,role_id:roleId,task_version:1,role_version:1,link_version:1,session_id:sessionId,native_request_id:randomUUID(),state:'prepared',evidence:null,created_at:new Date('2026-11-01T00:00:00Z'),allowed_tools:[],role_memory:contents,input_text:JSON.stringify({task:{id:taskId,version:1,title:'本例任务',goal:'仅核对合成资料',scope:'general'},role:{id:roleId,version:1,name:'本例岗位',duty:'核对',dataScope:'本例',executionScope:'只读'},...contents.length?{memory:{notice:roleMemoryNotice,contents}}:{}})}
 const queries:string[]=[],db={query:async(sql:string,params?:unknown[])=>{queries.push(sql);const owned=!sql.includes('where owner_id=$1')||params?.[0]===row.owner_id,identity=sql.includes('request_id=$2')?row.request_id:sql.includes('session_id=$2')?row.session_id:row.id;return {rows:owned&&params?.[1]===identity&&sql.startsWith('select * from teloa_task_runs')?[row]:[]}},release(){}}
 const service=new TaskRunService({connect:async()=>db} as unknown as Pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>{throw Error('冷读不打开原生会话')},{allowedTools:[],roleMemory:async()=>{throw Error('冷读不能重新自动选择')}})
 return {row,queries,service,request:{requestId,taskId,expectedTaskVersion:1}}
}
test('新选择冷读与旧省略快照沿真实Run reader，均不重查或改写记忆正文',async()=>{
 for(const f of [fixed(),fixed([]),fixed([randomUUID()])]){
  const before=JSON.stringify(f.row),run=await f.service.get('synthetic-owner',{runId:f.row.id})
  assert.deepEqual(run.memory,f.row.role_memory);assert.equal(JSON.stringify(f.row),before)
  assert.ok(f.queries.every(sql=>!/^(insert|update|delete)\b/i.test(sql)))
 }
 const bad=fixed([randomUUID()],[])
 await assert.rejects(bad.service.get('synthetic-owner',{runId:bad.row.id}),{code:'teloa/storage-corrupt'})
})
test('一键前置幂等读口核对明确选择，省略与空集合不能借同requestId互换',async()=>{
 for(const selection of [undefined,[],[randomUUID()]]){
  const f=fixed(selection),request={...f.request,...selection===undefined?{}:{selectedMemoryIds:selection}}
  assert.equal((await f.service.request('synthetic-owner',request))?.id,f.row.id)
  const changed={...f.request,...selection===undefined?{selectedMemoryIds:[]}:selection.length?{selectedMemoryIds:[]}:{}}
  await assert.rejects(f.service.request('synthetic-owner',changed),{code:'teloa/conflict'})
 }
})
test('准备查询保留入场时选择，等待存储期间改参数不能把不匹配请求变为成功',async()=>{
 const f=fixed([randomUUID()]),request={...f.request,selectedMemoryIds:[] as string[]},pending=f.service.request('synthetic-owner',request)
 request.selectedMemoryIds=f.row.role_memory.map(item=>item.id)
 await assert.rejects(pending,{code:'teloa/conflict'})
})
test('会话预约从原request_spec保留三义，冷读不重新召回或重写固定输入',async()=>{
 for(const selection of [undefined,[],[randomUUID()]]){
  const f=fixed(selection),before=JSON.stringify(f.row),run=await f.service.requestForSession('synthetic-owner',{...f.request,sessionId:f.row.session_id})
  assert.equal(run?.id,f.row.id);assert.deepEqual(run?.memory,f.row.role_memory)
  assert.equal(Object.hasOwn(f.row.request_spec,'selectedMemoryIds'),selection!==undefined)
  assert.equal(JSON.stringify(f.row),before);assert.ok(f.queries.every(sql=>!/^(insert|update|delete)\b/i.test(sql)))
 }
})
test('会话预约仍绑定owner、原任务/版本/会话，不能由调用者改为其他经验选择',async()=>{
 const f=fixed([randomUUID()]),input={...f.request,sessionId:f.row.session_id},before=JSON.stringify(f.row)
 assert.equal(await f.service.requestForSession('other-owner',input),null)
 assert.equal(await f.service.requestForSession('synthetic-owner',{...input,requestId:randomUUID()}),null)
 for(const changed of [{taskId:randomUUID()},{expectedTaskVersion:2},{sessionId:'another-session'}])await assert.rejects(f.service.requestForSession('synthetic-owner',{...input,...changed}),{code:'teloa/conflict'})
 await assert.rejects(f.service.requestForSession('synthetic-owner',{...input,selectedMemoryIds:[]}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.requestForSession('synthetic-owner',{...input,sessionId:''}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.request('synthetic-owner',{...f.request,selectedMemoryIds:[]}),{code:'teloa/conflict'})
 assert.equal(JSON.stringify(f.row),before)
})
test('撤回运行仍可只读原预约，冷读不能恢复既有工具或重查经验',async()=>{
 const f=fixed([randomUUID()]);f.row.state='withdrawn';Object.assign(f.row,{allowed_tools:['fixture_read']})
 const before=JSON.stringify(f.row),run=await f.service.requestForSession('synthetic-owner',{...f.request,sessionId:f.row.session_id})
 assert.equal(run?.state,'withdrawn');assert.deepEqual(run?.allowedTools,['fixture_read'])
 assert.deepEqual((await f.service.toolPolicy('synthetic-owner',{sessionId:f.row.session_id}))?.allowedTools,[])
 assert.equal(JSON.stringify(f.row),before);assert.ok(f.queries.every(sql=>!/^(insert|update|delete)\b/i.test(sql)))
})
