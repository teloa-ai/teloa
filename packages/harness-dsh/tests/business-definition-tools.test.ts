import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {businessDefinitionCanonicalBody,type BusinessDefinitionDraft} from '@teloa/contract'
import {registerBusinessDefinitionTools,businessDefinitionToolNames,type BusinessDefinitionToolsPorts} from '../src/business-definition-tools.ts'
import {roleGrantToolNames,validateReferenceToolRules} from '../src/role-tool-grants.ts'

const owner='local:teloa-owner',scope='AppSec',id='11111111-1111-4111-8111-111111111111',now='2026-09-17T00:00:00.000Z'
const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:scope,title:'工单',unit:'条',lead:'待处理的工单',sourceId:'source-http',fields:[{name:'title',label:'标题',type:'text',required:true,from:'标题'}]}
const input={scope,kind:'object-type',definition}
const receipt=(payload:unknown):BusinessDefinitionDraft=>({id,ownerId:owner,requestId:(payload as {requestId:string}).requestId,scope,kind:'object-type',localId:'ticket',semver:'1.0.0',definitionHash:'a'.repeat(64),body:businessDefinitionCanonicalBody(definition),status:'draft',createdAt:now,updatedAt:now})
async function setup(overrides:Partial<BusinessDefinitionToolsPorts>={},options:{subagent?:boolean;instructions?:number}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('business-definition-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let index=0;index<(options.instructions??1);index++)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'customization-request'},content:[{type:'text',text:'给工单加一个视图'}]}),{surfaceOp:'append'})
 const calls:Array<{endpoint:string;payload:unknown}>=[]
 const ports:BusinessDefinitionToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,directory:async scope=>({scope,objectTypes:[definition],views:[],actions:[]}),handler:async(endpoint,payload)=>{calls.push({endpoint,payload});return receipt(payload)},...overrides}
 registerBusinessDefinitionTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}
const json=(result:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))

test('真实工具注册恰好目录和草案，模型无法调用 apply/revert 或塞生效字段',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(item=>item.name.startsWith('teloa_business_definitions_')).map(item=>item.name),[...businessDefinitionToolNames])
 for(const name of ['teloa_business_definitions_apply','teloa_business_definitions_revert'])assert.equal((await e.call(name,{draftId:id})).isError,true)
 for(const extra of [{status:'applied'},{ownerId:'other'},{requestId:id},{draftId:id,expectedDefinitionHash:'a'.repeat(64)}])assert.equal((await e.call(businessDefinitionToolNames[1],{...input,...extra})).isError,true)
 assert.equal(e.calls.length,0)
})

test('目录只返回通过契约核对的声明，不给模型对象取值和试算',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call(businessDefinitionToolNames[0],{scope});assert.equal(result.isError,false)
 assert.deepEqual(Object.keys(json(result)),['scope','objectTypes','views','actions'])
 assert.equal(e.calls.length,0)
 for(const extra of [{objects:[{fields:[{value:'secret'}]}]},{trial:{rows:['secret']}}]){
  const bad=await setup({directory:async()=>({scope,objectTypes:[definition],views:[],actions:[],...extra})});t.after(()=>bad.ctx.fiber.dispose())
  const result=await bad.call(businessDefinitionToolNames[0],{scope});assert.equal(result.isError,true)
  assert.equal(JSON.stringify(result).includes('secret'),false)
 }
})

test('草案需要固定确认语，确认前不写；同一真实指令换 callId 重放仍使用同一请求和草案身份',async t=>{
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose())
 assert.equal((await denied.call(businessDefinitionToolNames[1],input)).isError,true);assert.equal(denied.calls.length,0)
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let reason=''
 e.ctx.provide('approval',{request:async(value:{reason:string})=>{reason=value.reason;return 'allowed-once'}})
 const first=await e.call(businessDefinitionToolNames[1],input,'one'),second=await e.call(businessDefinitionToolNames[1],input,'two')
 assert.equal(first.isError,false);assert.equal(second.isError,false)
 assert.equal(reason,'确认把这份业务定义存成草案？草案不会生效，需要你在业务页预览并确认。')
 assert.equal(json(first).id,json(second).id);assert.equal(json(first).requestId,json(second).requestId)
 assert.deepEqual(e.calls.map(call=>call.endpoint),['business-definitions/draft','business-definitions/draft'])
 assert.deepEqual(e.calls[0]?.payload,e.calls[1]?.payload)
})

test('同一条指令存多份不同声明（看板设计：多个组件 + 看板）：各得一个请求身份，互不替换；同一声明重放仍是同一身份',async t=>{
 const payloads:Array<{requestId:string;kind:string;definition:{id:string}}>=[]
 const echo=async(_endpoint:string,payload:unknown)=>{const row=payload as {requestId:string;kind:string;definition:{id:string}};payloads.push(row);return {...receipt(payload),kind:row.kind,localId:row.definition.id,body:businessDefinitionCanonicalBody(row.definition as never)}}
 const e=await setup({handler:echo});t.after(()=>e.ctx.fiber.dispose())
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 const second={...input,definition:{...definition,id:'ticket-2'}}
 for(const [args,callId] of [[input,'a'],[second,'b'],[input,'c']] as const)assert.equal((await e.call(businessDefinitionToolNames[1],args,callId)).isError,false)
 assert.deepEqual(payloads.map(row=>row.definition.id),['ticket','ticket-2','ticket'])
 assert.notEqual(payloads[0]!.requestId,payloads[1]!.requestId)
 assert.equal(payloads[0]!.requestId,payloads[2]!.requestId)
})

test('图表组件的 chart.spec 键序与规范化正文不同也能存成草案（回执按规范化正文比对）；正文确有差异仍拒绝',async t=>{
 const chart={format:'teloa.business-widget/v1',id:'severity-bars',version:'1.0.0',domain:scope,title:'严重度分布',kind:'chart',query:'select title, count(*) as n from ticket group by title',
  chart:{engine:'vega-lite',spec:{mark:'bar',encoding:{y:{type:'quantitative',field:'n'},x:{type:'nominal',field:'title'}}}}}
 let tamper=false
 const canonical=async(_endpoint:string,payload:unknown)=>{const row=payload as {kind:string;definition:{id:string;title:string}};const body=tamper?{...row.definition,title:'别的标题'}:row.definition;return {...receipt(payload),kind:row.kind,localId:row.definition.id,body:businessDefinitionCanonicalBody(body as never)}}
 const e=await setup({handler:canonical});t.after(()=>e.ctx.fiber.dispose())
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 assert.equal((await e.call(businessDefinitionToolNames[1],{scope,kind:'widget',definition:chart},'x')).isError,false)
 tamper=true
 assert.equal((await e.call(businessDefinitionToolNames[1],{scope,kind:'widget',definition:chart},'y')).isError,true)
})

test('无 agent、子 Agent、未就绪、另一人、任务执行及其历史会话、本轮零条或两条指令全部拒绝',async t=>{
 const cases:Array<{overrides?:Partial<BusinessDefinitionToolsPorts>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{overrides:{conversation:async sessionId=>({ownerId:owner,sessionId,status:'pending'})}},{overrides:{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready'})}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task-history'})}}]
 for(const item of cases){
  const e=await setup(item.overrides,item.options);t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
  for(const name of businessDefinitionToolNames)assert.equal((await e.call(name,name===businessDefinitionToolNames[0]?{scope}:input)).isError,true)
  assert.equal(e.calls.length,0)
 }
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.ctx.tools.execute({name:businessDefinitionToolNames[1],arguments:input,callId:ToolCallId('no-agent'),signal:AbortSignal.timeout(5000)})).isError,true)
 assert.equal(e.calls.length,0)
})

test('任务会话调用草案工具一律 deny；本人主会话看板组件草案仍按原确认语 ask',async t=>{
 const task=await setup({readTaskPolicy:async()=>({allowedTools:[...businessDefinitionToolNames],nativeRequestId:'task-run'})});t.after(()=>task.ctx.fiber.dispose())
 const decisions:unknown[]=[]
 task.ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();if(exec.name===businessDefinitionToolNames[1])decisions.push(decision);return decision},{prepend:true})
 task.ctx.provide('approval',{request:async()=> 'allowed-once'})
 assert.equal((await task.call(businessDefinitionToolNames[1],input)).isError,true)
 assert.equal((decisions[0] as {kind:string}).kind,'deny')
 assert.equal(task.calls.length,0)
 const widget={format:'teloa.business-widget/v1',id:'open-count',version:'1.0.0',domain:scope,title:'未关闭工单',kind:'metric',query:'select count(*) as n from ticket',metric:{valueColumn:'n'}}
 const main=await setup();t.after(()=>main.ctx.fiber.dispose());let reason=''
 main.ctx.provide('approval',{request:async(value:{reason:string})=>{reason=value.reason;return 'denied'}})
 await main.call(businessDefinitionToolNames[1],{scope,kind:'widget',definition:widget})
 assert.equal(reason,'确认把这份业务定义存成草案？草案不会生效，需要你在业务页预览并确认。')
})

test('确认期间身份变化会在正文重新核验，原生 deny 不能被确认覆盖',async t=>{
 let ready=true
 const e=await setup({conversation:async sessionId=>({ownerId:owner,sessionId,status:ready?'ready':'pending'})});t.after(()=>e.ctx.fiber.dispose())
 e.ctx.provide('approval',{request:async()=>{ready=false;return 'allowed-once'}})
 assert.equal((await e.call(businessDefinitionToolNames[1],input)).isError,true);assert.equal(e.calls.length,0)
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生拒绝'}));denied.ctx.provide('approval',{request:async()=> 'allowed-once'})
 assert.equal((await denied.call(businessDefinitionToolNames[1],input)).isError,true);assert.equal(denied.calls.length,0)
})

test('草案回执不能偷换本人、请求、正文或生效状态',async t=>{
 for(const change of [{ownerId:'other'},{requestId:id},{status:'applied',appliedVersion:1},{body:businessDefinitionCanonicalBody({...definition,title:'别的标题'})}]){
  const e=await setup({handler:async(_endpoint,payload)=>({...receipt(payload),...change})});t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
  assert.equal((await e.call(businessDefinitionToolNames[1],input)).isError,true)
 }
})

test('两个业务定制工具均不在岗位工具授权白名单内，即使构造同名候选也拒绝',()=>{
 for(const name of businessDefinitionToolNames){
  assert.equal(roleGrantToolNames.includes(name),false)
  const rule={name,allowed:[{scope}]}
  assert.throws(()=>validateReferenceToolRules([rule],[rule]),{code:'teloa/forbidden'})
 }
})

test('草案工具支持数据源映射、组件与看板：范围一致按原确认语 ask，domain 与 scope 不一致 deny「范围不一致」',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.match(e.ctx.tools.get(businessDefinitionToolNames[1])!.description,/支持 source-mapping \/ widget \/ dashboard/)
 const decisions:Array<{kind:string;reason?:string}>=[]
 e.ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();decisions.push(decision as {kind:string;reason?:string});return decision},{prepend:true})
 e.ctx.provide('approval',{request:async()=>'denied'})
 const soc='SOC'
 const bodies={
  'source-mapping':{format:'teloa.business-source-mapping/v1',id:'alerts',version:'1.0.0',domain:soc,title:'告警同步',objectType:'soc-alert',source:{kind:'role-result'},mapping:[{path:'$.title',field:'title'}],primaryKey:['title'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false},
  widget:{format:'teloa.business-widget/v1',id:'alert-trend',version:'1.0.0',domain:soc,title:'近 7 天告警趋势',kind:'metric',query:"select count(*) as n from soc_alert where created_at >= now() - interval '7 days'",metric:{valueColumn:'n'}},
  dashboard:{format:'teloa.business-dashboard/v1',id:'alert-overview',version:'1.0.0',domain:soc,title:'告警概览',widgets:['alert-trend'],layout:[{widget:'alert-trend',x:0,y:0,w:12,h:3}],refresh:{kind:'every',seconds:600},acknowledgeShortInterval:false},
 }
 for(const [kind,definition] of Object.entries(bodies)){
  decisions.length=0
  await e.call(businessDefinitionToolNames[1],{scope:soc,kind,definition},'ok-'+kind)
  assert.equal(decisions[0]?.kind,'ask',kind)
  decisions.length=0
  const mismatch=await e.call(businessDefinitionToolNames[1],{scope:soc,kind,definition:{...definition,domain:'appsec'}},'bad-'+kind)
  assert.equal(mismatch.isError,true,kind);assert.equal(decisions[0]?.kind,'deny',kind);assert.match(decisions[0]?.reason??'',/范围不一致/,kind)
 }
 assert.equal(e.calls.length,0)
})

test('业务范围键：中文、空格等不合规范围在草案工具处就拒收（与看板读侧同一判据），不会出现「草案能确认、看板读不出」',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const decisions:Array<{kind:string;reason?:string}>=[]
 e.ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();decisions.push(decision as {kind:string;reason?:string});return decision},{prepend:true})
 for(const bad of ['质量管理','quality mgmt']){
  decisions.length=0
  const widget={format:'teloa.business-widget/v1',id:'n',version:'1.0.0',domain:bad,title:'数量',kind:'metric',query:'select 1 as n',metric:{valueColumn:'n'}}
  const result=await e.call(businessDefinitionToolNames[1],{scope:bad,kind:'widget',definition:widget},'scope-'+bad)
  assert.equal(result.isError,true,bad)
  assert.equal(decisions[0]?.kind,'deny',bad)
  assert.match(decisions[0]?.reason??'',/业务范围只能是 1–64 位字母、数字、下划线或连字符/,bad)
  const directory=await e.call(businessDefinitionToolNames[0],{scope:bad},'dir-'+bad)
  assert.equal(directory.isError,true,bad)
 }
 assert.equal(e.calls.length,0)
})
