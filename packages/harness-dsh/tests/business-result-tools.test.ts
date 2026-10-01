import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {readBusinessObjectTypeDefinition,readBusinessSourceMappingDefinition} from '@teloa/contract'
import {BusinessWidgetService} from '@teloa/backend'
import {registerBusinessResultTools,businessResultToolNames,type BusinessResultToolsPorts} from '../src/business-result-tools.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'
import {taskRunToolRules,validateReferenceToolRules} from '../src/role-tool-grants.ts'

const owner='local:teloa-owner',scope='AppSec',sessionId='business-result-session'
const ticket=readBusinessObjectTypeDefinition({format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:scope,title:'工单',unit:'条',lead:'待处理的工单',sourceId:'source-http',fields:[{name:'title',label:'标题',type:'text',required:true,from:'标题'}]})
const mapping=(id:string,source:unknown)=>readBusinessSourceMappingDefinition({format:'teloa.business-source-mapping/v1',id,version:'1.0.0',domain:scope,title:'成果',objectType:'ticket',source,mapping:[{path:'$.title',field:'title'}],primaryKey:['title'],deletionSemantics:'tombstone',deletedAtPath:'$.deleted_at',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false})
const taskPolicy={allowedTools:[...businessResultToolNames],nativeRequestId:'task-run-request'}
const [record,read,trial]=businessResultToolNames

async function setup(overrides:Partial<BusinessResultToolsPorts>={},options:{rows?:number}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[{type:'text',text:'看一下看板'}]}),{surfaceOp:'append'})
 const ingested:unknown[]=[],executed:unknown[]=[],reads:unknown[]=[]
 const executor={schema:'public',execute:async(_key:string,rewrite:{sql:string})=>{executed.push(rewrite.sql);const count=options.rows??60;return {columns:[{name:'title',type:'text' as const}],rows:Array.from({length:count},(_v,index)=>['t'+index]),rowCount:count,bytes:count*3,computedAt:'2026-09-26T00:00:00.000Z',throttled:false}}}
 const widgets=new BusinessWidgetService({} as never,{now:()=>'2026-09-26T00:00:00.000Z'},executor,{computeInTransaction:async()=>{throw new Error('unused')}})
 const client={query:async()=>({rows:[]}),release:()=>{}}
 const services={
  sync:{mappings:async()=>[mapping('agent-results',{kind:'role-result'}),mapping('alerts',{kind:'business-data-port',sourceId:'security-alert-http'})],ingest:async(actor:unknown,input:unknown)=>{ingested.push({actor,input});return {upserted:1,tombstoned:0}}},
  dashboards:{read:async(actor:unknown,input:unknown)=>{reads.push({actor,input});throw new Error('stub')}},
  widgets,
  definitions:{forScope:async()=>[{objectTypes:[{definition:ticket}],views:[]}]},
  pool:{connect:async()=>client},
 }
 const ports:BusinessResultToolsPorts={owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>taskPolicy,readBusinessScope:async()=>scope,services:async()=>services as never,scopeIds:async()=>[scope],...overrides}
 registerBusinessResultTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('call-'+Math.random()),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,call,ingested,executed,reads}
}
const text=(result:{content:Array<{type:string;text?:string}>})=>result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')
const items=(count:number)=>Array.from({length:count},(_v,index)=>({title:'成果 '+index}))

test('成果记录：普通主会话 deny「只允许任务会话」；任务会话但映射不是 role-result 也 deny；都不写入',async t=>{
 const main=await setup({readTaskPolicy:async()=>null});t.after(()=>main.ctx.fiber.dispose())
 const denied=await main.call(record,{scope,mappingId:'agent-results',items:items(1)})
 assert.equal(denied.isError,true);assert.match(text(denied),/只允许任务会话/)
 const task=await setup();t.after(()=>task.ctx.fiber.dispose())
 const wrongSource=await task.call(record,{scope,mappingId:'alerts',items:items(1)})
 assert.equal(wrongSource.isError,true);assert.match(text(wrongSource),/role-result/)
 const unbound=await setup({readBusinessScope:async()=>null});t.after(()=>unbound.ctx.fiber.dispose())
 assert.equal((await unbound.call(record,{scope,mappingId:'agent-results',items:items(1)})).isError,true)
 const ungranted=await setup({readTaskPolicy:async()=>({allowedTools:[read,trial]})});t.after(()=>ungranted.ctx.fiber.dispose())
 assert.equal((await ungranted.call(record,{scope,mappingId:'agent-results',items:items(1)})).isError,true)
 const otherScope=await setup();t.after(()=>otherScope.ctx.fiber.dispose())
 assert.equal((await otherScope.call(record,{scope:'SOC',mappingId:'agent-results',items:items(1)})).isError,true)
 assert.deepEqual([main.ingested,task.ingested,unbound.ingested,ungranted.ingested,otherScope.ingested].flat(),[])
})

test('成果记录：合法写入本人范围，来源为 role-result: + 会话前 8 位；51 条 invalid-input',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call(record,{scope,mappingId:'agent-results',items:items(2)})
 assert.equal(result.isError,false,text(result))
 assert.deepEqual(JSON.parse(text(result)),{upserted:1,tombstoned:0})
 const {actor,input}=(e.ingested as Array<{actor:{ownerId:string;scopeIds:string[]};input:{sourceId:string;scope:string;mappingId:string;items:unknown[]}}>)[0]!
 assert.deepEqual(actor,{ownerId:owner,scopeIds:[scope]})
 assert.equal(input.sourceId,'role-result:'+sessionId.slice(0,8))
 assert.deepEqual([input.scope,input.mappingId,input.items.length],[scope,'agent-results',2])
 const tooMany=await e.call(record,{scope,mappingId:'agent-results',items:items(51)})
 assert.equal(tooMany.isError,true);assert.match(text(tooMany),/1 到 50 条/)
 assert.equal(e.ingested.length,1)
})

test('SQL 试算：pg_sleep 在返回值里给出 invalid-input 原因（不抛、不执行）；合法 SQL 最多 50 行、不落库',async t=>{
 const e=await setup({readTaskPolicy:async()=>null});t.after(()=>e.ctx.fiber.dispose())
 const refused=await e.call(trial,{scope,sql:'select pg_sleep(1)'})
 assert.equal(refused.isError,false,text(refused))
 assert.deepEqual(JSON.parse(text(refused)),{error:{code:'teloa/invalid-input',reason:'不允许的函数 pg_sleep'}})
 assert.equal(e.executed.length,0)
 const ok=await e.call(trial,{scope,sql:'select title from ticket'})
 assert.equal(ok.isError,false,text(ok))
 const value=JSON.parse(text(ok)) as {columns:unknown[];rows:unknown[][];rowCount:number;truncated:boolean;totalRows:number}
 assert.equal(value.rows.length,50);assert.equal(value.rowCount,50)
 // 截到 50 行时告诉模型还有更多：truncated + 截断前行数。
 assert.deepEqual([value.truncated,value.totalRows],[true,60])
 assert.equal(e.executed.length,1);assert.match(e.executed[0] as string,/public\.teloa_business_object_snapshots/)
 const task=await setup();t.after(()=>task.ctx.fiber.dispose())
 assert.equal((await task.call(trial,{scope,sql:'select title from ticket'})).isError,false,'任务会话也可试算')
})

test('看板读取：只读快照、键集严格、范围与身份不符 deny；无 agent、他人会话、未授权任务会话拒绝',async t=>{
 const e=await setup({readTaskPolicy:async()=>null});t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call(read,{scope,dashboardId:'overview',extra:1})).isError,true)
 assert.equal((await e.call(read,{scope:'SOC',dashboardId:'overview'})).isError,true)
 assert.equal(e.reads.length,0)
 assert.equal((await e.call(read,{scope,dashboardId:'overview'})).isError,true,'桩服务抛错')
 assert.equal(e.reads.length,1,'合法请求才调 read')
 const other=await setup({conversation:async id=>({ownerId:'other',sessionId:id,status:'ready'})});t.after(()=>other.ctx.fiber.dispose())
 for(const [name,args] of [[read,{scope,dashboardId:'overview'}],[trial,{scope,sql:'select 1'}],[record,{scope,mappingId:'agent-results',items:items(1)}]] as const)assert.equal((await other.call(name,args)).isError,true)
 assert.equal((await e.ctx.tools.execute({name:read,arguments:{scope,dashboardId:'overview'},callId:ToolCallId('no-agent'),signal:AbortSignal.timeout(5000)})).isError,true)
 const ungranted=await setup({readTaskPolicy:async()=>({allowedTools:[]})});t.after(()=>ungranted.ctx.fiber.dispose())
 assert.equal((await ungranted.call(read,{scope,dashboardId:'overview'})).isError,true)
 assert.equal(ungranted.reads.length,0)
})

test('岗位授权：未授权被任务守卫拒、整工具授权后任务会话可用，成果仍只写本人登记范围',async t=>{
 let policy:TaskToolPolicy={allowedTools:[],argumentRules:[]}
 const e=await setup({readTaskPolicy:async()=>policy});t.after(()=>e.ctx.fiber.dispose())
 registerTaskToolGuard(e.ctx,async()=>policy)
 for(const [name,args] of [[record,{scope,mappingId:'agent-results',items:items(1)}],[read,{scope,dashboardId:'overview'}],[trial,{scope,sql:'select title from ticket'}]] as const){
  const denied=await e.call(name,args)
  assert.equal(denied.isError,true,name);assert.match(text(denied),/未授权|只允许任务会话/)
 }
 assert.deepEqual([e.ingested.length,e.reads.length,e.executed.length],[0,0,0])
 // 授权页保存与运行准备同一条校验：三项都只能整工具授权；运行快照的 allowedTools 即授权规则名。
 const rules=businessResultToolNames.map(name=>({name,anyArguments:true as const,allowed:[]}))
 validateReferenceToolRules(rules,taskRunToolRules([]))
 policy={allowedTools:rules.map(rule=>rule.name),argumentRules:rules}
 const recorded=await e.call(record,{scope,mappingId:'agent-results',items:items(1)})
 assert.equal(recorded.isError,false,text(recorded))
 assert.equal((await e.call(trial,{scope,sql:'select title from ticket'})).isError,false)
 const {actor,input}=(e.ingested as Array<{actor:{ownerId:string;scopeIds:string[]};input:{scope:string;sourceId:string}}>)[0]!
 assert.deepEqual([actor,input.scope,input.sourceId],[{ownerId:owner,scopeIds:[scope]},scope,'role-result:'+sessionId.slice(0,8)])
 const otherScope=await e.call(record,{scope:'SOC',mappingId:'agent-results',items:items(1)})
 assert.equal(otherScope.isError,true);assert.match(text(otherScope),/绑定的业务范围/)
 assert.equal(e.ingested.length,1)
})

test('试算不截断时 truncated 为 false、totalRows 等于行数',async t=>{
 const e=await setup({readTaskPolicy:async()=>null},{rows:3});t.after(()=>e.ctx.fiber.dispose())
 const value=JSON.parse(text(await e.call(trial,{scope,sql:'select title from ticket'})))
 assert.deepEqual([value.rowCount,value.truncated,value.totalRows],[3,false,3])
})

test('任务会话按会话绑定的业务范围收窄：看板读取与 SQL 试算只能用于绑定范围；未绑定业务一律拒绝；主会话仍可读本人任一登记范围',async t=>{
 const scopes=async()=>[scope,'SOC']
 const bound=await setup({scopeIds:scopes});t.after(()=>bound.ctx.fiber.dispose())
 for(const [name,args] of [[read,{scope:'SOC',dashboardId:'overview'}],[trial,{scope:'SOC',sql:'select 1'}]] as const){
  const denied=await bound.call(name,args)
  assert.equal(denied.isError,true,name);assert.match(text(denied),/绑定的业务范围/,name)
 }
 assert.deepEqual([bound.reads.length,bound.executed.length],[0,0])
 assert.equal((await bound.call(trial,{scope,sql:'select title from ticket'})).isError,false)
 assert.equal((await bound.call(read,{scope,dashboardId:'overview'})).isError,true,'桩服务抛错')
 assert.deepEqual((bound.reads[0] as {actor:unknown}).actor,{ownerId:owner,scopeIds:[scope]},'任务会话的读取主体只带绑定范围')
 const unbound=await setup({scopeIds:scopes,readBusinessScope:async()=>null});t.after(()=>unbound.ctx.fiber.dispose())
 for(const [name,args] of [[read,{scope,dashboardId:'overview'}],[trial,{scope,sql:'select title from ticket'}]] as const){
  const denied=await unbound.call(name,args)
  assert.equal(denied.isError,true,name);assert.match(text(denied),/未绑定业务/,name)
 }
 const failing=await setup({scopeIds:scopes,readBusinessScope:async()=>{throw new Error('db down')}});t.after(()=>failing.ctx.fiber.dispose())
 assert.equal((await failing.call(trial,{scope,sql:'select title from ticket'})).isError,true,'绑定读不出按未绑定处理')
 const main=await setup({scopeIds:scopes,readTaskPolicy:async()=>null,readBusinessScope:async()=>{throw new Error('主会话不该调')}});t.after(()=>main.ctx.fiber.dispose())
 assert.equal((await main.call(trial,{scope:'SOC',sql:'select 1 as one'})).isError,false)
})

test('错误码只用允许扩散的正式码：不再出现 teloa/not-bound、teloa/host-unavailable',async()=>{
 const source=await readFile(new URL('../src/business-result-tools.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/teloa\/not-bound|teloa\/host-unavailable/)
 assert.match(source,/new WorkError\('teloa\/dependency-unavailable','暂时无法核对会话身份。'\)/)
})
