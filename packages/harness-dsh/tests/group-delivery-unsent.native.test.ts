import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId,type SessionEvent,type SessionHeader} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {PermissionPresetService} from '@deepseek-ai/dsh-permission-presets'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {SandboxPolicyService} from '@deepseek-ai/dsh-sandbox-policy'
import {ConversationService,FileConversationRepository} from '../../backend/src/work/conversations.ts'
import {createGroupDeliveryUnsentProof} from '../src/group-delivery-unsent.ts'
import {readSessionEvents} from '../src/session-events.ts'

type Cleanup={after:(fn:()=>unknown)=>void}
async function fixture(t:Cleanup,compression:'none'|'zstd'='zstd',preset='workspace-write'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-unsent-'))),ctx=new Context()
 let modelCalls=0
 t.after(async()=>{await ctx.fiber.dispose();assert.equal(modelCalls,0);await rm(root,{recursive:true,force:true})})
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry)
 await ctx.plugin(Persistence,{root:join(root,'sessions'),compression})
 await ctx.plugin(AgentLoop,{agents:[]})
 class NoModel extends LlmAdapter{async *stream():AsyncIterable<StreamChunk>{modelCalls++;throw Error('初始化验收禁止任何模型调用。')}}
 ctx.llm.registerAdapter(['no-model'],new NoModel())
 await ctx.plugin(ApprovalService,{policy:'ask'});await ctx.plugin(SandboxPolicyService,{mode:'workspace-write',workspaceRoot:root})
 ctx.provide('shell',{sandboxMode:'workspace-write'})
 await ctx.plugin(PermissionPresetService,{defaultPreset:preset,presets:{'workspace-write':{sandbox:'workspace-write',approval:'ask'},'strict-editor':{sandbox:'read-only',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}}})
 const owner='synthetic-'+randomUUID(),requestId=randomUUID(),taskId=randomUUID(),roleId=randomUUID(),roleVersion=3,sessionId='task-run-'+requestId,repository=new FileConversationRepository(join(root,'conversations.json'))
 const conversations=new ConversationService(repository,{create:async(id,_workspace,agentPreset)=>{const {agent}=await ctx.agents.create({sessionId:SessionId(id),meta:{cwd:root,...(agentPreset?{agentPreset}:{})},agentOptions:{provider:'no-model',model:'forbidden'}});assert.equal(await ctx.sessions.flush(agent.session),true);return id},inspect:async()=>{}},{id:randomUUID,now:()=>new Date().toISOString()})
 await conversations.createRun(owner,{requestId,title:'原固定合成文本工作'},{sessionId,taskId,taskVersion:2,roleId,roleVersion,agentPresetId:'editor-native'})
 const input={ownerId:owner,requestId,taskId,roleId,roleVersion},options={owner,conversations,agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,permissions:ctx.permissionPresets,expectedCwd:()=>root},proof=createGroupDeliveryUnsentProof(options),session=ctx.sessions.get(SessionId(sessionId))!
 const resolver=Reflect.get(ctx.sessionPersistence,'resolveCurrentLog');assert.equal(typeof resolver,'function');const path:string=await resolver.call(ctx.sessionPersistence,SessionId(sessionId));assert.ok(path)
 assert.equal(modelCalls,0);assert.equal(ctx.agents.get(SessionId(sessionId))?.status,'idle')
 return {root,ctx,owner,requestId,taskId,roleId,roleVersion,sessionId,repository,conversations,input,options,proof,session,path}
}

test('官方native factory正常初始化三事件经完整持久化读口证明未发送，冷热只读且可重复',{timeout:30000},async t=>{
 for(const compression of ['none','zstd'] as const){
  const x=await fixture(t,compression),before=await readFile(x.path),rows=await x.repository.read(),events=readSessionEvents(x.session)
  assert.deepEqual(events.map(event=>event.type),['permission/preset','sandbox/mode','approval/policy'],'三事件来自实际PermissionPresetService的session/created回调，不由用例拼成正例')
  const agent=x.ctx.agents.get(SessionId(x.sessionId))!;assert.equal(agent.status,'idle');assert.equal(agent.inbox.nextTurn.length,0);assert.equal(agent.inbox.nextStep.length,0);assert.equal(agent.session,x.session)
  const stored=await x.ctx.sessionPersistence.open(SessionId(x.sessionId),'read');try{assert.deepEqual({...x.session.header,delegationDepth:x.session.header.delegationDepth??0},{...stored.header,delegationDepth:stored.header.delegationDepth??0});assert.equal(Number(x.session.inheritedEventCount),0);assert.deepEqual(readSessionEvents(x.session),(await stored.read(0)).events)}finally{await stored.close()}
  const first=await x.proof(x.input,AbortSignal.timeout(5000));assert.equal(first.unsent,true);assert.equal(first.sessionId,x.sessionId);assert.match(first.sha256,/^[a-f0-9]{64}$/)
  assert.deepEqual(await x.proof(x.input),first);assert.deepEqual(await readFile(x.path),before);assert.deepEqual(await x.repository.read(),rows)
  const cold=new Context();t.after(()=>cold.fiber.dispose());await cold.plugin(SessionStore);await cold.plugin(SessionProjectionRegistry);await cold.plugin(AgentRegistry);await cold.plugin(Persistence,{root:join(x.root,'sessions'),compression});await cold.plugin(ApprovalService,{policy:'ask'});cold.provide('shell',{sandboxMode:'workspace-write'});await cold.plugin(PermissionPresetService,{defaultPreset:'workspace-write'})
  const inspect=createGroupDeliveryUnsentProof({...x.options,agents:cold.agents,sessions:cold.sessions,persistence:cold.sessionPersistence,permissions:cold.permissionPresets})
  assert.deepEqual(await inspect(x.input),first,'冷读不激活Agent，也不重新创建会话')
  assert.deepEqual(await readFile(x.path),before);assert.deepEqual(await x.repository.read(),rows)
 }
})

test('初始化值由公开defaultPreset和resolve查真实bundle，别名可用，配置漂移或预约身份错误均拒绝',async t=>{
 const x=await fixture(t,'zstd','strict-editor'),initial=await x.proof(x.input)
 assert.deepEqual(readSessionEvents(x.session).map(event=>event.data),[{preset:'strict-editor'},{mode:'read-only'},{policy:'ask'}])
 const spec=x.ctx.permissionPresets.resolve('strict-editor');spec.approval='never';await assert.rejects(x.proof(x.input));spec.approval='ask';assert.deepEqual(await x.proof(x.input),initial)
 for(const change of [{ownerId:'foreign'},{requestId:randomUUID()},{taskId:randomUUID()},{roleId:randomUUID()},{roleVersion:4}])await assert.rejects(x.proof({...x.input,...change}))
 const changed=await x.repository.read(),original=changed[0]!;changed[0]={...original,run:{...original.run!,agentPresetId:'other-preset'}};await x.repository.write(changed);await assert.rejects(x.proof(x.input))
})

test('完整原生日志拒绝任意配置追加、工作/未知事件、seed与不完整或乱序初始化；不删除或重置历史',async t=>{
 for(const fault of ['same-setting','changed-setting','queued-input','user','request','assistant','tool','unknown','seed-marker','repeated-seed','empty','partial','order','payload','parent','seeded','truncated','unflushed-work','cwd','default-drift'] as const){
  const x=await fixture(t,'none'),original=await x.repository.read()
  if(fault==='same-setting')x.session.append('approval/policy',{policy:'ask'})
  else if(fault==='changed-setting')x.session.append('sandbox/mode',{mode:'danger-full-access'})
  else if(fault==='queued-input')x.ctx.agents.get(SessionId(x.sessionId))!.inbox.append('next-turn',createUserMessage({source:{kind:'user',rpcId:x.requestId},content:[{type:'text',text:'实际队列已有原工作输入'}]}))
  else if(fault==='user')x.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:x.requestId},content:[{type:'text',text:'实际工作输入'}]}),{surfaceOp:'append'})
  else if(fault==='unflushed-work')x.session.append('approval/policy',{policy:'never'})
  else if(fault==='cwd'){const wrong=createGroupDeliveryUnsentProof({...x.options,expectedCwd:()=>join(x.root,'other')});await assert.rejects(wrong(x.input));continue}
  else if(fault==='default-drift'){
   const changed=new Context();t.after(()=>changed.fiber.dispose());await changed.plugin(SessionStore);await changed.plugin(SessionProjectionRegistry);await changed.plugin(ApprovalService,{policy:'ask'});changed.provide('shell',{sandboxMode:'workspace-write'});await changed.plugin(PermissionPresetService,{defaultPreset:'danger-full-access'})
   await assert.rejects(createGroupDeliveryUnsentProof({...x.options,permissions:changed.permissionPresets})(x.input));continue
  }else{
   // 负例只篡改本用例自有文件，不生成正例、不改原验收现场。
   const lines=(await readFile(x.path,'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line)),header:SessionHeader=lines[0],events=lines.slice(1) as SessionEvent[],now=Date.now()
   if(fault==='truncated'){await writeFile(x.path,(await readFile(x.path,'utf8'))+'{"type":"request/header"');await assert.rejects(x.proof(x.input));continue}
   if(fault==='parent')lines[0]={...header,parentSession:'foreign',delegationDepth:1}
   else if(fault==='seeded')lines[0]={...header,isSeeded:true,inheritedEventCount:3}
   else if(fault==='empty')lines.splice(1)
   else if(fault==='partial')lines.splice(3,1)
   else if(fault==='order'){lines[1]={...events[1],seq:0};lines[2]={...events[0],seq:1}}
   else if(fault==='payload')lines[1]={...events[0],data:{preset:'workspace-write',extra:'untrusted'}}
   else{
    const type=fault==='request'?'request/header':fault==='assistant'?'assistant/message':fault==='tool'?'tool/call':fault==='unknown'?'unknown/record':'session/end-seed'
    lines.push({type,seq:3,time:now,data:{}});if(fault==='repeated-seed')lines.push({type:'session/end-seed',seq:4,time:now,data:{}})
   }
   await writeFile(x.path,lines.map(line=>JSON.stringify(line)).join('\n')+'\n')
  }
  if(['same-setting','changed-setting','queued-input','user'].includes(fault))assert.equal(await x.ctx.sessions.flush(x.session),true)
  const fileBefore=await readFile(x.path);await assert.rejects(x.proof(x.input),fault);assert.deepEqual(await readFile(x.path),fileBefore,fault);assert.deepEqual(await x.repository.read(),original,fault)
 }
 const compressed=await fixture(t,'zstd');await writeFile(compressed.path,Buffer.concat([await readFile(compressed.path),Buffer.from('{"type":"request/header"')]));const before=await readFile(compressed.path);await assert.rejects(compressed.proof(compressed.input));assert.deepEqual(await readFile(compressed.path),before,'压缩尾部未知也必须拒绝，不截断修复原文件')
})
