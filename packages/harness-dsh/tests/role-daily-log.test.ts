import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,type RoleDailyLog} from '@teloa/contract'
import type {RoleDayEvidence,RoleDigestRunIdentity} from '@teloa/backend'
import {createRoleDailyLogHandler,registerRoleDailyDigestTools,roleDailyDigestSubmitToolName,roleDailyDigestToolNames,roleDailyLogEndpoints,roleDayEvidenceToolName,type RoleDailyDigestToolPorts} from '../src/role-daily-log.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {externalEgressTools,mcpResourceTools,orchestrationTools,delegationTools} from '../src/role-tool-grants.ts'

const owner='local:teloa-owner'
const roleId='22222222-2222-4222-8222-222222222222'
const runId='33333333-3333-4333-8333-333333333333'
const taskId='44444444-4444-4444-8444-444444444444'
const planId='55555555-5555-4555-8555-555555555555'
const logId='66666666-6666-4666-8666-666666666666'
const memoryId='77777777-7777-4777-8777-777777777777'
const nativeRequestId='88888888-8888-4888-8888-888888888888'
const digestIdentity:RoleDigestRunIdentity={runId,taskId,planId,roleId,roleVersion:2,day:'2026-09-21'}
const dayEvidence:RoleDayEvidence={day:'2026-09-21',roleId,roleVersion:2,scopeIds:['SOC'],runs:[{kind:'run',id:runId,version:1,title:'当天运行'}],artifacts:[],approvals:[],revisions:[],groupMessages:[]}
/** 闸拒绝的理由固定中文，不含会话 id、工具参数、数据库文本或上游异常消息。 */
const denied='这两个工具只能在 Auto Dream 的每日小结运行里使用。'
const savedLog:RoleDailyLog={id:logId,ownerId:owner,roleId,roleVersion:2,kind:'daily-digest',day:'2026-09-21',state:'kept',runId,title:'今天的小结',markdown:'今天复核了三条告警。',scopeIds:['SOC'],evidence:[{kind:'run',id:runId,version:1,title:'当天运行'}],pruneHints:[{memoryId,memoryStateVersion:1,reason:'已经过时。'}],createdAt:'2026-09-21T15:30:00.000Z',discardedAt:null}
/** 守卫层自己的固定理由：谱系断链时它先答，小结闸根本轮不到。 */
const guardDenied='无法核对任务执行权限，请先恢复授权服务。'
const unknownDenied='无法核对当前运行是否属于 Auto Dream 的每日小结。'
const submission={title:'今天的小结',markdown:'今天复核了三条告警。',candidates:[{title:'复核证据',markdown:'交付前复核证据。',scopeIds:['SOC']}],pruneHints:[{memoryId,reason:'已经过时。'}]}

test('三个每日日志读口接进 endpointSet 与分派，且不多出第四个',async()=>{
 assert.deepEqual([...roleDailyLogEndpoints],['role-daily-log/list','role-daily-log/get','role-daily-log/discard'])
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/const endpointSet=new Set\([^\n]*\.\.\.roleMemoryEndpoints,\.\.\.roleDailyLogEndpoints/)
 assert.match(source,/\(roleDailyLogEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await roleDailyLogHandler\(endpoint,payload\)/)
 // 端点只能经 roleDailyLogEndpoints 接入；宿主里写死第四个端点字面量即判红。
 assert.doesNotMatch(source,/'role-daily-log\//)
})

test('每日日志 RPC 固定为本人，未知接口与伪造主体不落到服务方法',async()=>{
 const calls:unknown[][]=[],backend={
  list:async(actor:unknown,input:unknown)=>{calls.push(['list',actor,input]);return {items:[]}},
  get:async(actor:unknown,input:unknown)=>{calls.push(['get',actor,input]);return {log:{id:logId}}},
  discard:async(actor:unknown,input:unknown)=>{calls.push(['discard',actor,input]);return {log:{id:logId,state:'discarded'}}},
 }
 const handle=createRoleDailyLogHandler(owner,async()=>backend,async()=>({role:async()=>undefined,ensureForDay:async()=>undefined}))
 await handle('role-daily-log/list',{roleId})
 await handle('role-daily-log/get',{roleId,logId})
 await handle('role-daily-log/discard',{requestId:nativeRequestId,logId,expectedState:'kept'})
 assert.deepEqual(calls,[
  ['list',{ownerId:owner,kind:'human'},{roleId}],
  ['get',{ownerId:owner,kind:'human'},{roleId,logId}],
  ['discard',{ownerId:owner,kind:'human'},{requestId:nativeRequestId,logId,expectedState:'kept'}],
 ])
 await assert.rejects(handle('role-daily-log/create',{}),{code:'teloa/not-found'})
 await assert.rejects(handle('role-daily-log/list',{roleId,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('role-daily-log/get',{roleId,logId,kind:'agent'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('role-daily-log/discard',{requestId:nativeRequestId,logId,expectedState:'discarded'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,3)
})

async function setupTool(overrides:Partial<RoleDailyDigestToolPorts>={}){
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('role-daily-log-run'),agentOptions:{provider:'test',model:'test'}}),calls:unknown[][]=[]
 let policy:string[]=['read_mcp_resource']
 const bodies:string[]=[]
 // 这两个工具在小结运行外是合法的：一个由岗位授权清单放行，一个走自授权集。
 for(const name of ['read_mcp_resource',roleMemoryProposalToolName])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies.push(name);return 'executed'}}))
 const ports:RoleDailyDigestToolPorts={
  owner,
  run:async sessionId=>({id:runId,sessionId,state:'active'}),
  digestRun:async id=>{calls.push(['digestRun',id]);return digestIdentity},
  evidence:async value=>{calls.push(['evidence',value]);return dayEvidence},
  submit:async(value,requestId,input)=>{calls.push(['submit',value,requestId,input]);return {log:savedLog,candidates:[]}},
  ...overrides,
 }
 // 与正式宿主同序：先装执行态守卫，再装两个小结工具，理由由外层的守卫先答。
 registerTaskToolGuard(ctx,async()=>({allowedTools:policy,nativeRequestId}),[roleMemoryProposalToolName,...roleDailyDigestToolNames])
 registerRoleDailyDigestTools(ctx,ports)
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(nativeRequestId)}}),{surfaceOp:'append'})
 let seq=0
 const call=(name:string,args:Record<string,unknown>={},callId?:string)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId??'digest-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,bodies,call,ports,grant:(names:string[])=>{policy=names}}
}

test('小结运行里两个工具都可见：证据由运行固定，提交回执按 Run 与 callId 派生且重放同一身份',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 const names=env.ctx.tools.schemas(env.agent).map(tool=>tool.name)
 assert.ok(names.includes(roleDayEvidenceToolName)&&names.includes(roleDailyDigestSubmitToolName))
 const read=await env.call(roleDayEvidenceToolName)
 assert.equal(read.isError,false)
 const readText=read.content.find(item=>item.type==='text')
 assert.ok(readText?.type==='text')
 assert.deepEqual(JSON.parse(readText.text),dayEvidence)
 assert.deepEqual(env.calls.filter(row=>row[0]==='evidence'),[['evidence',digestIdentity]])
 const saved=await env.call(roleDailyDigestSubmitToolName,submission,'submit-call')
 assert.equal(saved.isError,false)
 const savedText=saved.content.find(item=>item.type==='text')
 assert.ok(savedText?.type==='text')
 const body=JSON.parse(savedText.text) as {requestId:string;result:unknown}
 assert.match(body.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
 assert.deepEqual(body.result,{log:savedLog,candidates:[]})
 const submitted=env.calls.filter(row=>row[0]==='submit')
 assert.equal(submitted.length,1)
 assert.deepEqual(submitted[0]![1],digestIdentity)
 assert.equal(submitted[0]![2],body.requestId)
 assert.deepEqual(submitted[0]![3],submission)
 const replay=await env.call(roleDailyDigestSubmitToolName,submission,'submit-call')
 assert.equal(replay.isError,false)
 const replayText=replay.content.find(item=>item.type==='text')
 assert.ok(replayText?.type==='text')
 assert.equal((JSON.parse(replayText.text) as {requestId:string}).requestId,body.requestId)
})

test('当日证据工具不接受任何参数',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call(roleDayEvidenceToolName,{day:'2026-09-21'})
 assert.equal(result.isError,true)
 assert.match(JSON.stringify(result),/当日证据工具不接受任何参数/)
 assert.equal(env.calls.filter(row=>row[0]==='evidence').length,0)
})

test('候选超 3 条由服务端整次拒绝，工具既不截断也不吞错',async t=>{
 const env=await setupTool({submit:async()=>{throw new WorkError('teloa/invalid-input','一次至多提出 3 条岗位记忆候选。')}})
 t.after(()=>env.ctx.fiber.dispose())
 const four=[0,1,2,3].map(index=>({title:'候选'+index,markdown:'正文'+index,scopeIds:['SOC']}))
 const result=await env.call(roleDailyDigestSubmitToolName,{...submission,candidates:four})
 assert.equal(result.isError,true)
 assert.match(JSON.stringify(result),/一次至多提出 3 条岗位记忆候选/)
})

for(const scenario of ['no-agent','ordinary-run','missing-run','prepared-run','broken-lineage'] as const)test(`非小结运行一律 deny：${scenario}`,async t=>{
 const overrides:Partial<RoleDailyDigestToolPorts>=scenario==='ordinary-run'?{digestRun:async()=>null}
  :scenario==='missing-run'?{run:async()=>null}
  :scenario==='prepared-run'?{run:async sessionId=>({id:runId,sessionId,state:'prepared'})}:{}
 const env=await setupTool(overrides);t.after(()=>env.ctx.fiber.dispose())
 let caller=env.agent
 if(scenario==='broken-lineage'){
  const child=await env.ctx.agents.create({sessionId:SessionId('digest-child'),meta:{origin:'subagent',parentSession:env.agent.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
  caller=child.agent
  env.ctx.agents.get=()=>undefined
 }
 // 谱系断链由外层的执行态守卫先答，小结闸不参与；其余四种由小结闸逐字作答。
 const reason=scenario==='broken-lineage'?guardDenied:denied
 for(const name of roleDailyDigestToolNames){
  const result=scenario==='no-agent'
   ?await env.ctx.tools.execute({name,arguments:name===roleDailyDigestSubmitToolName?submission:{},callId:ToolCallId('no-agent-'+name),signal:AbortSignal.timeout(5000)})
   :await env.ctx.tools.execute({agent:caller,name,arguments:name===roleDailyDigestSubmitToolName?submission:{},callId:ToolCallId(scenario+'-'+name),signal:AbortSignal.timeout(5000)})
  assert.equal(result.isError,true)
  assert.ok(JSON.stringify(result).includes(reason),`${scenario}/${name} 的理由必须逐字固定`)
 }
 assert.equal(env.calls.filter(row=>row[0]==='evidence'||row[0]==='submit').length,0)
})

test('两个新工具可进自授权集；改成资源类、编排类、外发类或委派类名字即在装配期抛错',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 registerTaskToolGuard(ctx,async()=>null,[roleMemoryProposalToolName,...roleDailyDigestToolNames])
 for(const name of roleDailyDigestToolNames){
  assert.ok(!(mcpResourceTools as readonly string[]).includes(name))
  assert.ok(!(orchestrationTools as readonly string[]).includes(name))
  assert.ok(!(externalEgressTools as readonly string[]).includes(name))
  assert.ok(!(delegationTools as readonly string[]).includes(name))
 }
 const forbidden=[['read_mcp_resource',/自授权工具不能包含 MCP 资源工具/],['workflow',/自授权工具不能包含编排类工具/],['subagent_task',/自授权工具不能包含执行态委派工具/],['web_fetch',/自授权工具不能包含外发类工具/]] as const
 for(const [name,message] of forbidden){
  assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[roleMemoryProposalToolName,name,roleDailyDigestSubmitToolName]),message)
  assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[roleMemoryProposalToolName,roleDayEvidenceToolName,name]),message)
 }
})

test('正式宿主把每日日志服务、两个工具与 Auto Dream 端口都接了进去',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),selfAuthorized=await readFile(new URL('../src/self-authorized-tools.ts',import.meta.url),'utf8')
 assert.match(source,/import \{createRoleDailyLogHandler,registerRoleDailyDigestTools,roleDailyLogEndpoints\} from '\.\/role-daily-log\.ts'/)
 // 两个小结工具与岗位记忆候选必须在自授权集（已抽成常量模块）的最前两位；后面可以追加别的自授权工具（群附件一期加了 teloa_group_attach）。
 assert.match(selfAuthorized,/\[roleMemoryProposalToolName,\.\.\.roleDailyDigestToolNames[,\]]/)
 assert.match(source,/registerTaskToolGuard\(ctx,readTaskToolPolicy,[\s\S]*?\[\.\.\.selfAuthorizedToolNames\],async/)
 assert.match(source,/registerRoleDailyDigestTools\(toolRegistrationContext,\{/)
 // 同事在岗自动带一条 Auto Dream 系统计划：两个岗位生命周期入口都必须带上计划端口。
 assert.match(source,/new RoleLifecycleService\(pool,identity,\{plans\}\)/)
 assert.match(source,/new RoleService\(pool,identity,\{plans\}\)/)
})

test('小结运行只放行两个工具：岗位授权清单里的其余工具与记忆候选工具一律被拒',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 for(const name of ['read_mcp_resource',roleMemoryProposalToolName]){
  const result=await env.call(name)
  assert.equal(result.isError,true)
  assert.ok(JSON.stringify(result).includes('今日小结只能读当天证据并提交小结。'),`${name} 的理由必须逐字固定`)
 }
 assert.deepEqual(env.bodies,[])
 assert.equal((await env.call(roleDayEvidenceToolName)).isError,false)
})

test('普通运行不受小结闸影响：同样两个工具照常执行，两个小结工具仍按原闸被拒',async t=>{
 const env=await setupTool({digestRun:async()=>null});t.after(()=>env.ctx.fiber.dispose())
 for(const name of ['read_mcp_resource',roleMemoryProposalToolName])assert.equal((await env.call(name)).isError,false)
 assert.deepEqual(env.bodies,['read_mcp_resource',roleMemoryProposalToolName])
 const refused=await env.call(roleDayEvidenceToolName)
 assert.equal(refused.isError,true)
 assert.ok(JSON.stringify(refused).includes(denied))
})

function roleConstructionsWithoutPlans(source:string){
 const constructions=[...source.matchAll(/new Role(?:Lifecycle)?Service\(/g)]
 return constructions.filter(match=>{
  const tail=source.slice(match.index,match.index+120)
  // 分身自举不建计划；这份精确的 get 构造只读岗位。其它构造继续要求计划端口。
  const readOnly=/^new RoleService\(database\.pool,\{id:randomUUID,now:\(\)=>new Date\(\)\.toISOString\(\)\}\)\.get\(owner,roleId\)(?=\s*[,;)]|$)/.test(tail)
  return !tail.includes('plans')&&!tail.includes('ensurePersonalTwin')&&!readOnly
 }).map(match=>source.slice(match.index,match.index+120))
}
test('能写入的岗位构造带上 Auto Dream 计划端口，分身自举与精确只读 get 例外',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.ok([...source.matchAll(/new Role(?:Lifecycle)?Service\(/g)].length>=4)
 assert.deepEqual(roleConstructionsWithoutPlans(source),[])
})
test('岗位构造守卫只放行本人只读 get，不放行相同构造的写入或链式调用',()=>{
 const constructor='new RoleService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()})'
 assert.deepEqual(roleConstructionsWithoutPlans(constructor+'.get(owner,roleId),'),[])
 for(const expression of [constructor+'.create(owner,{})',constructor+'.get(other,roleId)',constructor+'.get(owner,roleId).create(owner,{})','new RoleLifecycleService(database.pool,identity).change(owner,{})'])assert.equal(roleConstructionsWithoutPlans(expression).length,1,expression)
 assert.deepEqual(roleConstructionsWithoutPlans('new RoleService(database.pool,identity,{plans}).create(owner,{})'),[])
})

test('已确认有 Run 但分类失败时两类工具都拒，不退回岗位授权清单',async t=>{
 const env=await setupTool({digestRun:async()=>{throw new WorkError('teloa/storage-corrupt','计划来源行损坏：teloa_plans.source')}})
 t.after(()=>env.ctx.fiber.dispose())
 for(const name of ['read_mcp_resource',roleMemoryProposalToolName,...roleDailyDigestToolNames]){
  const result=await env.call(name,name===roleDailyDigestSubmitToolName?submission:{})
  assert.equal(result.isError,true)
  const text=JSON.stringify(result)
  assert.ok(text.includes(unknownDenied),`${name} 判不出来时必须拒`)
  // 上游异常消息不得出现在理由里。
  assert.ok(!text.includes('teloa_plans.source'))
 }
 assert.deepEqual(env.bodies,[])
})

test('Run 读口抖动只拒两个小结工具，其余交既有岗位授权闸',async t=>{
 const env=await setupTool({run:async()=>{throw new WorkError('teloa/dependency-unavailable','数据库连接不可用')}})
 t.after(()=>env.ctx.fiber.dispose())
 // 连有没有 Run 都确认不到：那不可能是小结运行，小结闸不该替岗位授权闸作答。
 for(const name of roleDailyDigestToolNames){
  const refused=await env.call(name,name===roleDailyDigestSubmitToolName?submission:{})
  assert.equal(refused.isError,true)
  const text=JSON.stringify(refused)
  assert.ok(text.includes(unknownDenied),`${name} 判不出来时必须拒`)
  assert.ok(!text.includes('数据库连接不可用'))
 }
 for(const name of ['read_mcp_resource',roleMemoryProposalToolName])assert.equal((await env.call(name)).isError,false)
 assert.deepEqual(env.bodies,['read_mcp_resource',roleMemoryProposalToolName])
 assert.equal(env.calls.filter(row=>row[0]==='evidence'||row[0]==='submit').length,0)
})

test('派发后才取消的调用对任何工具都拒：取消时连 Run 都没读，不能退回岗位授权闸',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('role-daily-log-abort'),agentOptions:{provider:'test',model:'test'}})
 const bodies:string[]=[],calls:string[]=[]
 ctx.tools.register(defineTool({name:'read_mcp_resource',description:'read_mcp_resource',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies.push('read_mcp_resource');return 'executed'}}))
 // 已取消的调用在派发前就被运行时挡掉，闸根本看不到；这里模拟派发之后、闸判定之前才取消。
 let controller=new AbortController()
 ctx.on('tools/pre-execute',async(_exec,next)=>{controller.abort();return next()})
 registerRoleDailyDigestTools(ctx,{
  owner,
  run:async sessionId=>{calls.push('run');return {id:runId,sessionId,state:'active'}},
  digestRun:async()=>{calls.push('digestRun');return digestIdentity},
  evidence:async()=>{calls.push('evidence');return dayEvidence},
  submit:async()=>{calls.push('submit');return {log:savedLog,candidates:[]}},
 })
 // 两个小结工具与其余工具一律拒同一句：判不出来时退回岗位授权清单，等于在真实小结运行里静默放开整份授权。
 for(const name of [...roleDailyDigestToolNames,'read_mcp_resource']){
  controller=new AbortController()
  const refused=await ctx.tools.execute({agent,name,arguments:name===roleDailyDigestSubmitToolName?submission:{},callId:ToolCallId('aborted-'+name),signal:controller.signal})
  assert.equal(refused.isError,true,`${name} 在已取消的调用里必须拒`)
  assert.ok(JSON.stringify(refused).includes(unknownDenied),`${name} 的理由必须逐字固定`)
 }
 // 一个工具体都没跑到；判不出来也没进缓存，读口一次都没被调用。
 assert.deepEqual(bodies,[])
 assert.deepEqual(calls,[])
})

test('提交回包与当前运行身份不一致时整次不回给模型',async t=>{
 for(const broken of [{...savedLog,roleId:'99999999-9999-4999-8999-999999999999'},{...savedLog,day:'2026-09-20'},{...savedLog,runId:logId},{id:logId}]){
  const env=await setupTool({submit:async()=>({log:broken,candidates:[]})})
  t.after(()=>env.ctx.fiber.dispose())
  const result=await env.call(roleDailyDigestSubmitToolName,submission)
  assert.equal(result.isError,true)
  assert.match(JSON.stringify(result),/每日日志服务返回了与当前运行身份不一致的小结/)
 }
})

test('小结运行里岗位授权清单为空时，先答的是执行态守卫而不是小结闸',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 env.grant([])
 // 守卫装在外层：清单里没有 read_mcp_resource 时它先给出资源类闸的理由。
 assert.match(JSON.stringify(await env.call('read_mcp_resource')),/MCP 资源工具未在员工执行范围内授权。/)
 // 自授权集里的记忆候选工具守卫放行，收窄到两个工具的是小结闸。
 assert.match(JSON.stringify(await env.call(roleMemoryProposalToolName)),/今日小结只能读当天证据并提交小结。/)
 assert.deepEqual(env.bodies,[])
})

test('判定按谱系根会话记忆：同一运行的两次工具调用只跑一次 digestRun',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 assert.equal((await env.call(roleDayEvidenceToolName,{},'first-call')).isError,false)
 assert.equal((await env.call(roleDayEvidenceToolName,{},'second-call')).isError,false)
 assert.equal(env.calls.filter(row=>row[0]==='digestRun').length,1)
 assert.equal(env.calls.filter(row=>row[0]==='evidence').length,2)
})
