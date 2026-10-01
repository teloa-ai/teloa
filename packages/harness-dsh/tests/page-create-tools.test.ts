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
import {registerPageCreateTools,pageCreateToolNames,type PageCreateToolsPorts} from '../src/page-create-tools.ts'
import {roleGrantToolNames,validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {roleWriteDefinition,readPageCreateAtomicSkillDraft} from '@teloa/contract'
import type {BuiltinSkillCreator} from '../src/builtin-skill-creator.ts'

const owner='local:teloa-owner'
const creator={definition:{name:'teloa-skill-creator',description:'d',content:'c',source:'custom',provider:'teloa-builtin',invocation:{modelInvocable:true,userInvocable:true}},rendered:'<skill_content name="teloa-skill-creator">固定创建器</skill_content>'} as unknown as BuiltinSkillCreator
test('Skill 工具说明中的完整示例能被实际草案校验器接受',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const description=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!.description
 const example=/最小技能示例：\n([^\n]+)\n/.exec(description??'')
 assert.ok(example,'工具必须提供可独立使用的技能正文结构')
 assert.doesNotThrow(()=>readPageCreateAtomicSkillDraft(JSON.parse(example[1]!)))
})

test('无效 Skill 正文在请求审批前被拒绝，不让用户确认必然失败的操作',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 const result=await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify('# Skill')})
 assert.equal(result.isError,true)
 assert.equal(approvals,0)
 assert.equal(e.calls.length,0)
})
const role={name:'SOC 调查岗',kind:'employee',scopes:['SOC'],duty:'调查告警',dataScope:'只读告警',executionScope:'不处置',skills:['alert-triage'],knowledge:['soc-runbook'],responsibility:{triggers:['新告警'],autonomousActions:['取证'],confirmationPoints:['处置前确认'],escalationRules:['高危升级'],deliveryChecks:['结论有依据']}}

async function setup(overrides:Partial<PageCreateToolsPorts>={},options:{subagent?:boolean;instructions?:number}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('page-create-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let index=0;index<(options.instructions??1);index++)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'page-create-request'},content:[{type:'text',text:'帮我新建 SOC 调查岗位'}]}),{surfaceOp:'append'})
 const calls:Array<{kind:'directory'|'draft';input:unknown}>=[]
 const ports:PageCreateToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,skillCreator:creator,directory:async input=>{calls.push({kind:'directory',input});return {entity:input.entity,scopes:['SOC']}},draft:async input=>{calls.push({kind:'draft',input});return {id:'11111111-1111-4111-8111-111111111111',ownerId:owner,requestId:input.requestId,entity:input.entity,status:'draft'}},...overrides}
 registerPageCreateTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>,callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}

test('真实工具注册恰好目录和草案；目录是只读且不提供 apply/revert',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(item=>item.name.startsWith('teloa_create_')).map(item=>item.name),[...pageCreateToolNames])
 const result=await e.call('teloa_create_directory',{entity:'role'})
 assert.equal(result.isError,false);assert.deepEqual(e.calls,[{kind:'directory',input:{entity:'role'}}])
 for(const name of ['teloa_create_apply','teloa_create_revert'])assert.equal((await e.call(name,{draftId:'11111111-1111-4111-8111-111111111111'})).isError,true)
})

test('模型可见的岗位草案示例通过正式写入契约，无需猜字段或读取源码',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const description=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!.description
 const example=/最小员工示例：\n([^\n]+)\n/.exec(description??'')
 assert.ok(example,'工具必须提供完整可用的岗位定义示例')
 const parsed=JSON.parse(example[1]!)
 assert.deepEqual(roleWriteDefinition(parsed),parsed)
 assert.deepEqual(parsed.skills,[]);assert.deepEqual(parsed.knowledge,[])
 assert.ok(!('runtimeConfig' in parsed),'示例不应编造宿主预设')
})

test('目录与草案都复核普通会话；草案需要确认且只会写 draft',async t=>{
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose())
 assert.equal((await denied.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)})).isError,true)
 assert.equal(denied.calls.length,0)
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let reason='';e.ctx.provide('approval',{request:async(value:{reason:string})=>{reason=value.reason;return 'allowed-once'}})
 const one=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'one'),two=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'two')
 assert.equal(one.isError,false);assert.equal(two.isError,false)
 assert.equal(reason,'确认把这份新建定义保存成草案？草案不会直接创建任何内容，需要你在对应页面预览并确认。')
 assert.equal(e.calls.filter(call=>call.kind==='draft').length,2)
 const drafts=e.calls.filter(call=>call.kind==='draft').map(call=>call.input as {requestId:string;entity:string;body:unknown})
 assert.equal(drafts[0]?.entity,'role');assert.deepEqual(drafts[0]?.body,role);assert.equal(drafts[0]?.requestId,drafts[1]?.requestId)
})

test('子 Agent、多条指令、任务会话和无效范围都不能读取目录或写草案',async t=>{
 const cases:Array<{overrides?:Partial<PageCreateToolsPorts>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task-run'})}}]
 for(const item of cases){
  const e=await setup(item.overrides,item.options);t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
  assert.equal((await e.call('teloa_create_directory',{entity:'connector',scope:'SOC'})).isError,true)
  assert.equal((await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)})).isError,true)
  assert.equal(e.calls.length,0)
 }
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_create_directory',{entity:'unknown'})).isError,true)
 const roleGeneral=await e.call('teloa_create_directory',{entity:'role',scope:'general'})
 assert.equal(roleGeneral.isError,false);assert.deepEqual(e.calls.at(-1),{kind:'directory',input:{entity:'role'}})
 const skillScoped=await e.call('teloa_create_directory',{entity:'skill',scope:'SOC'})
 assert.equal(skillScoped.isError,false);assert.deepEqual(e.calls.at(-1),{kind:'directory',input:{entity:'skill'}})
 const connectorGeneral=await e.call('teloa_create_directory',{entity:'connector',scope:'general'})
 assert.equal(connectorGeneral.isError,true);assert.ok(JSON.stringify(connectorGeneral).includes('不能是通用工作'))
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 const draftGeneral=await e.call('teloa_create_draft',{entity:'role',scope:'general',body:'{}'})
 assert.equal(draftGeneral.isError,false);assert.deepEqual(e.calls.at(-1),{kind:'draft',input:{entity:'role',body:{},requestId:(e.calls.at(-1) as {input:{requestId:string}}).input.requestId}})
})

test('两项页内新建工具都不在岗位自授权白名单内',()=>{
 for(const name of pageCreateToolNames){
  assert.equal(roleGrantToolNames.includes(name),false)
  assert.throws(()=>validateReferenceToolRules([{name,allowed:[{scope:'SOC'}]}],[{name,allowed:[{scope:'SOC'}]}]),{code:'teloa/forbidden'})
 }
})

const skillBody=JSON.stringify({id:'content-review',title:'内容核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: content-review\ndescription: Review drafts.\n---\nCheck facts.\n').toString('base64')}]})
const inject=(agent:{session:{append:(...args:any[])=>unknown}},text=creator.rendered)=>agent.session.append('user/message',createUserMessage({source:{kind:'skill-invocation',name:'teloa-skill-creator',form:'instructions'} as never,content:[{type:'text',text}]}),{surfaceOp:'append'})

test('技能草案没有创建器加载证据时在审批前拒绝，并告诉模型先加载创建器',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 const result=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(result.isError,true);assert.equal(approvals,0);assert.equal(e.calls.length,0)
 assert.match(JSON.stringify(result.content),/teloa-skill-creator/)
 inject(e.agent,creator.rendered.replace('固定','改过'))
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',body:skillBody},'call-2')).isError,true)
 assert.equal(e.calls.length,0)
})

test('创建器正文在当前上下文中时，技能草案照常进入本人确认并保存',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 inject(e.agent)
 const result=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(approvals,1)
 assert.equal(e.calls.length,1);assert.equal((e.calls[0]!.input as {entity:string}).entity,'skill')
})

test('创建器不可用时技能草案一律拒绝，其他实体不受影响',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 inject(e.agent)
 const skill=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(skill.isError,true);assert.match(JSON.stringify(skill.content),/技能创建器不可用/)
 const directory=await e.call('teloa_create_directory',{entity:'skill'},'call-2')
 assert.equal(directory.isError,false)
})
