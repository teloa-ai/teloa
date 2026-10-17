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
import {WorkError,projectDefinition,type WorkProject} from '@teloa/contract'
import {createProjectHandler} from '../src/projects.ts'
import {groupMessageSecretGate} from '../src/prompt-secret-gate.ts'
import {registerProjectTools,projectToolNames,type ProjectToolsPorts} from '../src/project-tools.ts'

const owner='local:owner',id='11111111-1111-4111-8111-111111111111',now='2026-10-12T00:00:00.000Z'
const fields={scope:'general',title:'发布准备',goal:'收齐发布材料',dueDate:null,state:'planning' as const,links:[],references:[]}
const project:WorkProject={...fields,id,ownerId:owner,version:1,createdAt:now,updatedAt:now}
type Ports=ProjectToolsPorts
const definitionOf=({scope,title,goal,dueDate,state,links,references}:WorkProject)=>projectDefinition({scope,title,goal,dueDate,state,links,references})

async function setup(overrides:Partial<Ports>={},options:{subagent?:boolean;instructions?:number}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('project-tools-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let i=0;i<(options.instructions??1);i++)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'project-request'},content:[{type:'text',text:'建立发布项目'}]}),{surfaceOp:'append'})
 const writes:Array<{endpoint:string;payload:any}>=[],reads:Array<{endpoint:string;payload:any}>=[],creates=new Map<string,WorkProject>(),edits=new Map<number,{fields:unknown;result:WorkProject}>()
 let current={...project}
 const service={
  list:async()=>[current],overview:async()=>({rows:[current],nextCursor:null}),
  get:async(_owner:string,input:unknown)=>{assert.equal(_owner,owner);assert.equal((input as any).projectId,id);return {project:current,items:[],references:[],summary:{totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0}}},
  candidates:async()=>[],
  create:async(_owner:string,input:unknown)=>{assert.equal(_owner,owner);const row=input as any;const normalized=projectDefinition(row.fields);const existing=creates.get(row.requestId);if(existing){if(JSON.stringify(definitionOf(existing))!==JSON.stringify(normalized))throw new WorkError('teloa/conflict','请求已用于不同项目');return existing}const saved={...project,...normalized};creates.set(row.requestId,saved);return saved},
  edit:async(_owner:string,input:unknown)=>{assert.equal(_owner,owner);const row=input as any,normalized=projectDefinition(row.fields),existing=edits.get(row.expectedVersion);if(existing){if(JSON.stringify(existing.fields)!==JSON.stringify(normalized))throw new WorkError('teloa/version-conflict','原版本已用于其他修改');return existing.result}if(current.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','项目已变化');current={...current,...normalized,version:current.version+1};edits.set(row.expectedVersion,{fields:normalized,result:current});return current},
 }
 const handler=createProjectHandler(owner,async()=>service)
 const ports:Ports={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,scopes:async()=>['general','SOC'],admitText:groupMessageSecretGate(()=>[]),route:async(endpoint,payload)=>{(endpoint==='projects/create'||endpoint==='projects/edit'?writes:reads).push({endpoint,payload});return handler(endpoint,payload)},...overrides}
 registerProjectTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call',signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal})
 return {ctx,agent,call,writes,reads,current:()=>current,change:(patch:Partial<WorkProject>)=>{current={...current,...patch}}}
}
const json=(result:any)=>JSON.parse(result.content.filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n'))

test('项目自然语言目录、详情、候选、创建与修改通过原项目口，回执属于原平台会话',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(row=>row.name.startsWith('teloa_projects_')).map(row=>row.name),[...projectToolNames])
 const directory=await e.call('teloa_projects_list');assert.equal(directory.isError,false);assert.deepEqual(json(directory).scopes,['general','SOC']);assert.equal(json(directory).rows[0].title,fields.title)
 const detail=await e.call('teloa_projects_get',{projectId:id});assert.equal(detail.isError,false);assert.equal(json(detail).project.version,1);assert.equal(json(detail).sessionId,e.agent.session.id)
 assert.equal((await e.call('teloa_projects_candidates',{scope:'general',kind:'task',query:''})).isError,false)
 const result=await e.call('teloa_projects_create',{fields});assert.equal(result.isError,false);assert.equal(json(result).schema,'teloa.project-result/v1');assert.equal(json(result).projectId,id);assert.equal(json(result).projectTitle,fields.title);assert.equal(json(result).sessionId,e.agent.session.id)
 for(const name of ['teloa_projects_delete','teloa_projects_execute','teloa_projects_grant'])assert.equal((await e.call(name)).isError,true)
})

test('创建请求由原本人指令和真实调用固定，重放不变，同轮不同调用分开',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const callId of ['one','one','two'])assert.equal((await e.call('teloa_projects_create',{fields},callId)).isError,false)
 assert.equal(e.writes[0]!.payload.requestId,e.writes[1]!.payload.requestId);assert.notEqual(e.writes[0]!.payload.requestId,e.writes[2]!.payload.requestId)
 assert.equal('ownerId' in e.writes[0]!.payload,false);assert.equal('sessionId' in e.writes[0]!.payload,false)
 assert.equal((await e.call('teloa_projects_create',{fields:{...fields,title:'另一项目'}},'one')).isError,true)
})

test('完整定义、宿主身份与真实版本不能由参数绕过，未登记业务不写',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{fields,ownerId:'other'},{fields,sessionId:'other'},{fields,requestId:id},{fields:{...fields,state:'running'}},{fields:{...fields,references:undefined}},{fields:{...fields,scope:'Unknown'}},{fields:{...fields,canAutoRun:true}}])assert.equal((await e.call('teloa_projects_create',args)).isError,true)
 for(const args of [{projectId:id,fields},{projectId:id,expectedVersion:0,fields},{projectId:id,expectedVersion:1,fields:{...fields,scope:'SOC'}}])assert.equal((await e.call('teloa_projects_change',args)).isError,true)
 assert.equal(e.writes.length,0)
})

test('修改、归档及恢复保留原项目；旧版本重放只复用服务回执',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const args={projectId:id,expectedVersion:1,fields:{...fields,state:'archived'}}
 for(let i=0;i<2;i++)assert.equal((await e.call('teloa_projects_change',args,'archive')).isError,false)
 assert.equal(e.current().version,2);assert.equal(e.current().state,'archived')
 assert.equal((await e.call('teloa_projects_change',{...args,fields:{...fields,title:'旧版本覆盖'}},'stale')).isError,true)
 assert.equal((await e.call('teloa_projects_change',{projectId:id,expectedVersion:2,fields},'restore')).isError,false)
 assert.equal(e.current().id,id);assert.equal(e.current().state,'planning');assert.equal(e.current().version,3)
})

test('非本人、待归属、受管任务、搭建、子代理和没有唯一本人指令不写',async t=>{
 const cases:Array<{overrides?:Partial<Ports>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{overrides:{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready'})}},{overrides:{conversation:async sessionId=>({ownerId:owner,sessionId,status:'pending'})}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'managed'})}},{overrides:{isTaskConversation:async()=>true}},{overrides:{isBuilder:async()=>true}},{overrides:{isPendingDaily:async()=>true}}]
 for(const c of cases){const e=await setup(c.overrides,c.options);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_projects_create',{fields})).isError,true);assert.equal(e.writes.length,0)}
})

test('预检等待期间本人指令变化或取消不能写，凭据命中与外本人回执不冒充成功',async t=>{
 let e:Awaited<ReturnType<typeof setup>>,changed=false
 e=await setup({scopes:async()=>{if(!changed){changed=true;e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'new'},content:[{type:'text',text:'先停止创建'}]}),{surfaceOp:'append'})}return ['general']}});t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_projects_create',{fields})).isError,true);assert.equal(e.writes.length,0)
 const cancel=new AbortController(),cancelled=await setup({scopes:async()=>{cancel.abort();return ['general']}});t.after(()=>cancelled.ctx.fiber.dispose())
 assert.equal((await cancelled.call('teloa_projects_create',{fields},'cancel',cancel.signal)).isError,true);assert.equal(cancelled.writes.length,0)
 const secret=await setup({admitText:groupMessageSecretGate(()=>['private-test-key-12345'])});t.after(()=>secret.ctx.fiber.dispose());assert.equal((await secret.call('teloa_projects_create',{fields:{...fields,goal:'使用 private-test-key-12345'}})).isError,true);assert.equal(secret.writes.length,0)
 const foreign=await setup({route:async()=>({...project,ownerId:'other'})});t.after(()=>foreign.ctx.fiber.dispose());assert.equal((await foreign.call('teloa_projects_create',{fields})).isError,true)
})

test('前置核对与执行之间项目变化拒绝覆盖；审核拒绝不写',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 e.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name==='teloa_projects_change')e.change({version:2,title:'另一处已更新'});return next()})
 assert.equal((await e.call('teloa_projects_change',{projectId:id,expectedVersion:1,fields:{...fields,title:'覆盖旧资料'}})).isError,true);assert.equal(e.writes.length,0)
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny' as const,reason:'本人取消审批'}))
 assert.equal((await denied.call('teloa_projects_create',{fields})).isError,true);assert.equal(denied.writes.length,0)
})

for(const phase of ['review','approval'])test(`真实原生 Auto ${phase} 等待期间新本人指令不能承接旧项目参数`,async t=>{
 const fixture=await import('../../../tests/native-auto-review-fixture.mjs') as any
 const {ctx,adapter,create}=await fixture.createRuntime(t),agent=await create('project-auto-'+phase+'-turn-race')
 await ctx.plugin(fixture.autoReview);ctx.permissionPresets.set(agent.session,'auto')
 let writes=0,entered!:()=>void,release!:()=>void
 const waiting=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
 registerProjectTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,scopes:async()=>['general'],admitText:groupMessageSecretGate(()=>[]),route:async()=>{writes++;return project}})
 const call=fixture.toolResponse('teloa_projects_create','old-call'),body=JSON.stringify({fields});call[1].argumentsDelta=body;call[2].block.arguments=body
 if(phase==='approval')ctx.on('approval/request',async()=>{entered();await released;return 'allowed-once'})
 const review=phase==='review'?(async function*(){entered();await released;yield* fixture.textResponse(JSON.stringify({risk:'low',decision:'allow'}))})():fixture.textResponse(JSON.stringify({risk:'medium',decision:'deny'}))
 adapter.script.push(call,review,fixture.textResponse('done'))
 agent.followup(fixture.createUserMessage({source:{kind:'user',rpcId:'old-turn'},content:[{type:'text',text:'创建发布准备项目'}]}))
 const idle=agent.whenIdle();await waiting
 agent.session.append('turn/start',{turn:2});agent.session.append('user/message',fixture.createUserMessage({source:{kind:'user',rpcId:'new-turn'},content:[{type:'text',text:'先停止创建，回答另一个问题'}]}),{surfaceOp:'append'})
 release();await idle
 assert.equal(writes,0)
 const result=agent.session.snapshotEvents().find((event:any)=>event.type==='tool/result');assert.equal(result?.data.message.isError,true)
})
