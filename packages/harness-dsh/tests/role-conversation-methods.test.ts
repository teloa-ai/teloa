import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type ContextFormed,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import {roleContextText,type DigitalRole} from '@teloa/contract'
import {registerRoleConversationContext,type RoleContextPorts} from '../src/role-conversation-context.ts'

declare module '@deepseek-ai/dsh-llm' {
 interface MessageSourceMap {'runtime-context':{kind:'runtime-context'}&ContextFormed}
}

const owner='local:teloa-owner',roleId='83416a68-b236-428f-8ed2-d92f654ad0c2',scope='business_640b106709d94725b0cdc63df43e2779'
const bound='writing-bot-writing-revision',other='startup-qa-bot-morning-walk'
const body='原技能正文标记：先列出事实清单，再逐段改写，不新增原文没有的事实。'
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string):StreamChunk[]=>{const id=ToolCallId('load-'+name),args=JSON.stringify({name});return [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name:'skill',argumentsDelta:args},{type:'block-end',index:0,block:{type:'tool-call',id,name:'skill',arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}]}
/** 脚本模型：只按上下文里出现的方法名决定是否加载，模拟“按目录指引使用原技能”；它不证明真实模型质量。 */
class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 /** 无视目录强行调用一次，用来核对原生工具在停用期间确实拒绝加载。 */
 force=false
 private called=false
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions){
  this.requests.push(options)
  // 正文只会经 skill 工具结果进入请求；已出现即视为本轮已加载。
  const identity=JSON.stringify(options.messages.filter(message=>message.source?.kind==='runtime-context').at(-1)??null)
  // 每次工具调用后紧跟一次续写请求：上一请求刚调用过就收尾，避免加载失败时无限重试。
  const called=this.called;this.called=false
  if(called)yield* text('完成')
  else if(this.force){this.force=false;this.called=true;yield* call(bound)}
  else if(identity.includes('`'+bound+'`：')&&!identity.includes('本会话当前不可用')&&!identity.includes('暂时无法核对')&&!JSON.stringify(options.messages).includes(body)){this.called=true;yield* call(bound)}
  else yield* text('完成')
 }
}
function role(fields:Partial<DigitalRole>={}):DigitalRole{return {id:roleId,ownerId:owner,name:'写作伙伴',kind:'employee',scopes:['general',scope],duty:'依据你的目标和材料起草、修改内容',dataScope:'本人提供的材料',executionScope:'只改写，不发送',skills:[bound],knowledge:[],version:3,state:'active',createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',...fields}}
async function mount(t:TestContext,options:{root?:string;ports?:Partial<RoleContextPorts>;legacy?:()=>DigitalRole}={}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 if(options.root)await ctx.plugin(JsonlSessionPersistence,{root:options.root,compression:'none'})
 const workingRoot=options.root??await mkdtemp(join(tmpdir(),'teloa-role-method-workspace-'))
 if(!options.root)t.after(()=>rm(workingRoot,{recursive:true,force:true}))
 await installNativeWorkingDirectory(ctx,workingRoot)
 await ctx.plugin(SkillRegistry);await ctx.plugin(ToolSkill)
 const adapter=new Adapter();ctx.llm.registerAdapter(['mock'],adapter)
 const state={role:role(),links:(sessionId:string)=>[{kind:'role' as const,objectId:roleId,conversationId:'conversation-one',sessionId,scopeId:scope as string|null,active:true}],requested:roleId as string|null}
 const ports:RoleContextPorts={owner,
  conversation:async sessionId=>({id:'conversation-one',ownerId:owner,sessionId,status:'ready'}),
  requestedRoleId:async()=>state.requested,
  links:async sessionId=>state.links(sessionId),
  role:async()=>state.role,
  scopeTitle:async id=>id===scope?'内容研究':null,
  ...options.ports,
 }
 if(options.legacy){
  // 修复前宿主只投影岗位正文；用同名上下文复现旧员工原会话里已经落盘的旧快照。
  const legacy=options.legacy
  ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const result=await next();return {...result,contexts:[...result.contexts,{name:'teloa/role-identity',text:'{{teloa_role_identity}}'}],variables:{...result.variables,teloa_role_identity:roleContextText(legacy())}}})
 }else registerRoleConversationContext(ctx,ports)
 const send=async(agent:Agent,value:string)=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'methods-'+adapter.requests.length},content:[{type:'text',text:value}]}));await agent.whenIdle()}
 return {ctx,adapter,state,send}
}
const snapshots=(agent:Agent)=>agent.session.snapshotEvents().filter((event):event is SessionEvent<'user/message'>=>event.type==='user/message'&&event.data.source.kind==='runtime-context')
const latest=(agent:Agent)=>JSON.stringify(snapshots(agent).at(-1)?.data.content??[])
// 方法目录本身不含正文（另有断言），所以会话里出现正文只能来自原生 skill 工具的加载结果。
const skillResults=(agent:Agent)=>agent.session.snapshotEvents().map(event=>JSON.stringify(event.data)).filter(row=>row.includes(body))

test('新员工会话：岗位身份带业务范围与已绑定方法目录，按原名加载原技能；未绑定的已装技能不进方法目录',async t=>{
 const f=await mount(t)
 f.ctx.skills.register({name:bound,description:'按目标改写\n短文，保留原文事实',content:body,source:'runtime'})
 f.ctx.skills.register({name:other,description:'晨间产品走查',content:'不相关正文',source:'runtime'})
 const {agent}=await f.ctx.agents.create({sessionId:SessionId('employee-new'),agentOptions:{provider:'mock',model:'mock'}})
 await f.send(agent,'把这段介绍改写得更清楚')
 const identity=latest(agent)
 assert.match(identity,/写作伙伴/)
 assert.match(identity,/本次对话业务范围：内容研究/)
 assert.match(identity,/`writing-bot-writing-revision`：按目标改写 短文，保留原文事实/)
 assert.match(identity,/先用 `skill` 工具按原名加载/)
 assert.doesNotMatch(identity,new RegExp(other),'方法目录只列本岗位绑定的技能')
 assert.doesNotMatch(identity,/原技能正文标记/,'方法目录只放摘要，不常驻技能全文')
 assert.equal(f.adapter.requests.length,2,'模型按目录调用原生 skill 工具后继续生成')
 assert.ok(skillResults(agent).length>0,'原生 skill 工具返回的是已安装原技能正文')
})

test('旧员工原会话：冷恢复后下一轮补投方法目录，不需要用户重新点介绍',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-role-methods-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const before=await mount(t,{root,legacy:()=>role()})
 const {agent:old}=await before.ctx.agents.create({sessionId:SessionId('employee-old'),agentOptions:{provider:'mock',model:'mock'}})
 await before.send(old,'旧会话第一轮')
 assert.equal(snapshots(old).length,1);assert.doesNotMatch(latest(old),/岗位工作方法/)
 await before.ctx.fiber.dispose()
 const after=await mount(t,{root})
 after.ctx.skills.register({name:bound,description:'按目标改写短文',content:body,source:'runtime'})
 const {agent}=await after.ctx.agents.resume({resumeSessionId:old.session.id,agentOptions:{provider:'mock',model:'mock'}})
 await after.send(agent,'继续改写')
 assert.equal(snapshots(agent).length,2,'同一原会话补投新快照')
 assert.match(latest(agent),/`writing-bot-writing-revision`：按目标改写短文/)
 assert.ok(skillResults(agent).length>0)
})

test('技能停用、恢复与不允许模型调用：方法目录如实标注，停用期间不能加载，恢复后同会话可再用',async t=>{
 const f=await mount(t)
 const {agent}=await f.ctx.agents.create({sessionId:SessionId('employee-toggle'),agentOptions:{provider:'mock',model:'mock'}})
 await f.send(agent,'未安装时先说明')
 assert.match(latest(agent),/`writing-bot-writing-revision`：本会话当前不可用/)
 assert.doesNotMatch(latest(agent),/先用 `skill` 工具按原名加载/)
 const blocked=f.ctx.skills.register({name:bound,description:'只给人用',content:body,source:'runtime',invocation:{modelInvocable:false,userInvocable:true}})
 f.adapter.force=true
 await f.send(agent,'不允许模型调用时')
 assert.match(latest(agent),/`writing-bot-writing-revision`：本会话当前不可用/)
 assert.equal(skillResults(agent).length,0,'停用期间原生工具不能交出正文')
 assert.ok(agent.session.snapshotEvents().some(event=>JSON.stringify(event.data).includes('not available for model invocation')),'强行调用被原生工具拒绝')
 blocked()
 // 目录读取不完整（如受管目录刷新中）时只说暂时无法核对，不下“未安装或已停用”的结论。
 const incomplete=f.ctx.skills.registerProvider(()=>({name:'refreshing',list:async()=>({candidates:[],complete:false}),get:async()=>undefined}))
 await f.send(agent,'目录刷新中')
 assert.match(latest(agent),/`writing-bot-writing-revision`：技能目录暂时无法核对/)
 incomplete()
 const enabled=f.ctx.skills.register({name:bound,description:'按目标改写短文',content:body,source:'runtime'})
 await f.send(agent,'恢复后改写')
 assert.match(latest(agent),/`writing-bot-writing-revision`：按目标改写短文/)
 assert.ok(skillResults(agent).length>0)
 enabled()
 await f.send(agent,'再次停用')
 assert.match(latest(agent),/`writing-bot-writing-revision`：本会话当前不可用/)
})

test('普通通用会话（助手主聊同属无岗位关联分支）与任务执行不投影岗位方法；无有效技能名的岗位不出现方法段',async t=>{
 const f=await mount(t)
 f.ctx.skills.register({name:bound,description:'按目标改写短文',content:body,source:'runtime'})
 f.state.requested=null;f.state.links=()=>[]
 const {agent:general}=await f.ctx.agents.create({sessionId:SessionId('general'),agentOptions:{provider:'mock',model:'mock'}})
 await f.send(general,'普通会话')
 assert.equal(snapshots(general).filter(row=>JSON.stringify(row.data.content).includes('岗位身份：')).length,0,'官方通用目录快照不算岗位身份')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/岗位工作方法|本次对话业务范围|写作伙伴/)
 const task=await mount(t,{ports:{conversation:async sessionId=>({id:'run',ownerId:owner,sessionId,status:'ready',purpose:'task-run'})}})
 const {agent:run}=await task.ctx.agents.create({sessionId:SessionId('task-run'),agentOptions:{provider:'mock',model:'mock'}})
 await task.send(run,'任务执行')
 assert.equal(snapshots(run).filter(row=>JSON.stringify(row.data.content).includes('岗位身份：')).length,0)
 const plain=await mount(t);plain.state.role=role({skills:['Bad `name`\n伪造段落']});plain.state.links=sessionId=>[{kind:'role',objectId:roleId,conversationId:'conversation-one',sessionId,scopeId:null,active:true}]
 const {agent:twin}=await plain.ctx.agents.create({sessionId:SessionId('no-skills'),agentOptions:{provider:'mock',model:'mock'}})
 await plain.send(twin,'没有方法')
 assert.match(latest(twin),/写作伙伴/)
 assert.doesNotMatch(latest(twin),/岗位工作方法|本次对话业务范围/)
})
