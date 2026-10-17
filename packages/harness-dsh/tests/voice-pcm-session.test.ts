import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createVoiceService} from '../src/voice-service.ts'
import {createVoiceServiceConfig} from '../src/voice-service-config.ts'

test('MiniMax 通话提前建立专属 PCM 会话，同一音色复用连接，改音色后重建并关闭旧会话',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-pcm-session-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const connections:{voice:{model:string;voiceId:string};closed:boolean;texts:string[]}[]=[]
 const config=createVoiceServiceConfig(join(dir,'voice.json'))
 const service=createVoiceService({config,secure:()=>true,credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=> 'unit-test-secret'},openMiniMaxPcmSession:async input=>{
  assert.equal(await input.key(),'unit-test-secret')
  const row={voice:input.voice,closed:false,texts:[] as string[]};connections.push(row)
  return {async synthesize(text,_signal,onAudio){row.texts.push(text);await onAudio(Uint8Array.from([1,0]))},async cancel(){},async close(){row.closed=true}}
 }})
 const parent=new AbortController(),session=await service.openPcmSession(parent.signal)
 assert.ok(session);assert.equal(connections.length,1,'在模型回答前握手预热')
 await session.synthesize('第一句。',parent.signal,()=>{});await session.synthesize('第二句。',parent.signal,()=>{})
 assert.equal(connections.length,1)
 assert.deepEqual(connections[0]!.texts,['第一句。','第二句。'])
 await config.update(current=>({...current,providers:{...current.providers,minimax:{...current.providers.minimax,voiceId:'other-voice'}}}))
 await session.synthesize('第三句。',parent.signal,()=>{})
 assert.equal(connections.length,2);assert.equal(connections[0]!.closed,true);assert.equal(connections[1]!.voice.voiceId,'other-voice')
 await session.close();await session.close();assert.equal(connections[1]!.closed,true)
 await assert.rejects(session.synthesize('已挂断。',parent.signal,()=>{}))
})

test('取消通话会关闭预热会话；模型工作信号和凭据不经 PCM 会话暴露',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-pcm-abort-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let closed=0,mediaSignal:AbortSignal|undefined
 const service=createVoiceService({config:createVoiceServiceConfig(join(dir,'voice.json')),secure:()=>true,credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=> 'unit-test-secret'},openMiniMaxPcmSession:async input=>{
  mediaSignal=input.signal
  return {async synthesize(){},async cancel(){},async close(){closed++}}
 }})
 const parent=new AbortController(),session=await service.openPcmSession(parent.signal)
 assert.ok(session);assert.deepEqual(Object.keys(session).sort(),['cancel','close','synthesize'])
 parent.abort();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(mediaSignal?.aborted,true);assert.equal(closed,1)
 await assert.rejects(session.synthesize('迟到。',new AbortController().signal,()=>{}))
})

test('音色变更期间重叠准备只创建一条新连接，迟到调用固定使用其准备快照',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-pcm-race-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const config=createVoiceServiceConfig(join(dir,'voice.json')),rows:{voiceId:string;closed:boolean;texts:string[]}[]=[]
 let hold=false,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 t.after(release)
 const service=createVoiceService({config,secure:()=>true,credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=> 'unit-test-secret'},openMiniMaxPcmSession:async input=>{
  const row={voiceId:input.voice.voiceId,closed:false,texts:[] as string[]};rows.push(row)
  if(hold)await gate
  return {async synthesize(text){row.texts.push(text)},async cancel(){},async close(){row.closed=true}}
 }})
 const parent=new AbortController(),session=await service.openPcmSession(parent.signal)
 assert.ok(session);t.after(()=>session.close())
 await config.update(current=>({...current,providers:{...current.providers,minimax:{...current.providers.minimax,voiceId:'changed-voice'}}}));hold=true
 const first=session.synthesize('前句。',parent.signal,()=>{}),second=session.synthesize('后句。',parent.signal,()=>{})
 await new Promise(resolve=>setTimeout(resolve,20));release();await Promise.all([first,second])
 assert.equal(rows.length,2,'重叠准备不能建出多条连接并覆盖当前引用')
 assert.equal(rows[0]!.closed,true);assert.deepEqual(rows[1]!.texts,['前句。','后句。'])
})

test('同模型音色下凭据轮换也重建连接，下一句不继续消耗旧账户',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-pcm-key-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let key='unit-test-key-first'
 const rows:{key:string|undefined;closed:boolean}[]=[]
 const service=createVoiceService({config:createVoiceServiceConfig(join(dir,'voice.json')),secure:()=>true,credentials:{describe:async()=>({configured:true,writable:true}),set:async(_id,value)=>{key=value},resolve:async()=>key},openMiniMaxPcmSession:async input=>{
  const row={key:await input.key(),closed:false};rows.push(row)
  return {async synthesize(){},async cancel(){},async close(){row.closed=true}}
 }})
 const parent=new AbortController(),session=await service.openPcmSession(parent.signal)
 assert.ok(session);t.after(()=>session.close())
 key='unit-test-key-rotated'
 await session.synthesize('新凭据。',parent.signal,()=>{})
 assert.equal(rows.length,2);assert.equal(rows[0]!.closed,true);assert.equal(rows[1]!.key,key)
})
