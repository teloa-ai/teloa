import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { nativeArtifactMessages,createNativeArtifactApi } from '../src/client/native-artifact-api.ts'
const message=(id:string,content:unknown[],source={kind:'user'})=>({id,role:'user',source,content})
const event=(seq:number,type:string,data:unknown,surfaceOp:unknown='append')=>({type:'event',event:{seq,type,data,time:1000,surfaceOp}})
const entries=[
  event(1,'user/message',message('user',[{type:'text',text:'正文 @file.txt'},{type:'image',attachment:{attachmentId:'sha256:a',mediaType:'image/png',width:1,height:1,bytes:10}}])),
  event(2,'user/message',message('plugin',[{type:'text',text:'插件隐私正文'}],{kind:'plugin'})),
  event(3,'assistant/message',{message:message('answer',[{type:'reasoning',text:'私有推理'},{type:'text',text:'可选回答'},{type:'tool-call',arguments:'敏感参数'}]),turn:1,step:1,interrupted:true}),
  event(4,'assistant/message',{message:message('replacement',[{type:'text',text:'压缩副本'}]),turn:1,step:1},{op:'replace',from:1,to:3}),
  {type:'chunks',event:{seq:5}},
] as unknown as SessionEventLikeEntry[]
test('选择器只投影原始可见用户及模型消息，不带入推理、工具、插件或压缩替代副本',()=>{
  const rows=nativeArtifactMessages('s1',entries)
  assert.deepEqual(rows.map(item=>item.messageId),['user','answer'])
  assert.equal(rows[0]!.images[0]!.blockIndex,1)
  assert.equal(rows[1]!.interrupted,true);assert.equal(rows[1]!.omittedBlocks,2)
  assert.doesNotMatch(JSON.stringify(rows),/私有推理|敏感参数|插件隐私正文|压缩副本/)
  rows[0]!.images[0]!.attachment.bytes=99
  assert.equal(nativeArtifactMessages('s1',entries)[0]!.images[0]!.attachment.bytes,10)
})
test('旧消息分页沿原生窗口向前加载，读取中切换会话时拒绝回传',async()=>{
  let active=true,loaded=false,resolve:()=>void=()=>{}
  const binding={eventSource:{getSnapshot:()=>({entries:loaded?entries:[],hasMore:!loaded})},session:{getSnapshot:()=>({openState:'open',removed:false}),loadOlder:()=>new Promise<void>(done=>{resolve=()=>{loaded=true;done()}})}} as unknown as SessionBinding
  const api=createNativeArtifactApi({binding:()=>{if(!active)throw Error('会话已切换');return binding},imageUrl:async()=> 'blob:real-native'})
  const pending=api.read('s1');active=false;resolve()
  await assert.rejects(pending,/切换/)
  active=true
  const page=await api.read('s1');assert.deepEqual(page.items.map(item=>item.messageId),['answer','user']);assert.equal(page.nextBeforeSeq,null)
})
test('图片读取在异步返回后重新核对会话，不能把旧 URL 交给新会话',async()=>{
  let active=true,finish:(value:string)=>void=()=>{}
  const binding={session:{getSnapshot:()=>({openState:'open',removed:false})}} as unknown as SessionBinding
  const api=createNativeArtifactApi({binding:()=>{if(!active)throw Error('会话已切换');return binding},imageUrl:()=>new Promise<string>(resolve=>{finish=resolve})})
  const row=nativeArtifactMessages('s1',entries)[0]!,pending=api.imageUrl(row,row.images[0]!)
  active=false;finish('blob:old')
  await assert.rejects(pending,/切换/)
})
test('DSH 较早历史加载失败但 Promise 正常结束时，选择器明确报错而非空页成功',async()=>{
  const binding={eventSource:{getSnapshot:()=>({entries:[],hasMore:true})},session:{getSnapshot:()=>({openState:'open',removed:false,loadingOlder:false}),loadOlder:async()=>{}}} as unknown as SessionBinding
  const api=createNativeArtifactApi({binding:()=>binding,imageUrl:async()=>''})
  await assert.rejects(api.read('s1',8),/未能加载|重试/)
})

test('第一次打开来源时等待原生 open，期间切换绑定则拒绝旧结果',async()=>{
 let opened=false,finish:()=>void=()=>{},active=true
 const binding={eventSource:{getSnapshot:()=>({entries,hasMore:false})},session:{getSnapshot:()=>({openState:opened?'open':'opening',removed:false})}} as unknown as SessionBinding
 const api=createNativeArtifactApi({binding:()=>{if(!active)throw Error('会话已切换');return binding},ready:()=>new Promise<void>(resolve=>{finish=()=>{opened=true;resolve()}}),imageUrl:async()=>''})
 const pending=api.read('s1');finish()
 assert.equal((await pending).items.length,2)
 opened=false
 const changed=api.read('s1');active=false;finish()
 await assert.rejects(changed,/切换/)
})
