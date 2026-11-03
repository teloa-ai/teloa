import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjects} from '../src/work/projects.ts'
import {initializeProjectContext} from '../src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService,type ProjectRuntimeActor,type ProjectRuntimePrepared,type ProjectRuntimePorts} from '../src/work/project-runtime.ts'

test('真实PG：独立员工采用本地经验，续问只沿实际派发来源，编辑撤回与冷恢复保持版本边界',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),roleId=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 let roleVersion=1,reads=0
 const entry=(id:string,title:string,markdown:string,version=1,scopeIds=['general'])=>({kind:'role' as const,id,title,markdown,version,scopeIds,hash:createHash('sha256').update(markdown).digest('hex')})
 let entries=[entry('refund','合成订单摘要','合成订单摘要页尾使用青鹭归档-5927'),entry('unrelated','维修','更换电池使用钴蓝编号')]
 const ports:ProjectRuntimePorts={inspect:async(_owner,sessionId)=>({sessionId,title:'验收员工',scope:'general',scopes:['general','support'],submitted:false,running:false,kind:'employee',roleId,roleKind:'employee',roleVersion}),optionalMemories:async()=>{reads++;return entries}}
 const runtime=new ProjectRuntimeService(pool,identity,ports);t.after(()=>runtime.dispose())
 const prepare=(messageId:string,query:string)=>runtime.prepare(owner,{sessionId:'employee-local',messageId,query})
 const dispatched=async(p:ProjectRuntimePrepared)=>{await runtime.recordUsed(owner,{manifestId:p.manifestId,generation:p.binding.generation,promptHash:'a'.repeat(64)});await runtime.ackGeneration(owner,{sessionId:p.binding.sessionId,generation:p.binding.generation})}
 const first=await prepare('first','请总结合成订单摘要')
 assert.ok(first,'无项目的员工也必须进入统一经验链路');assert.equal(first.binding.projectId,null);assert.equal(first.binding.memoryMode,'enabled')
 assert.match(first.text,/青鹭归档-5927/);assert.doesNotMatch(first.text,/钴蓝编号/);assert.deepEqual(first.sources.map(s=>s.id),['refund'])
 assert.match(first.text,/owner confirmation/);assert.doesNotMatch(first.text,/After this turn, the app checks sources/)
 await dispatched(first)
 // 已确认但此前未召回的经验不能因短续问混入当前工作。
 entries.push(entry('later','其他岗位经验','近期新增的龙舟代号'))
 const next=await prepare('continue','按刚才的方法继续');assert.ok(next);assert.match(next.text,/青鹭归档-5927/);assert.doesNotMatch(next.text,/龙舟代号|钴蓝编号/);assert.equal(next.binding.generation,first.binding.generation);assert.equal(next.reset,false)
 await dispatched(next)
 // 独立新会话可召回同一真源；冷建服务不能依赖进程内候选缓存。
 const cold=new ProjectRuntimeService(pool,identity,ports);t.after(()=>cold.dispose())
 const fresh=await cold.prepare(owner,{sessionId:'employee-fresh',messageId:'fresh',query:'请总结合成订单摘要'});assert.ok(fresh);assert.match(fresh.text,/青鹭归档-5927/)
 entries=entries.map(e=>e.id==='refund'?entry('refund',e.title,'合成订单摘要页尾使用苍鹰归档-6713',2):e)
 await assert.rejects(prepare('vague-after-edit','继续'),{code:'teloa/invalid-input',details:{reason:'employee-context-goal-required'}})
 const changed=await prepare('after-edit','重新核对合成订单摘要');assert.ok(changed);assert.ok(changed.binding.generation>next.binding.generation);assert.equal(changed.reset,true);assert.match(changed.text,/苍鹰归档-6713/);assert.doesNotMatch(changed.text,/青鹭归档-5927/);assert.equal(changed.sources.find(s=>s.id==='refund')?.version,2)
 await dispatched(changed)
 entries=entries.filter(e=>e.id!=='refund')
 await assert.rejects(prepare('vague-after-withdraw','繼續'),{code:'teloa/invalid-input',details:{reason:'employee-context-goal-required'}})
 const withdrawn=await prepare('after-withdraw','重新核对合成订单摘要');assert.ok(withdrawn);assert.ok(withdrawn.binding.generation>changed.binding.generation);assert.doesNotMatch(withdrawn.text,/苍鹰归档-6713|青鹭归档-5927/);await dispatched(withdrawn)
 roleVersion++
 const roleChanged=await prepare('role-changed','重新核对合成订单摘要');assert.ok(roleChanged);assert.ok(roleChanged.binding.generation>withdrawn.binding.generation,'岗位版本变化清理旧模型背景');assert.ok(reads>0)
})

test('真实PG：员工经验遵守当前业务、既有关闭策略和输入预算；普通会话不自动绑定',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},roleId=randomUUID()
 let kind:ProjectRuntimeActor['kind']='ordinary',reads=0
 const ports:ProjectRuntimePorts={maxContextChars:1200,inspect:async(_owner,sessionId)=>({sessionId,title:'范围验收',scope:'general',scopes:['general','support'],submitted:false,running:false,kind,roleId,roleKind:'employee'}),optionalMemories:async()=>{reads++;return [
  {kind:'role',id:'shared',title:'订单规则',markdown:'共享订单规则 BLUE',version:1,hash:'a'.repeat(64),scopeIds:['general','support']},
  {kind:'role',id:'support',title:'订单规则',markdown:'客服订单规则 RED',version:1,hash:'b'.repeat(64),scopeIds:['support']},
  {kind:'role',id:'oversized',title:'订单规则',markdown:'过长订单规则'.repeat(2000),version:1,hash:'c'.repeat(64),scopeIds:['general']},
 ]}}
 const runtime=new ProjectRuntimeService(pool,identity,ports);t.after(()=>runtime.dispose())
 assert.equal(await runtime.prepare(owner,{sessionId:'ordinary',messageId:'first',query:'订单规则'}),null)
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'memory-off',projectId:null,expectedVersion:0,memoryMode:'off'})
 kind='employee'
 const off=await runtime.prepare(owner,{sessionId:'memory-off',messageId:'off',query:'订单规则'});assert.ok(off);assert.equal(reads,0);assert.equal(off.binding.memoryMode,'off');assert.match(off.text,/Long-term memory is off/);assert.doesNotMatch(off.text,/BLUE|RED/)
 const scoped=await runtime.prepare(owner,{sessionId:'scoped',messageId:'scoped',query:'订单规则'});assert.ok(scoped);assert.match(scoped.text,/BLUE/);assert.doesNotMatch(scoped.text,/RED|过长订单规则/);assert.ok(scoped.text.length<=1200)
 assert.deepEqual(scoped.sources.map(s=>s.id),['shared'])
 const manifest=(await pool.query('select omitted from teloa_project_context_uses where id=$1',[scoped.manifestId])).rows[0]
 assert.ok(manifest.omitted.some((row:{reason:string})=>row.reason.includes('输入预算')))
})
