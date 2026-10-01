import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerSkillInstallTools,skillInstallToolNames,type SkillInstallToolsPorts} from '../src/skill-install-tools.ts'

const owner='local:teloa-owner',contentId='11111111-1111-4111-8111-111111111111',installationId='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64),trustHash='f'.repeat(64)
const source={kind:'atomic' as const,contentId}
const trust={publisher:{name:'Teloa'},license:{status:'missing'},signature:{status:'unverified'},compatibility:{teloa:'*',dsh:'*'},capabilities:{plugins:[],external:[],permissions:['filesystem:managed-skill']},review:{conclusion:'needs-review'}}
const preview={source:{kind:'atomic',contentId,contentHash:'b'.repeat(64),resourceId:'brief',resourceVersion:'1.0.0'},bundleHash:hash,trustHash,trust,installationPlan:{skills:['brief'],plugins:[],connections:[],permissions:['filesystem:managed-skill']},native:{name:'brief',description:'写简报',modelInvocable:true,userInvocable:true,bodyHash:'c'.repeat(64)},files:[{path:'SKILL.md',hash:'d'.repeat(64),size:50}]}
const installation={id:installationId,ownerId:owner,source:preview.source,bundleHash:hash,trustHash,trust,native:preview.native,state:'installed',version:1,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
const require=createRequire(import.meta.url)
async function nativeApprovalService(){const fromTools=createRequire(require.resolve('@deepseek-ai/dsh-tools'));return (await import(fromTools.resolve('@deepseek-ai/dsh-user-approval'))).ApprovalService}

async function setup(overrides:Partial<SkillInstallToolsPorts>={},subagent=false){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(subagent?'skill-child':'skill-owner'),...(subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}}),calls:unknown[][]=[]
 const ports:SkillInstallToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,directory:async()=>({atomic:[],industry:[],installations:[],usages:[]}),handler:async(method,payload)=>{calls.push([method,payload]);if(method==='skill-installations/preview')return preview;if(method==='skill-installations/install')return {installation,source:preview.source};return {installationId,scope:'default-workspace',state:'available',current:{...preview.native,provider:'teloa-market',source:'/managed/brief/SKILL.md'}}},...overrides}
 registerSkillInstallTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}

test('四个 Skill 工具通过真实 ToolRuntime 注册并只转发严格来源身份',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const schemas=e.ctx.tools.schemas(e.agent).filter(x=>x.name.startsWith('teloa_skills_'))
 assert.deepEqual(schemas.map(x=>x.name).sort(),[...skillInstallToolNames].sort())
 for(const name of ['teloa_skills_preview','teloa_skills_install'])assert.ok((schemas.find(x=>x.name===name)?.parameters as {required?:string[]}).required?.includes('source'))
 assert.equal((await e.call('teloa_skills_directory')).isError,false)
 assert.equal((await e.call('teloa_skills_preview')).isError,true)
 assert.equal((await e.call('teloa_skills_preview',{source})).isError,false)
 assert.equal((await e.call('teloa_skills_observe',{installationId})).isError,false)
 for(const invalid of [{source:{...source,ownerId:owner}},{source:{...source,path:'/tmp'}},{source:{kind:'industry',loadId:contentId,itemInstanceId:installationId,extra:true}}])assert.equal((await e.call('teloa_skills_preview',invalid)).isError,true)
 assert.deepEqual(e.calls,[['skill-installations/preview',{source}],['skill-installations/observe',{installationId}]])
})

test('安装先取得真实预览再 ask，确认前不安装，理由显示原生名称、摘要和当前宿主',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_skills_install',{source,expectedBundleHash:hash})).isError,true)
 assert.deepEqual(e.calls,[['skill-installations/preview',{source}]])
 let reason='';const allowed=await setup();t.after(()=>allowed.ctx.fiber.dispose());allowed.ctx.provide('approval',{request:async(input:{reason?:string})=>{reason=input.reason??'';return 'allowed-once'}})
 assert.equal((await allowed.call('teloa_skills_install',{source,expectedBundleHash:hash,expectedTrustHash:trustHash},'stable-call')).isError,false)
 assert.match(reason,/brief/);assert.match(reason,new RegExp(hash));assert.match(reason,new RegExp(trustHash));assert.match(reason,/未验证/);assert.match(reason,/当前 Teloa/)
 assert.equal(allowed.calls[1]?.[0],'skill-installations/install')
 assert.deepEqual((allowed.calls[1]?.[1] as {expectedTrustHash?:string}).expectedTrustHash,trustHash)
})

test('稳定 callId 生成同一 requestId，同一调用改摘要及预览变化均拒绝安装',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
 await e.call('teloa_skills_install',{source,expectedBundleHash:hash,expectedTrustHash:trustHash},'same');await e.call('teloa_skills_install',{source,expectedBundleHash:hash,expectedTrustHash:trustHash},'same')
 const writes=e.calls.filter(x=>x[0]==='skill-installations/install') as [string,{requestId:string}][]
 assert.equal(writes.length,2);assert.equal(writes[0]![1].requestId,writes[1]![1].requestId);assert.match(writes[0]![1].requestId,/^[a-f0-9-]{36}$/)
 assert.equal((await e.call('teloa_skills_install',{source,expectedBundleHash:'e'.repeat(64),expectedTrustHash:trustHash},'same')).isError,true)
 assert.equal(writes.length,e.calls.filter(x=>x[0]==='skill-installations/install').length)
})

test('本人身份在前置和正文双验，子 Agent、任务会话与审批中身份变化不执行安装',async t=>{
 for(const [overrides,child] of [[{},true],[{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task'})},false],[{conversation:async(sessionId:string)=>({ownerId:'other',sessionId,status:'ready' as const})},false]] as const){const e=await setup(overrides,child);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_skills_install',{source,expectedBundleHash:hash})).isError,true);assert.equal(e.calls.length,0)}
 let ready=true;const changed=await setup({conversation:async sessionId=>({ownerId:owner,sessionId,status:ready?'ready':'pending'})});t.after(()=>changed.ctx.fiber.dispose());changed.ctx.provide('approval',{request:async()=>{ready=false;return 'allowed-once'}})
 assert.equal((await changed.call('teloa_skills_install',{source,expectedBundleHash:hash,expectedTrustHash:trustHash})).isError,true);assert.equal(changed.calls.some(x=>x[0]==='skill-installations/install'),false)
})

test('已有原生 deny 保留且不读预览，已有 ask 合并固定预览后才允许安装',async t=>{
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生拒绝'}));assert.equal((await denied.call('teloa_skills_install',{source,expectedBundleHash:hash})).isError,true);assert.equal(denied.calls.length,0)
 const asked=await setup();t.after(()=>asked.ctx.fiber.dispose());asked.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'原生确认'}));let reason='';const ApprovalService=await nativeApprovalService();await asked.ctx.plugin(ApprovalService,{policy:'ask'});asked.ctx.on('approval/request' as never,(async(input:{reason?:string})=>{reason=input.reason??'';return 'allowed-once'}) as never);asked.agent.session.append('turn/start',{turn:0})
 assert.equal((await asked.call('teloa_skills_install',{source,expectedBundleHash:hash,expectedTrustHash:trustHash})).isError,false)
 assert.deepEqual(asked.calls.map(x=>x[0]),['skill-installations/preview','skill-installations/install']);assert.match(reason,/原生确认/);assert.match(reason,/brief/);assert.match(reason,new RegExp(hash))
})
