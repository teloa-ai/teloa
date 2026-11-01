import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {DirectDeviceStore,DirectDeviceCapture,DirectDeviceBinding} from '@teloa/backend'
import type {HardwareReceipt,TranscriptCommit} from '@teloa/contract'
import type {DeviceSink,createDeviceAudioCapture} from '@teloa/device-gateway'
import {createDirectDeviceHost,splitDeviceSpeech} from '../src/direct-device-host.ts'
import {createDeviceMediaOwner} from '../src/device-media-owner.ts'
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('长回复按句和240码点上限播报，全部字幕与正文保持一致',()=>{
 const text='😀'.repeat(500)+'。下一句。',parts=splitDeviceSpeech(text)
 assert.equal(parts.join(''),text);assert.ok(parts.every(part=>Array.from(part).length<=240));assert.equal(parts.length,4)
})
async function fixture(options:{asr?:()=>Promise<void>;dispatch?:()=>Promise<void>;replyText?:string;onPlayed?:()=>void;readState?:()=>HardwareReceipt['state']}={}){
 const binding:DirectDeviceBinding={id:randomUUID(),ownerId:'owner',installationId:randomUUID(),assistantSessionId:randomUUID(),contextVersion:1,credentialDigest:hash('secret'),grantVersion:1,status:'active'}
 const captures=new Map<string,DirectDeviceCapture>(),prompts:TranscriptCommit[]=[],controls:unknown[]=[],plays:string[]=[]
 let sealed:Parameters<typeof createDeviceAudioCapture>[0]['onSealed']|undefined,revoked=false,reads=0
 const store={
  authorize:async(digest:string)=>digest===binding.credentialDigest&&!revoked?binding:null,
  reserve:async(_id:string,captureId:string)=>{const old=captures.get(captureId);if(old)return {created:false,record:old};const record:DirectDeviceCapture={id:captureId,bindingId:binding.id,grantVersion:1,nativeRequestId:randomUUID(),text:'',textDigest:hash(''),state:'reserved',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),resultRef:null};captures.set(captureId,record);return {created:true,record}},
  get:async(_id:string,id:string)=>captures.get(id)??null,
  transcribed:async(_id:string,id:string,text:string)=>{captures.set(id,{...captures.get(id)!,text,textDigest:hash(text),state:'transcribed'})},
  claim:async(_id:string,id:string)=>{const row=captures.get(id)!;if(row.state!=='transcribed')return false;captures.set(id,{...row,state:'dispatching'});return true},
  receipt:async(_id:string,id:string,state:DirectDeviceCapture['state'])=>{const row=captures.get(id)!;if(row.state!=='accepted')captures.set(id,{...row,state})},
  revoke:async()=>{revoked=true},
 } as unknown as DirectDeviceStore
 const owner=createDeviceMediaOwner(),host=createDirectDeviceHost({store,mediaOwner:owner,modelPath:'unused-in-fixture',configured:async()=>true,verify:async()=>()=>{},remember:()=>{},
  speech:{transcribe:async(wav)=>{await options.asr?.();return {text:'用一句话介绍你自己。',audioSha256:hash(wav),receiptId:randomUUID(),providerId:'sensevoice-local'}},speak:async(_text,_signal,onAudio)=>{await onAudio(Uint8Array.of(1,2,3))}},
  dispatch:async(commit,check)=>{check();prompts.push(commit);await options.dispatch?.();return {}},
  read:async op=>{reads++;return {operationId:op.id,state:options.readState?.()??'completed',speakableText:options.replyText??'我是小罗同学。',resultRef:{nativeRequestId:op.nativeRequestId,messageId:randomUUID(),endSeq:10}} as HardwareReceipt},
  capture:async ports=>{sealed=ports.onSealed;return {push:async()=>{},stop:async()=>{},abort(){},close:async()=>{}}},
  packets:async function*(source,signal){for await(const bytes of source){signal.throwIfAborted();yield bytes}},
 })
 const authorization=await host.authorize('secret',new AbortController().signal);assert.ok(authorization)
 const life=new AbortController(),sink:DeviceSink={control:value=>controls.push(value),sealed:()=>{},discarded:()=>{},play:async input=>{for await(const _ of input.packets(life.signal)){};plays.push(input.text);options.onPlayed?.()}}
 const media=await host.media(authorization,sink,life.signal),captureId=randomUUID()
 const seal=()=>sealed!({captureId,wav:Buffer.from([82,73,70,70]),reason:'manual',durationMs:1000,speechDurationMs:800,segmented:false})
 return {binding,host,media,owner,authorization,life,captureId,seal,prompts,captures,controls,plays,reads:()=>reads}
}
test('可信封口转写进入固定原会话，一次派发后完整结果自动播报，重发只读原请求',async()=>{
 const f=await fixture();await f.media.start(f.captureId,f.life.signal);f.seal()
 for(let i=0;i<20&&!f.plays.length;i++)await tick()
 assert.equal(f.prompts.length,1);assert.equal(f.prompts[0]!.sessionId,f.binding.assistantSessionId)
 assert.equal(f.prompts[0]!.source.kind,'sealed-audio-stt');assert.equal(f.prompts[0]!.text,'用一句话介绍你自己。')
 assert.deepEqual(f.plays,['我是小罗同学。'])
 await assert.rejects(f.media.start(f.captureId,f.life.signal))
 await f.media.status(f.captureId);assert.equal(f.prompts.length,1)
 await f.media.repeat(f.captureId);assert.equal(f.plays.length,2)
 await f.media.close();await f.host.close()
})
test('网页占用不被设备抢占；迟到 ASR 撤权后不能进入原会话',async()=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve}),f=await fixture({asr:()=>blocked})
 const web=f.owner.acquire('web');await assert.rejects(f.media.start(f.captureId,f.life.signal));web.release()
 await f.media.start(f.captureId,f.life.signal);f.seal();await tick()
 await f.host.revoke(f.binding.id);release();await tick();await tick()
 assert.equal(f.authorization.signal.aborted,true);assert.equal(f.prompts.length,0);assert.equal(f.plays.length,0)
 await f.media.close();await f.host.close()
})
test('已进入原会话后断线只停止播报，不重派或取消原工作',async()=>{
 let release!:()=>void;const work=new Promise<void>(resolve=>{release=resolve}),f=await fixture({dispatch:()=>work})
 await f.media.start(f.captureId,f.life.signal);f.seal();await tick()
 assert.equal(f.prompts.length,1);f.life.abort();await f.media.close();release();await tick();await tick()
 assert.equal(f.prompts.length,1);assert.equal(f.captures.get(f.captureId)!.state,'accepted');assert.equal(f.plays.length,0)
 await f.host.close()
})
test('长结果逐段播放，取消第一段后不启动下一段 TTS',async()=>{
 let stop=()=>{}
 const f=await fixture({replyText:'甲'.repeat(241)+'。',onPlayed:()=>stop()});stop=()=>f.life.abort()
 await f.media.start(f.captureId,f.life.signal);f.seal();for(let i=0;i<20&&!f.plays.length;i++)await tick()
 assert.equal(f.plays.length,1);assert.equal(Array.from(f.plays[0]!).length,240)
 await f.media.close();await f.host.close()
})
test('长任务立即下发 pending，结果尚未完成时不播报接手前言',async()=>{
 let state:HardwareReceipt['state']='pending'
 const f=await fixture({readState:()=>state});await f.media.start(f.captureId,f.life.signal);f.seal();for(let i=0;i<20&&!f.controls.length;i++)await tick();await tick()
 assert.ok(f.controls.some(value=>(value as {state?:string}).state==='pending'));assert.equal(f.plays.length,0)
 state='completed';await new Promise(resolve=>setTimeout(resolve,300));assert.equal(f.plays.length,1)
 await f.media.close();await f.host.close()
})


test('原审批等待只提示一次；决定后继续查询并播报最终结果',async()=>{
 let state:HardwareReceipt['state']='needs_approval'
 const f=await fixture({readState:()=>state});await f.media.start(f.captureId,f.life.signal);f.seal()
 for(let i=0;i<20&&!f.plays.length;i++)await tick()
 assert.equal(f.plays.length,1);await new Promise(resolve=>setTimeout(resolve,280));assert.equal(f.plays.length,1)
 state='completed';await new Promise(resolve=>setTimeout(resolve,280));assert.equal(f.plays.length,2);assert.equal(f.prompts.length,1)
 await f.media.close();await f.host.close()
})

test('E06：正式直连状态 RPC 仅向本人浏览器投影本安装安全字段，停用不丢历史',{timeout:180000},async t=>{
 const {mkdir,mkdtemp,rm,writeFile}=await import('node:fs/promises'),{join}=await import('node:path')
 const {PostgreSqlContainer}=await import('@testcontainers/postgresql')
 const {openResourceDatabase,createDirectDeviceStore}=await import('@teloa/backend')
 const {host}=await import('./fixtures/production-host.ts'),{apply}=await import('../src/index.ts')
 const {readAssistantChannelInstallation}=await import('../src/assistant-channel-host.ts')
 const root=await mkdtemp(join(process.cwd(),'.tmp-direct-status-')),runtime=host({agents:true}),previousRoot=process.env.TELOA_PROJECT_ROOT
 let container:Awaited<ReturnType<InstanceType<typeof PostgreSqlContainer>['start']>>|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{await runtime.ctx.fiber.dispose();await database?.close();await container?.stop();if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot;await rm(root,{recursive:true,force:true})})
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const runtimeRoot=join(root,'.runtime/teloa'),config=join(runtimeRoot,'database.json'),owner='local:teloa-owner'
 await mkdir(join(runtimeRoot,'skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 const installationId=await readAssistantChannelInstallation(database.pool,owner,runtimeRoot);assert.ok(installationId)
 const store=createDirectDeviceStore(database.pool,{ownerId:owner,installationId});await store.initialize()
 const active=await store.register({id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:3,credentialDigest:hash('synthetic-direct-active-secret'),allowApprovals:true})
 const revoked=await store.register({id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:2,credentialDigest:hash('synthetic-direct-revoked-secret')});await store.revoke(revoked.id)
 for(const identity of [{ownerId:'other-owner',installationId},{ownerId:owner,installationId:randomUUID()}])await createDirectDeviceStore(database.pool,identity).register({id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:1,credentialDigest:hash(randomUUID())})
 await runtime.ready(join(root,'.runtime/dsh'));await apply(runtime.ctx,{projectRoot:root})
 const browserPeer={id:'synthetic-browser-peer'};Reflect.set(runtime.ctx.connection,'browserPeer',browserPeer)
 const rpc=runtime.rpc as (endpoint:string,payload:unknown,signal:AbortSignal,peer?:unknown)=>ReturnType<typeof runtime.rpc>
 const read=(payload:unknown={},peer:unknown=browserPeer,signal=new AbortController().signal)=>rpc('devices/direct/status',payload,signal,peer)
 const before=await store.list(),reply=await read()
 assert.equal(reply.ok,true,JSON.stringify(reply))
 const value=reply.value as {enabled:boolean;devices:Array<Record<string,unknown>>;helper:unknown}
 assert.equal(value.enabled,false);assert.equal(value.helper,null)
 assert.deepEqual(value.devices.sort((a,b)=>String(a.id).localeCompare(String(b.id))),[
  {id:active.id,status:'active',grantVersion:1,assistantSessionId:active.assistantSessionId,allowApprovals:true},
  {id:revoked.id,status:'revoked',grantVersion:2,assistantSessionId:revoked.assistantSessionId,allowApprovals:false},
 ].sort((a,b)=>a.id.localeCompare(b.id)))
 for(const secret of [installationId,active.credentialDigest,revoked.credentialDigest])assert.equal(JSON.stringify(reply).includes(secret),false)
 assert.doesNotMatch(JSON.stringify(reply),/credentialDigest|ownerId|installationId|contextVersion/)
 for(const payload of [{ownerId:owner},{bindingId:active.id},{secret:'synthetic-extra'}])assert.equal((await read(payload)).error?.code,'teloa/invalid-input')
 assert.equal((await read({},{})).error?.code,'teloa/forbidden')
 assert.equal((await read({},browserPeer,AbortSignal.abort())).ok,false)
 assert.deepEqual(await store.list(),before);assert.deepEqual(runtime.modelCalls,[])
})
