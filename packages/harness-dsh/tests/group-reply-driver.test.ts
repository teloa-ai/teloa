import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {GroupDispatchItem,DigitalRole} from '@teloa/contract'
import {WorkError} from '@teloa/contract'
import type {GroupReplyExecution,GroupReplyExecutionService} from '@teloa/backend'
import {driveGroupReply,groupReplyPrompt,registerGroupReplyContext} from '../src/group-reply-driver.ts'
import {drainGroupRoutingOutbox,type GroupRoutingOutboxPorts} from '../src/group-routing-outbox-driver.ts'

function fixture(){
 const owner=randomUUID(),id=randomUUID(),groupId=randomUUID(),messageId=randomUUID(),nativeRequestId=randomUUID(),roleId=randomUUID()
 const role={id:roleId,ownerId:owner,name:'答疑同事',kind:'employee',version:2,scopes:['general'],duty:'解释问题',dataScope:'共享资料',executionScope:'只读',knowledge:[],skills:[],state:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as DigitalRole
 let fixed:GroupReplyExecution={id,sessionId:'group-reply-'+id,nativeRequestId,state:'prepared',inputSha256:'a'.repeat(64),snapshot:{schema:'teloa.group-reply-input/v1',ownerId:owner,groupId,groupVersion:1,grantVersion:1,messageId,rootId:messageId,contextMode:'main',role,references:[],context:{materials:[],files:[]},topic:undefined,source:{text:'你好',createdAt:new Date().toISOString(),authorId:'self'},ownerRequest:{messageId,text:'你好',sha256:'b'.repeat(64)},lineage:null}}
 const item={id,ownerId:owner,groupId,messageId,decisionVersion:1,roleId,roleVersion:2,requestId:nativeRequestId,state:'leased',taskId:null,runId:null,lineage:null,attempts:1,nextAttemptAt:new Date(Date.now()+30000).toISOString(),leaseGeneration:1} as GroupDispatchItem
 const events:any[]=[],calls={prompt:0,publish:0,cancel:0,create:0,bind:0},hooks=new Map<string,Function>()
 let drop=false,deny=false,mixed=false,failPublication=false,handles=true
 const service={handles:async()=>handles,prepare:async()=>fixed,get:async()=>fixed,authorize:async()=>{if(deny)throw new WorkError('teloa/forbidden','已撤权');return ()=>{}},submitting:async(_owner:string,_id:string,_generation:number,content:object)=>{if(fixed.state!=='prepared')return false;fixed={...fixed,...content,state:'submitting'};return true},observe:async(_owner:string,_id:string,value:object)=>{fixed={...fixed,...value};return fixed},publish:async()=>{calls.publish++;if(failPublication){failPublication=false;throw Error('publication temporarily unavailable')}fixed={...fixed,resultMessageId:fixed.resultMessageId??randomUUID()};return {}},block:async(_owner:string,_id:string,reason:string)=>{fixed={...fixed,state:fixed.state==='ended'?'ended':'withdrawn',reason}}} as unknown as GroupReplyExecutionService
 const session={id:fixed.sessionId,snapshotEvents:()=>events},agent={session}
 const ctx={on:(name:string,fn:Function)=>{hooks.set(name,fn);return ()=>{}},agents:{get:()=>agent},attachments:{admitPromptContent:async(content:unknown)=>content},agentPresets:{resolve:async()=>({id:'standard'})},sessionController:{create:async()=>{calls.create++;return {sessionId:fixed.sessionId,agentPreset:'standard'}},inspect:async()=>({meta:{id:fixed.sessionId,agentPreset:'standard'},events}),prompt:async(request:any)=>{calls.prompt++;assert.equal(request.sessionId,fixed.sessionId);assert.equal(request.requestId,nativeRequestId);if(drop)throw Error('accepted response unknown');fixed={...fixed,nativeMessageId:'native-message'};events.push({seq:0,type:'turn/start',data:{turn:0}},{seq:1,type:'user/message',surfaceOp:'append',data:{id:'native-message',source:{kind:'user',rpcId:nativeRequestId},content:request.content}});if(mixed)events.push({seq:events.length,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'foreign'}]}});events.push({seq:events.length,type:'assistant/message',surfaceOp:'append',data:{turn:0,message:{content:[{type:'text',text:'你好，我来解释。'}]}}});events.push({seq:events.length,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}})},cancel:async()=>{calls.cancel++}}} as unknown as Context
 const ports={service,displayName:async()=>'用户',bind:async()=>{calls.bind++;await service.authorize(owner,id);return ()=>{}}}
 return {owner,item,ctx,ports,service,calls,hooks,events,fixed:()=>fixed,drop:()=>{drop=true},deny:()=>{deny=true},mixed:()=>{mixed=true},failPublication:()=>{failPublication=true},work:()=>{handles=false}}
}
test('普通回复使用固定原生session和一次prompt，不建Task/Run；完成后只补原发布',async()=>{
 const f=fixture();assert.equal(await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000)),true)
 assert.equal(f.calls.prompt,1);assert.equal(f.fixed().state,'ended');assert.ok(f.fixed().resultMessageId);assert.equal(f.item.taskId,null);assert.equal(f.item.runId,null)
 await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000));assert.equal(f.calls.prompt,1)
})
test('未知受理即使没有日志也不再次prompt，重入只核对原session/request',async()=>{
 const f=fixture();f.drop();await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000))
 assert.equal(f.fixed().state,'unknown');await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000));assert.equal(f.calls.prompt,1);assert.equal(f.calls.publish,0)
})
test('原生完成后发布失败保留原文，下次只发布，不重复模型输入',async()=>{
 const f=fixture();f.failPublication();await assert.rejects(()=>driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000)))
 assert.equal(f.fixed().state,'ended');assert.equal(f.fixed().text,'你好，我来解释。')
 await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000));assert.equal(f.calls.prompt,1);assert.ok(f.fixed().resultMessageId)
})
test('岗位或群撤权时取消原生工作，拒绝发布；串轮证据也拒绝发布',async()=>{
 const denied=fixture();denied.deny();await driveGroupReply(denied.ctx,denied.owner,denied.item,denied.ports,AbortSignal.timeout(1000))
 assert.equal(denied.calls.prompt,0);assert.equal(denied.calls.cancel,1);assert.equal(denied.fixed().state,'withdrawn')
 const mixed=fixture();mixed.mixed();await driveGroupReply(mixed.ctx,mixed.owner,mixed.item,mixed.ports,AbortSignal.timeout(1000));assert.equal(mixed.calls.publish,0);assert.equal(mixed.fixed().state,'configuration_failed')
})
test('outbox reply完成后不进入createTask/prepare/start；work继续原分支',async()=>{
 const f=fixture(),workCalls:string[]=[]
 const ports={outbox:{pending:async()=>[f.item],claim:async()=>f.item},reply:async()=>true,createTask:async()=>{workCalls.push('task');throw Error('unexpected Task')},prepare:async()=>{throw Error('unexpected TaskRun')},start:async()=>{throw Error('unexpected start')},report:()=>{}} as unknown as GroupRoutingOutboxPorts
 await drainGroupRoutingOutbox(f.owner,ports,AbortSignal.timeout(1000));assert.deepEqual(workCalls,[])
 f.work();assert.equal(await driveGroupReply(f.ctx,f.owner,f.item,f.ports,AbortSignal.timeout(1000)),false);assert.equal(f.calls.prompt,0)
})
test('群回复上下文只使用冻结职责，系统提示工具面清空并去掉team策略',async()=>{
 const f=fixture();registerGroupReplyContext(f.ctx,()=>f.service,f.owner)
 const base={tools:[{name:'shell'}],sections:[{name:'team:policy',text:'delegate'}]},result=await f.hooks.get('system-prompt/assemble')!({}, {agent:{session:{id:f.fixed().sessionId}}},async()=>base)
 assert.deepEqual(result.tools,[]);assert.ok(!result.sections.some((s:any)=>s.name==='team:policy'));assert.ok(result.sections.some((s:any)=>s.name==='teloa:group-reply-role'&&s.text.includes('解释问题')))
 const first=groupReplyPrompt(f.fixed()),sorted=JSON.parse(first);assert.equal(groupReplyPrompt({...f.fixed(),snapshot:JSON.parse(JSON.stringify(f.fixed().snapshot))}),first);assert.equal(sorted.schema,'teloa.group-reply-input/v1')
})
