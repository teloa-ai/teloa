import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {methodReuseBasisHash,readPageCreatePlanDraft,type SavedArtifactVersion} from '@teloa/contract'
import {registerMethodReuseTools,type MethodReuseToolsPorts} from '../src/method-reuse-tools.ts'
import {methodPlanDraftExample,configurePlanDraftExample} from '../src/plan-draft-guide.ts'

const owner='local:method-tools',artifactId='10000000-0000-4000-8000-000000000001',rpcId='20000000-0000-4000-8000-000000000001'
const artifact:SavedArtifactVersion={artifactId,ownerId:owner,number:1,source:{kind:'session',id:'original-session',scope:'general',version:'original-binding',title:'原会话'},content:{title:'客户摘要',sections:[{id:'summary',title:'摘要',text:'只根据提供的资料。'}],snapshotIds:[],note:'合成资料'},createdAt:'2026-10-17T00:00:00.000Z'}
const source={artifactId,version:1,basisHash:await methodReuseBasisHash(artifact)}
assert.ok('definition'in methodPlanDraftExample)
const planBody={...methodPlanDraftExample,source}
async function setup(overrides:Partial<MethodReuseToolsPorts>={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('method-tools-session'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'请将这份成果保存为计划，先不启用。'}]}),{surfaceOp:'append'})
 const calls:unknown[]=[]
 const ports:MethodReuseToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,skillCreator:null,source:async()=>({source,artifact}),prepare:async(input,signal,check)=>{signal.throwIfAborted();await check();calls.push(input);return {id:'30000000-0000-4000-8000-000000000001',ownerId:owner,requestId:input.requestId,entity:input.target,body:JSON.stringify(input.body),bodyHash:'b'.repeat(64),title:'客户摘要',status:'draft',createdAt:artifact.createdAt,updatedAt:artifact.createdAt}},...overrides}
 registerMethodReuseTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>,callId='once')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}

test('新建方法计划整体缺省budget才用当前本人策略；显式6000和已有配置不被覆盖',async t=>{
 const current={...planBody.work.budget,maxTokens:12000,maxRetries:0,money:null};let reads=0
 const e=await setup({defaultPlanBudget:async()=>{reads++;return current}});t.after(()=>e.ctx.fiber.dispose())
 const omitted=JSON.parse(JSON.stringify(planBody));delete omitted.work.budget
 const before=JSON.stringify(omitted),schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_method_reuse')!
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,{target:'plan',source,plan:omitted}),[])
 assert.equal((await e.call('teloa_method_reuse',{target:'plan',source,plan:omitted},'owner-default')).isError,false)
 const saved=e.calls.at(-1) as {body:unknown},body=readPageCreatePlanDraft(saved.body)
 assert.deepEqual(body.work.budget,current);assert.equal(body.intent,'save-paused');assert.equal(JSON.stringify(omitted),before)
 const explicit={...planBody,work:{...planBody.work,budget:{...current,maxTokens:6000}}},count=reads
 assert.equal((await e.call('teloa_method_reuse',{target:'plan',source,plan:explicit},'explicit-6000')).isError,false)
 assert.equal(readPageCreatePlanDraft((e.calls.at(-1) as {body:unknown}).body).work.budget.maxTokens,6000)
 assert.equal(reads,count,'显式额度不读取或合并默认策略')
 const configured=JSON.parse(JSON.stringify(configurePlanDraftExample));delete configured.work.budget
 assert.equal((await e.call('teloa_method_reuse',{target:'plan',source,plan:configured},'no-config-default')).isError,true)
 assert.equal(e.calls.length,2)
 const unavailable=await setup();t.after(()=>unavailable.ctx.fiber.dispose())
 assert.equal((await unavailable.call('teloa_method_reuse',{target:'plan',source,plan:omitted})).isError,true)
 assert.deepEqual(unavailable.calls,[])
})

test('方法来源只读工具核固定成果版本与摘要，不接受跨本人或伪造摘要',async t=>{
 const valid=await setup();t.after(()=>valid.ctx.fiber.dispose())
 const result=await valid.call('teloa_method_source',{artifactId,version:1})
 assert.equal(result.isError,false)
 // 模型收到来源角色，但完整成果与可信来源原值不被改写或缩减。
 assert.deepEqual(JSON.parse(result.value as string),{source,artifact,sourceRole:'method-draft-provenance'});assert.deepEqual(valid.calls,[])
 for(const changed of [{artifact:{...artifact,ownerId:'foreign'}},{artifact:{...artifact,number:2}},{source:{...source,basisHash:'0'.repeat(64)}}]){
  const e=await setup({source:async()=>({source,artifact,...changed})});t.after(()=>e.ctx.fiber.dispose())
  assert.equal((await e.call('teloa_method_source',{artifactId,version:1})).isError,true)
 }
})

test('方法草稿原生来源由宿主固定，同调用重试不换请求身份，工具不能自报本人批准',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const args={target:'plan',source,plan:planBody}
 const schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_method_reuse')!
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 assert.equal((await e.call('teloa_method_reuse',args)).isError,false)
 assert.equal((await e.call('teloa_method_reuse',args)).isError,false)
 const calls=e.calls as Array<{requestId:string;acceptedSource:{sessionId:string;messageId:string;messageSeq:number;requestId:string};body:unknown}>
 assert.equal(calls.length,2);assert.equal(calls[0]!.requestId,calls[1]!.requestId)
 assert.equal(calls[0]!.acceptedSource.requestId,rpcId);assert.equal(calls[0]!.acceptedSource.sessionId,e.agent.session.id)
 assert.notEqual(calls[0]!.acceptedSource.requestId,calls[0]!.requestId)
 assert.equal((await e.call('teloa_method_reuse',{...args,acceptedSource:calls[0]!.acceptedSource})).isError,true)
 assert.equal(calls.length,2)
})

test('任务执行身份或读取期间换本人指令，不能继续读取或写入方法草稿',async t=>{
 let blockedReads=0
 const blocked=await setup({readTaskPolicy:async()=>({kind:'history'}) as never,source:async()=>{blockedReads++;return {source,artifact}}});t.after(()=>blocked.ctx.fiber.dispose())
 assert.equal((await blocked.call('teloa_method_source',{artifactId})).isError,true);assert.equal(blockedReads,0)
 let change!:()=>void
 const stale=await setup({source:async()=>{change();return {source,artifact}}});t.after(()=>stale.ctx.fiber.dispose())
 change=()=>stale.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'40000000-0000-4000-8000-000000000001'},content:[{type:'text',text:'取消保存。'}]}),{surfaceOp:'append'})
 assert.equal((await stale.call('teloa_method_source',{artifactId})).isError,true)
 assert.deepEqual(stale.calls,[])
})

test('真实 SDK 的方法计划 schema 拒绝错型并返回叶路径，不纠型或写入草稿',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const [body,path]of [
  [{...planBody,work:{...planBody.work,triggers:{item:planBody.work.triggers[0]}}},'plan.work.triggers'],
  [{...planBody,work:{...planBody.work,safeRecovery:'false'}},'plan.work.safeRecovery'],
  [{...planBody,work:{...planBody.work,budget:{...planBody.work.budget,maxTokens:'6000'}}},'plan.work.budget.maxTokens'],
  [{...planBody,work:{...planBody.work,budget:{...planBody.work.budget,money:'null'}}},'plan.work.budget.money'],
  [{...planBody,work:{...planBody.work,budget:{...planBody.work.budget,money:{currency:'CNY',maxMinorUnits:'1000'}}}},'plan.work.budget.money.maxMinorUnits'],
  [{...planBody,definition:{...planBody.definition,roleId:'null'}},'plan.definition.roleId'],
  [{...planBody,definition:{...planBody.definition,scope:'support'}},'plan.definition.scope'],
  [{...planBody,source:{...source,version:'1'}},'plan.source.version'],
 ] as const){
  const result=await e.call('teloa_method_reuse',{target:'plan',source,plan:body},String(path))
  assert.equal(result.isError,true)
  assert.match(result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),new RegExp(path.replaceAll('.','\\.')))
 }
 assert.deepEqual(e.calls,[])
})

test('真实注册工具将新建缺省空值转为原reader可读正文，保留来源与明确费用上限且不修改入参',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const omitted=JSON.parse(JSON.stringify(planBody));delete omitted.definition.roleId;delete omitted.work.budget.money
 const capped=structuredClone(omitted);capped.work.budget.money={currency:'SGD',maxMinorUnits:250}
 const staff=structuredClone(omitted);delete staff.definition.executor;staff.definition.roleId=artifactId;staff.definition.expectedRoleVersion=2
 const schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_method_reuse')!
 for(const [index,plan]of [omitted,capped,staff].entries()){
  const before=JSON.stringify(plan),args={target:'plan',source,plan}
  assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
  assert.equal((await e.call('teloa_method_reuse',args,'default-'+index)).isError,false)
  assert.equal(JSON.stringify(plan),before,'只返回canonical副本，不改原参数')
  const saved=e.calls.at(-1) as {source:unknown;acceptedSource:{requestId:string};body:unknown},canonical=readPageCreatePlanDraft(saved.body)
  assert.ok('definition'in canonical)
  assert.equal(canonical.definition.roleId,index===2?artifactId:null)
  assert.deepEqual(canonical.work.budget.money,index===1?{currency:'SGD',maxMinorUnits:250}:null)
  assert.deepEqual(saved.source,source);assert.deepEqual(canonical.source,source)
  assert.equal(saved.acceptedSource.requestId,rpcId);assert.equal(canonical.intent,'save-paused')
 }
 assert.equal(e.calls.length,3)
})

test('真实注册工具拒绝伪空值、员工缺身份和配置缺money，全部零写入',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const withoutMoney=JSON.parse(JSON.stringify(configurePlanDraftExample));delete withoutMoney.work.budget.money
 const withoutRole=JSON.parse(JSON.stringify(planBody));delete withoutRole.definition.executor;delete withoutRole.definition.roleId;withoutRole.definition.expectedRoleVersion=2
 const invalid=[withoutMoney,withoutRole]
 for(const value of ['null',{},{$text:'null'}]){
  invalid.push({...planBody,definition:{...planBody.definition,roleId:value}})
  invalid.push({...planBody,work:{...planBody.work,budget:{...planBody.work.budget,money:value}}})
 }
 for(const [index,plan]of invalid.entries())assert.equal((await e.call('teloa_method_reuse',{target:'plan',source,plan},'invalid-default-'+index)).isError,true)
 assert.deepEqual(e.calls,[])
})

test('原实模失败的明确零重试与6000预算在真实工具中保留，不为通过而改1',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 // 实模两次失败的同一结构与数值；身份和来源复用本文件合成fixture，不公开运行标识。
 const plan=JSON.parse(JSON.stringify(planBody)),schedule={kind:'schedule',cadence:'daily',weekday:1,time:'15:16',timezone:'UTC'}
 delete plan.definition.roleId;plan.definition.trigger=schedule
 plan.work.triggers=[{kind:'schedule',schedule}]
 plan.work.budget={maxGoalRounds:2,maxTokens:6000,maxElapsedMs:180000,maxConcurrent:1,maxRetries:0,stagnationRounds:1}
 const args={target:'plan',source,plan},before=JSON.stringify(args),schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_method_reuse')!
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 assert.equal((await e.call('teloa_method_reuse',args,'captured-explicit-zero')).isError,false)
 assert.equal(JSON.stringify(args),before,'不改写零重试或原6000上限')
 const body=(e.calls[0] as {body:unknown}).body,canonical=readPageCreatePlanDraft(body)
 assert.deepEqual(canonical,body);assert.ok('definition'in canonical)
 assert.equal(canonical.definition.roleId,null);assert.equal(canonical.work.budget.money,null)
 assert.deepEqual(canonical.work.budget,{maxGoalRounds:2,maxTokens:6000,maxElapsedMs:180000,maxConcurrent:1,maxRetries:0,stagnationRounds:1,money:null})
 assert.deepEqual(canonical.source,source);assert.equal(canonical.intent,'save-paused');assert.equal(e.calls.length,1)
})

test('方法计划使用原严格 reader 拒绝本人群授权和不一致日程，不放宽 SDK 形状以外的规则',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const mismatched=structuredClone(planBody)
 if(mismatched.work.triggers[0]?.kind==='schedule')mismatched.work.triggers[0]={kind:'schedule',schedule:{...mismatched.work.triggers[0].schedule,time:'10:45'}}
 const invalidBudget=structuredClone(planBody);invalidBudget.work.budget.maxRetries=-1
 for(const plan of [mismatched,invalidBudget,{...planBody,definition:{...planBody.definition,groupId:'30000000-0000-4000-8000-000000000001'}}])assert.equal((await e.call('teloa_method_reuse',{target:'plan',source,plan})).isError,true)
 assert.deepEqual(e.calls,[])
})
