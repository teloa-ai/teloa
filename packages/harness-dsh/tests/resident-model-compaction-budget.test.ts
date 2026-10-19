import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {TokenMeter} from '@deepseek-ai/dsh-token-meter'
import {ToolCallId,createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets} from '../../backend/src/work/work-budget.ts'
import {WorkRetryService,initializeWorkRetries} from '../../backend/src/work/work-retries.ts'
import {installResidentModelBudget,modelOperationId} from '../src/resident-model-budget.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import type {nativeHotCausalityFixture} from './fixtures/native-hot-causality.ts'

// 真实提供方回执带用量；缺少用量会保留预留并占住并发位。
const usage:StreamChunk={type:'usage',usage:{inputTokens:7,outputTokens:3,totalTokens:10}}
// 实跑形态（3110 E03 事件 79/80、89/90）：同一 turn 内第二次 pre-step 自动压缩以“原模型操作已经完成”失败。
const text=(value:string):readonly StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},usage,{type:'finish',reason:{kind:'stop'}}]
const tool=(id:string):readonly StreamChunk[]=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId(id),name:'hot_result',argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name:'hot_result',arguments:'{}'}},
 usage,
 {type:'finish',reason:{kind:'tool-calls'}},
]

/** 官方摘要请求证明补丁与产品因果源码的同一副本图；压缩引擎直接用官方 BasicCompactionEngine。 */
async function compactionFixture(t:TestContext){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-compaction-basic')>(t,{packageName:'@deepseek-ai/dsh-compaction-basic',compatBasename:'dsh-compaction-basic-0.2.1-rc.2-summary-request'})
 const basic=pathToFileURL(join(pkg.root,'lib/index.js')).href
 const copy=async(relative:string,name:string,replacements:Record<string,string>={})=>{
  const origin=new URL(relative,import.meta.url),require=createRequire(origin)
  const source=(await readFile(origin,'utf8')).replace(/from (['"])([^'"]+)\1/g,(original,_quote,specifier:string)=>{
   if(specifier.startsWith('node:'))return original
   const target=replacements[specifier]??(specifier.startsWith('.')?new URL(specifier,origin).href:pathToFileURL(require.resolve(specifier)).href)
   return 'from '+JSON.stringify(target)
  })
  const file=join(pkg.root,name);await writeFile(file,source);return pathToFileURL(file).href
 }
 const causality=await copy('../src/native-work-causality.ts','budget-native-work-causality.ts',{'@deepseek-ai/dsh-compaction-basic':basic})
 const input=await copy('../src/native-work-input.ts','budget-native-work-input.ts',{'./native-work-causality.ts':causality})
 const kernel=await copy('./fixtures/native-hot-causality.ts','budget-native-hot-causality.ts',{'../../src/native-work-input.ts':input})
 const module=await import(kernel) as {nativeHotCausalityFixture:typeof nativeHotCausalityFixture}
 const f=await module.nativeHotCausalityFixture(t)
 await f.ctx.plugin(TokenMeter)
 return {f,engine:pkg.namespace.BasicCompactionEngine}
}

test('同一turn内两次pre-step自动压缩各自独立受控并成功提交；同一次压缩按持久身份重放不再派发',{timeout:60000},async t=>{
 const db=await setupRoleWork();t.after(db.close)
 await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializeWorkRetries(db.pool)
 const {f,engine}=await compactionFixture(t),{agent}=f,{owner,role}=await roleFixture(db.pool,'employee')
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(db.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'长取证压缩',goal:'逐项核对取证资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:agent.id,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId:agent.id,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId:agent.id,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 await runs.claim(owner,{runId:run.id})
 const controls=new WorkControlService(db.pool,identity),budgets=new WorkBudgetService(db.pool,identity,ownerAuthority),reports:string[]=[]
 const close=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async id=>id===agent.id?await runs.get(owner,{runId:run.id}):null,nativeInput:f.work,report:code=>reports.push(code)})
 t.after(close)

 // 每个工具回执落盘后收紧窗口，使下一 step 的官方 pre-step 压力检查实际触发压缩；压缩结束即恢复。
 let window=1_000_000,pressure=[2400,400]
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:window},defaultMaxTokens:256})
 await agent.ctx.plugin(engine,{headroomTokens:128,maxTokens:256,retainTokens:0,compactionRetries:0,maxOverflowRetries:1})
 agent.ctx.on('session/event',(_session,event)=>{
  if(event.type==='tool/result')window=pressure.shift()??window
  if(event.type==='compaction/end')window=1_000_000
 })
 f.adapter.scripts.push(tool('forensics-1'),text('第一次摘要。'),tool('forensics-2'),text('第二次摘要。'),text('核对完成'))
 const message=createUserMessage({source:{kind:'user',rpcId:'long-forensics'},content:[{type:'text',text:'原始取证资料：'+'a'.repeat(9000)}]})
 await f.work.withNewInput(agent,message,{producer:'prompt',identity:'long-forensics'},()=>agent.followup(message))
 await agent.whenIdle()

 const events=f.events()
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','compaction','main','compaction','main'],'两次压缩都在同一 turn 的 pre-step 发生')
 const ends=events.filter(event=>event.type==='compaction/end')
 assert.equal(ends.length,2);assert.deepEqual(ends.map(event=>event.type==='compaction/end'&&event.data.error),[undefined,undefined],'两次压缩都真实提交')
 assert.deepEqual(events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[]),['completed'])
 assert.deepEqual(reports,[])

 // 持久日志在每次 compaction/start 时的前缀即重放所见；同一次压缩的身份可复算且各次不同。
 const summary=f.adapter.requests[1]!,starts=events.flatMap((event,index)=>event.type==='compaction/start'?[{event,index}]:[])
 assert.equal(starts.length,2)
 const ids=starts.map(({event,index})=>event.type==='compaction/start'&&modelOperationId(events.slice(0,index+1),{sessionId:agent.id,turn:event.data.turn!,step:0},run.id,summary)) as string[]
 assert.notEqual(ids[0],ids[1],'同一 turn 的两次压缩是两个模型操作')
 const rows=(await db.pool.query('select operation_id,attempts,completed from teloa_work_retries where owner_id=$1 order by created_at,operation_id',[owner])).rows
 assert.equal(rows.length,5,'三次主请求与两次压缩各登记一个操作');assert.ok(rows.every(row=>row.attempts===1&&row.completed===true),JSON.stringify(rows))
 for(const id of ids)assert.ok(rows.some(row=>row.operation_id===id),'压缩操作身份来自其持久 compaction/start')
 assert.equal((await db.pool.query("select count(*)::int count from teloa_work_budget_reservations where owner_id=$1 and kind='retry' and state='settled'",[owner])).rows[0].count,5)

 const retries=new WorkRetryService(db.pool,identity,{controls})
 for(const operationId of ids){
  const replay=await retries.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1})
  assert.equal(replay.dispatch,false,'同一次压缩重放回到原操作，不重复派发')
 }
 assert.equal(f.adapter.requests.length,5)
})
