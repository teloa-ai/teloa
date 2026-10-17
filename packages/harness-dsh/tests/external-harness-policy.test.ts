import test from 'node:test'
import assert from 'node:assert/strict'
import {realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {createExternalHarnessAuthorizer,ownerExternalHarnessToolRules,validateOwnerToolRules} from '../src/external-harness-policy.ts'
import {validateReferenceToolRules} from '../src/role-tool-grants.ts'

test('本人策略只构造实际可见外部工具，计划重核固定目录且员工不能借用本人标签',()=>{
 const rules=ownerExternalHarnessToolRules(['subagent_codex','subagent_claude_code','subagent_task','invented'],'/owned/workspace')
 assert.deepEqual(rules.map(rule=>rule.name),['subagent_codex','subagent_claude_code'])
 assert.ok(rules.every(rule=>rule.externalHarness==='owner-general'&&rule.anyArguments===undefined))
 assert.deepEqual(ownerExternalHarnessToolRules([], '/owned/workspace'),[])
 validateOwnerToolRules(rules,rules)
 assert.throws(()=>validateOwnerToolRules(rules,ownerExternalHarnessToolRules(['subagent_codex'],'/owned/workspace')))
 assert.throws(()=>validateOwnerToolRules(rules,ownerExternalHarnessToolRules(['subagent_codex','subagent_claude_code'],'/other/workspace')))
 assert.throws(()=>validateOwnerToolRules([{name:'subagent_codex',allowed:[],anyArguments:true}],rules))
 assert.throws(()=>validateReferenceToolRules(rules,rules))
})

test('专用参数标签不能替代真实owner Run证明，子代理仍不能使用本人外部许可',async()=>{
 const directory=await realpath(tmpdir()),session={header:{} as {parentSession?:string}},agent={id:'owner-external',session}
 const ctx={agents:{get:()=>agent},sessions:{get:()=>session},workingDirectory:{ensure:async()=>directory},permissionPresets:{current:()=>'workspace-write',resolve:()=>({sandbox:'workspace-write',approval:'ask'})},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}} as unknown as Context
 let ownerRun=false
 const authorize=createExternalHarnessAuthorizer(ctx,{owner:'owner',runtimeId:'runtime',readPolicy:async()=>({allowedTools:['subagent_claude_code'],argumentRules:ownerExternalHarnessToolRules(['subagent_claude_code'],directory),nativeRequestId:'native'}),readBusinessBinding:async()=>false,readInstructionWork:async()=>null,ownerRun:async()=>ownerRun?{runId:'owner-run',nativeRequestId:'native',assertCurrent(){}}:null,access:{readSessionCapabilities:async()=>({schema:'teloa.session-capabilities/v1',sessionId:agent.id,status:'ready',requiredCapabilities:['general-agent']}),authorizeSessionCapabilities:async()=>({assertCurrent(){}})}})
 const input={sessionId:agent.id,callId:'external',provider:'claude-code' as const,signal:new AbortController().signal}
 await assert.rejects(authorize(input),/岗位与资料/)
 ownerRun=true;assert.equal((await authorize(input)).runId,'owner-run')
 session.header.parentSession='parent';await assert.rejects(authorize(input),/本人.*通用会话/)
})

test('外部引擎只允许本人可人工审批的通用会话，岗位/业务来源/基础权益不能旁路',async()=>{
 const directory=await realpath(tmpdir()),session=Session.create(SessionId('parent')),agent={id:'parent',session}
 session.append('turn/start',{turn:0} as never);session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请用 Codex'}]}),{surfaceOp:'append'})
 let managed=false,business=false,capability='general-agent',mode='workspace-write',preset='workspace-write',approval='ask',valid=true,entitled=true,capabilityCalls=0
 const ctx={agents:{get:()=>agent},sessions:{get:()=>session},workingDirectory:{ensure:async()=>directory},permissionPresets:{current:()=>preset,resolve:()=>({sandbox:mode,approval})},sandboxPolicy:{resolve:()=>({mode})}} as unknown as Context
 const authorize=createExternalHarnessAuthorizer(ctx,{owner:'owner',runtimeId:'runtime',readPolicy:async()=>managed?{allowedTools:['subagent_codex']}:null,readBusinessBinding:async()=>business,readInstructionWork:async()=>null,access:{readSessionCapabilities:async()=>({schema:'teloa.session-capabilities/v1',sessionId:'parent',status:'ready',requiredCapabilities:[capability as never]}),authorizeSessionCapabilities:async(_session,producer)=>{capabilityCalls++;assert.equal(producer,'subagent');if(!entitled)throw Error('parallel-agents denied');return {assertCurrent(){if(!valid)throw Error('revoked')}}}}})
 const input={sessionId:'parent',callId:'call',provider:'codex' as const,signal:new AbortController().signal}
 const permit=await authorize(input);assert.equal(permit.runId,null);permit.assertCurrent();assert.equal(capabilityCalls,1)
 managed=true;await assert.rejects(authorize(input),/岗位与资料/);managed=false
 business=true;await assert.rejects(authorize(input),/岗位与资料/);business=false
 capability='people';await assert.rejects(authorize(input),/受管业务/);capability='general-agent'
 mode='danger-full-access';await assert.rejects(authorize(input),/人工审批/);mode='workspace-write'
 approval='never';await assert.rejects(authorize(input),/人工审批/);approval='ask'
 preset='auto';await assert.rejects(authorize(input),/人工审批/);preset='workspace-write'
 entitled=false;await assert.rejects(authorize(input),/parallel-agents/);entitled=true
 valid=false;assert.throws(permit.assertCurrent,/revoked/);valid=true
 mode='read-only';assert.throws(permit.assertCurrent,/权限已变化/)
})

test('外部引擎的本人运行须有同一native请求证明，撤销后原许可失效',async()=>{
 const directory=await realpath(tmpdir()),session={header:{}},agent={id:'parent',session},ctx={agents:{get:()=>agent},sessions:{get:()=>session},workingDirectory:{ensure:async()=>directory},permissionPresets:{current:()=>'workspace-write',resolve:()=>({sandbox:'workspace-write',approval:'ask'})},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}} as unknown as Context
 let nativeRequestId='native',valid=true
 const authorize=createExternalHarnessAuthorizer(ctx,{owner:'owner',runtimeId:'runtime',readPolicy:async()=>({allowedTools:['subagent_codex'],nativeRequestId:'native'}),readBusinessBinding:async()=>false,readInstructionWork:async()=>{throw Error('owner Run must not be treated as main')},ownerRun:async()=>({runId:'owner-run',nativeRequestId,assertCurrent(){if(!valid)throw Error('owner revoked')}}),access:{readSessionCapabilities:async()=>({schema:'teloa.session-capabilities/v1',sessionId:'parent',status:'ready',requiredCapabilities:['general-agent']}),authorizeSessionCapabilities:async()=>({assertCurrent(){}})}})
 const input={sessionId:'parent',callId:'call',provider:'codex' as const,signal:new AbortController().signal},permit=await authorize(input)
 assert.equal(permit.runId,'owner-run');assert.equal(permit.requestId,'native');valid=false;assert.throws(permit.assertCurrent,/owner revoked/)
 valid=true;nativeRequestId='different';await assert.rejects(authorize(input),/岗位与资料/)
})

type InstructionKey={requestId:string;sessionId:string;messageId:string;messageSeq:number}
function instructionFixture(){
 const session=Session.create(SessionId('parent')),agent={id:'parent',session}
 const next=(content:Parameters<typeof createUserMessage>[0]['content']=[{type:'text',text:'请用 Codex 完成原任务'}])=>{
  session.append('turn/start',{turn:session.seq} as never)
  const message=createUserMessage({source:{kind:'user'},content});session.append('user/message',message,{surfaceOp:'append'});return message
 }
 next()
 const ctx={agents:{get:()=>agent},sessions:{get:()=>session},workingDirectory:{ensure:()=>realpath(tmpdir())},permissionPresets:{current:()=>'workspace-write',resolve:()=>({sandbox:'workspace-write',approval:'ask'})},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}} as unknown as Context
 const ports={owner:'owner',runtimeId:'runtime',readPolicy:async()=>null,readBusinessBinding:async()=>false,access:{readSessionCapabilities:async()=>({schema:'teloa.session-capabilities/v1' as const,sessionId:'parent',status:'ready' as const,requiredCapabilities:['general-agent' as const]}),authorizeSessionCapabilities:async()=>({assertCurrent(){}})}}
 const input={sessionId:'parent',callId:'call',provider:'codex' as const,signal:new AbortController().signal}
 return {session,agent,next,ctx,ports,input}
}
const handed=(key:InstructionKey,stoppedAt:string|null=null)=>({ownerId:'owner',request:{...key,kind:'task' as const,executor:'general' as const,title:'原周会工作',stoppedAt},taskId:'22222222-2222-4222-8222-222222222222',runId:'33333333-3333-4333-8333-333333333333'})

test('同一已受理本人指令不能在主会话绕过原Run再次直接执行外部CLI',async()=>{
 const f=instructionFixture()
 for(const stoppedAt of [null,'2026-10-17T00:00:00Z']){
  const readInstructionWork=async(key:InstructionKey)=>handed(key,stoppedAt)
  const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1])
  await assert.rejects(authorize(f.input),(error:unknown)=>{
   const value=error as {code:string;message:string;details?:Record<string,unknown>}
   assert.equal(value.code,'teloa/conflict');assert.match(value.message,/原任务|原交办/)
   assert.equal(value.details?.reason,'instruction-already-handed-off');assert.equal(value.details?.nextTool,'teloa_work_status');assert.equal(value.details?.stoppedAt,stoppedAt)
   return true
  })
 }
})

test('未交办和不同新消息保留主会话直用CLI，带附件不被工作交办正文限制误封',async()=>{
 const f=instructionFixture();let original:InstructionKey|undefined
 const readInstructionWork=async(key:InstructionKey)=>{if(!original){original=key;return handed(key)}return key.requestId===original.requestId?handed(key):null}
 const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1])
 await assert.rejects(authorize(f.input),{code:'teloa/conflict'})
 f.next([{type:'text',text:'这是另一项独立工作，请用 Codex 核对附件'},{type:'image',attachment:{id:'image'}} as never])
 const permit=await authorize({...f.input,callId:'new-call'});assert.equal(permit.runId,null);permit.assertCurrent()
})

test('交办读口返回其他本人或非当前来源时硬拒绝，不借旧在途Task锁住新消息',async()=>{
 for(const field of ['ownerId','requestId','sessionId','messageId','messageSeq'] as const){
  const f=instructionFixture(),readInstructionWork=async(key:InstructionKey)=>{const row=handed(key);if(field==='ownerId')row.ownerId='foreign';else if(field==='messageSeq')row.request.messageSeq++;else row.request[field]='foreign';return row}
  const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1])
  await assert.rejects(authorize(f.input),{code:'teloa/forbidden'},field)
 }
 const f=instructionFixture(),authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork:async()=>null} as Parameters<typeof createExternalHarnessAuthorizer>[1])
 assert.equal((await authorize(f.input)).runId,null)
})

test('异步交办读取期间原用户指令被新消息替换，不能给旧来源签发CLI许可',async()=>{
 const f=instructionFixture();let release=()=>{}
 const readInstructionWork=async()=>{await new Promise<void>(resolve=>release=resolve);return null}
 const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1]),pending=authorize(f.input)
 await new Promise<void>(resolve=>setImmediate(resolve));f.next();release()
 await assert.rejects(pending,{code:'teloa/forbidden'})
})

test('仅预约而无真实Task或Run不冒已受理，原停止预约仍不可由同消息绕过',async()=>{
 const f=instructionFixture();let stoppedAt:string|null=null
 const readInstructionWork=async(key:InstructionKey)=>({...handed(key,stoppedAt),taskId:null,runId:null})
 const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1])
 assert.equal((await authorize(f.input)).runId,null)
 stoppedAt='2026-10-17T00:00:00Z';await assert.rejects(authorize(f.input),{code:'teloa/conflict'})
})

test('原生Codex完成通知的无新用户后继保留普通CLI能力，不猜旧消息为当前来源',async()=>{
 const f=instructionFixture();let sourceReads=0
 f.session.append('turn/start',{turn:1} as never)
 f.session.append('user/message',createUserMessage({source:{kind:'subagent-settled',form:'notice',summary:'Background child finished.',senderSessionId:SessionId('native-child')},content:[{type:'text',text:'普通完成通知'}]}),{surfaceOp:'append'})
 const readInstructionWork=async(key:InstructionKey)=>{sourceReads++;return handed(key)}
 const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork} as Parameters<typeof createExternalHarnessAuthorizer>[1]),permit=await authorize(f.input)
 assert.equal(permit.runId,null);assert.equal(sourceReads,0);permit.assertCurrent()
 f.next();assert.throws(permit.assertCurrent,{code:'teloa/forbidden'})
})

test('空轮次或多条本人指令不能伪装成预期无用户完成通知分支',async()=>{
 for(const multiple of [false,true]){
  const f=instructionFixture();f.session.append('turn/start',{turn:1} as never)
  if(multiple)for(let i=0;i<2;i++)f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'消息 '+i}]}),{surfaceOp:'append'})
  const authorize=createExternalHarnessAuthorizer(f.ctx,{...f.ports,readInstructionWork:async()=>null} as Parameters<typeof createExternalHarnessAuthorizer>[1])
  await assert.rejects(authorize(f.input),{code:'teloa/forbidden'})
 }
})
