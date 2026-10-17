import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type DigitalRole} from '@teloa/contract'
import type {WorkAccessLease} from '@teloa/backend'
import type {VoiceTransportConnectInput,VoiceConnection} from '../src/voice-transport.ts'

let feature:Record<string,any>={}
try{feature=await import('../src/voice-call-runtime.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error}
const owner='voice-runtime-owner',roleId='20000000-0000-4000-8000-000000000001',requestId='10000000-0000-4000-8000-000000000001',time='2026-10-09T00:00:00.000Z'
const input={requestId,roleId,expectedRoleVersion:2,sessionId:'role-session'}
const role:DigitalRole={id:roleId,ownerId:owner,version:2,kind:'employee',state:'active',name:'研究同事',scopes:['research'],duty:'研究',dataScope:'研究资料',executionScope:'研究任务',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},createdAt:time,updatedAt:time}
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
function fixture(){
 const invalidation=new AbortController(),calls:unknown[][]=[]
 let media:VoiceTransportConnectInput|undefined,closes=0,releases=0,proofReleases=0,mediaAllowed=true
 const conversation={id:'conversation',ownerId:owner,sessionId:input.sessionId,status:'ready' as const}
 const link={kind:'role' as const,objectId:roleId,objectVersion:2,conversationId:conversation.id,sessionId:input.sessionId,version:1,active:true,updatedAt:time,scopeId:'research'}
 const connection:VoiceConnection={async close(){closes++},async interruptPlayback(){}}
 const ports={owner,
  async readRole(id:string){calls.push(['role',id]);return role},async readConversation(id:string){calls.push(['conversation',id]);return conversation},async readRequestedRoleId(){return roleId},
  links:{async bySession(actor:string,query:{sessionId:string}){calls.push(['links',actor,query]);return [link]}},
  acquireContextLease(request:unknown){calls.push(['lease',request]);return {signal:invalidation.signal,assertCurrent(){invalidation.signal.throwIfAborted()},release(){releases++}}},
  async authorizeMedia(request:unknown):Promise<WorkAccessLease>{calls.push(['media-permit',request]);return {assertCurrent(){if(!mediaAllowed)throw new WorkError('teloa/forbidden','实际媒体许可已撤销。')},releaseUnaccepted(){proofReleases++}}},
  transport:{async readiness(){return {status:'ready' as const,providerId:'voice-relay'}},async connect(value:VoiceTransportConnectInput){media=value;return connection}},async readTranscriptSeal(){return null},
 }
 return {ports,calls,connection,invalidation,denyMedia(){mediaAllowed=false},get media(){return media},get closes(){return closes},get releases(){return releases},get proofReleases(){return proofReleases}}
}

test('个人助手只用本人原general/null会话，同一call生命周期不借角色关联',async()=>{
 const f=fixture(),assistant={requestId,sessionId:input.sessionId,target:'assistant',expectedContextVersion:3}
 const ports={...f.ports,readHomeContext:async()=>({sessionId:input.sessionId,scopeId:'general',roleId:null,version:3}),assistantEligible:async()=>true,readRequestedRoleId:async()=>null,links:{bySession:async()=>[]},readRole:async()=>{throw Error('个人助手不能读员工身份')}}
 const runtime=feature.createVoiceCallRuntime(ports),call=await runtime.handler('voice-calls/start',assistant)
 assert.equal(call.target,'assistant');assert.equal(call.contextVersion,3);assert.equal(call.scope,'general');assert.equal('roleId'in call,false)
 assert.equal((await runtime.handler('voice-calls/get-by-request',{requestId})).id,call.id)
 assert.equal((await runtime.handler('voice-calls/end-by-request',{requestId})).call.id,call.id)
 await runtime.dispose();assert.equal(f.closes,1)
})
test('助手跨本人、受控会话、非general/null、过期上下文及读取未知均不开媒体',async()=>{
 for(const failure of ['owner','purpose','eligibility','scope','role','version','unknown'] as const){
  const f=fixture(),assistant={requestId,sessionId:input.sessionId,target:'assistant',expectedContextVersion:3}
  const runtime=feature.createVoiceCallRuntime({...f.ports,readConversation:async()=>({id:'owned',ownerId:failure==='owner'?'other':owner,sessionId:input.sessionId,status:'ready',...(failure==='purpose'?{purpose:'task-run'}:{})}),readHomeContext:async()=>{if(failure==='unknown')throw Error('unknown');return {sessionId:input.sessionId,scopeId:failure==='scope'?'research':'general',roleId:failure==='role'?roleId:null,version:failure==='version'?4:3}},assistantEligible:async()=>failure!=='eligibility',readRequestedRoleId:async()=>null,links:{bySession:async()=>[]}})
  await assert.rejects(runtime.handler('voice-calls/start',assistant));assert.equal(f.media,undefined);await runtime.dispose()
 }
})

test('装配固定本人原角色会话与范围，纯交流不新增执行权或向媒体发送业务资料',async()=>{
 assert.equal(typeof feature.createVoiceCallRuntime,'function','宿主通话装配尚未实现')
 const f=fixture(),runtime=feature.createVoiceCallRuntime(f.ports)
 const call=await runtime.handler('voice-calls/start',input)
 assert.equal(call.state,'connected');assert.equal(call.scope,'research');assert.equal(call.roleVersion,2)
 assert.equal(f.calls[0]?.[0],'lease','可信当前句柄必须在异步读口之前捕获')
 assert.deepEqual(f.calls[1],['media-permit',input],'媒体许可必须在其它异步回读之前获取')
 assert.equal(f.calls.some(row=>row[0]==='eligibility'||row[0]==='execution'),false)
 assert.deepEqual(f.media?.roleContext,{ownerId:owner,roleId,roleKind:'employee',roleVersion:2,sessionId:input.sessionId,scope:'research'})
 await assert.rejects(runtime.service.start('other',input),{code:'teloa/forbidden'})
 f.denyMedia()
 await assert.rejects(runtime.service.setMuted(owner,{callId:call.id,callGeneration:call.callGeneration,muted:true}),{code:'teloa/forbidden'})
 await runtime.dispose();assert.equal(f.closes,1);assert.equal(f.releases,1);assert.equal(f.proofReleases,1)
})

test('本人或会话版本范围无法核对时不打开媒体，无执行同意的分身仍可交流',async()=>{
 assert.equal(typeof feature.createVoiceCallRuntime,'function')
 const foreign=fixture();foreign.ports.readConversation=async()=>({id:'conversation',ownerId:'other',sessionId:input.sessionId,status:'ready'})
 const a=feature.createVoiceCallRuntime(foreign.ports)
 await assert.rejects(a.handler('voice-calls/start',input),{code:'teloa/forbidden'});assert.equal(foreign.media,undefined);assert.equal(foreign.releases,1);assert.equal(foreign.proofReleases,1)
 const stale=fixture(),original=stale.ports.links.bySession
 stale.ports.links.bySession=async(actor,query)=>(await original(actor,query)).map(link=>({...link,objectVersion:1,scopeId:'private'}))
 const b=feature.createVoiceCallRuntime(stale.ports)
 await assert.rejects(b.handler('voice-calls/start',input),{code:'teloa/version-conflict'});assert.equal(stale.media,undefined)
 const twin=fixture();twin.ports.readRole=async()=>({...role,kind:'twin',state:'paused'})
 const c=feature.createVoiceCallRuntime(twin.ports),call=await c.handler('voice-calls/start',input)
 assert.equal(call.state,'connected');assert.equal(call.roleKind,'twin');await c.dispose()
})

test('角色或consent撤销主动关闭本人媒体，迟到连接不能复活且没有Task stop端口',async()=>{
 assert.equal(typeof feature.createVoiceCallRuntime,'function')
 const f=fixture(),entered=deferred<void>(),late=deferred<VoiceConnection>()
 f.ports.transport.connect=async value=>{Object.assign(f.ports,{_media:value});entered.resolve();return late.promise}
 const runtime=feature.createVoiceCallRuntime(f.ports),pending=runtime.handler('voice-calls/start',input)
 await entered.promise
 f.invalidation.abort(new WorkError('teloa/forbidden','角色或本人执行同意已撤销。'))
 const preparing=runtime.service.getByRequest(owner,{requestId})
 assert.equal(preparing.state,'failed');assert.equal(preparing.failure,'authorization-changed')
 let disposed=false
 const disposing=runtime.dispose().then(()=>{disposed=true})
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(disposed,false,'宿主释放必须等迟到连接真实关闭')
 late.resolve(f.connection);const ended=await pending
 await disposing
 assert.equal(ended.state,'failed');assert.equal(f.closes,1);assert.equal(f.releases,1)
 await runtime.handler('voice-calls/end',{callId:ended.id},AbortSignal.abort())
 assert.equal(f.closes,1);await runtime.dispose()
 const live=fixture(),second=feature.createVoiceCallRuntime(live.ports),call=await second.handler('voice-calls/start',input)
 live.invalidation.abort()
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(second.service.get(owner,{callId:call.id}).failure,'authorization-changed');assert.equal(live.closes,1)
 await second.dispose()
 const granting=fixture(),proof=deferred<WorkAccessLease>()
 let permitRequested=false,lateProofReleases=0
 granting.ports.authorizeMedia=async request=>{permitRequested=true;granting.calls.push(['media-permit',request]);return proof.promise}
 const waiting=feature.createVoiceCallRuntime(granting.ports),start=waiting.handler('voice-calls/start',input)
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(permitRequested,true)
 const rejected=assert.rejects(start,{code:'teloa/forbidden'})
 granting.invalidation.abort();proof.resolve({assertCurrent(){},releaseUnaccepted(){lateProofReleases++}})
 await rejected
 assert.equal(granting.calls.some(row=>row[0]==='conversation'),false);assert.equal(granting.media,undefined)
 assert.equal(lateProofReleases,1);assert.equal(granting.releases,1);await waiting.dispose();assert.equal(lateProofReleases,1)
})

test('connecting 挂断必须转交真实媒体 closePending，并等待浏览器确认',async()=>{
 const {createBrowserVoiceMedia}=await import('../src/browser-voice-media.ts')
 const f=fixture(),media=createBrowserVoiceMedia({configured:async()=>true,speech:{async transcribe(){return null},async speak(){}}})
 const runtime=feature.createVoiceCallRuntime({...f.ports,transport:media.transport})
 const pending=runtime.handler('voice-calls/start',input)
 let call:any,snapshot:any
 for(let n=0;n<30;n++){
  call=runtime.service.getByRequest(owner,{requestId})
  if(call){snapshot=media.snapshot({callId:call.id,callGeneration:call.callGeneration});if(snapshot)break}
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 assert.ok(snapshot);let closed=false
 const ending=runtime.handler('voice-calls/end-by-request',{requestId}).then(()=>{closed=true})
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false)
 media.closed({callId:call.id,callGeneration:call.callGeneration,token:snapshot.token})
 await ending;await pending;assert.equal(closed,true)
 await runtime.dispose();media.dispose()
})
