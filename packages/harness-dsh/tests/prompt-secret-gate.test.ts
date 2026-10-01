import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {checkPromptSecrets,groupMessageSecretGate,storedSecretSource} from '../src/prompt-secret-gate.ts'
import TeloaAttachmentStore from '../src/attachment-guard.ts'
import {createGroupHandler} from '../src/groups.ts'
import {rand,tempHome} from './fixtures/credentials.ts'

const leaked=()=>'gh'+'p_'+rand(36)

test('闸：命中拒、未命中放、检测异常按拒收',()=>{
 assert.deepEqual(checkPromptSecrets(['你好'],()=>[]),{ok:true})
 assert.deepEqual(checkPromptSecrets([leaked()],()=>[]),{ok:false,kinds:['github']})
 assert.deepEqual(checkPromptSecrets(['x'],()=>{throw Error('down')}),{ok:false,kinds:[]})
})

test('个人会话：准入抛 gateway/bad-request，提示只含类别；干净文本交给父类',async t=>{
 const ctx=new Context(),home=await tempHome(t)
 t.after(()=>ctx.fiber.dispose())
 ctx.provide('credentials',{secretValues:()=>['stored-'+rand(20)]} as never)
 await ctx.plugin(TeloaAttachmentStore,{dshHome:home})
 const store=ctx.get('attachments') as TeloaAttachmentStore
 const secret=leaked()
 await assert.rejects(store.admitPromptContent([{type:'text',text:'key '+secret}]),(error:any)=>error.code==='gateway/bad-request'&&/GitHub/.test(error.message)&&!error.message.includes(secret)&&JSON.stringify(error.details)===JSON.stringify({issues:[{reason:'secret-in-message',kinds:['github']}]}))
 assert.deepEqual(await store.admitPromptContent([{type:'text',text:'普通问题'}]),[{type:'text',text:'普通问题'}])
})

test('调用顺序回归：controller 在 steer/followup 之前完成附件准入',()=>{
 const path=fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'))
 const source=readFileSync(path,'utf8'),body=source.slice(source.indexOf('async prompt(request)'))
 const admit=body.indexOf('attachments.admitPromptContent('),steer=body.indexOf('agent.steer(message)'),followup=body.indexOf('agent.followup(message)')
 assert.ok(admit>0&&admit<steer&&admit<followup)
})

test('群聊：命中在取服务之前拒绝，消息不落库；details 带形态类别、不带值或片段',async()=>{
 let sent=0,opened=0
 const handle=createGroupHandler('local:owner',async()=>{opened++;return {send:async()=>{sent++;return {}}} as never},groupMessageSecretGate(()=>[]))
 const secret=leaked()
 await assert.rejects(handle('groups/messages/send',{requestId:randomUUID(),groupId:randomUUID(),expectedVersion:1,text:'看 '+secret}),(error:any)=>{
  assert.equal(error.code,'teloa/invalid-input')
  assert.deepEqual(error.details,{reason:'secret-in-message',kinds:['github']})
  assert.ok(!JSON.stringify({message:error.message,details:error.details}).includes(secret.slice(4,12)))
  return true
 })
 assert.equal(sent,0)
 assert.equal(opened,0,'拒收发生在取服务之前')
 await handle('groups/messages/send',{requestId:randomUUID(),groupId:randomUUID(),expectedVersion:1,text:'普通消息'})
 assert.equal(sent,1)
})

test('已存值来源：无提供方只跳过已存值比对并只警告一次；提供方读取出错仍按拒收',()=>{
 const warnings:string[]=[]
 const missing=storedSecretSource(()=>undefined,message=>warnings.push(message))
 assert.deepEqual(missing(),[]);assert.deepEqual(missing(),[])
 assert.equal(warnings.length,1)
 assert.deepEqual(checkPromptSecrets([leaked()],missing),{ok:false,kinds:['github']})
 assert.deepEqual(checkPromptSecrets(['普通问题'],missing),{ok:true})
 const stored='stored-'+rand(20)
 const present=storedSecretSource(()=>({secretValues:()=>[stored]}),message=>warnings.push(message))
 assert.deepEqual(checkPromptSecrets(['看 '+stored],present),{ok:false,kinds:['stored']})
 const broken=storedSecretSource(()=>({secretValues:()=>{throw Error('locked')}}),message=>warnings.push(message))
 assert.deepEqual(checkPromptSecrets(['普通问题'],broken),{ok:false,kinds:[]})
 assert.equal(warnings.length,1)
})

test('个人会话：没有凭据提供方时照常挂载，形态检测照拦、干净文本放行',async t=>{
 const ctx=new Context(),home=await tempHome(t)
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(TeloaAttachmentStore,{dshHome:home})
 const store=ctx.get('attachments') as TeloaAttachmentStore
 assert.ok(store)
 await assert.rejects(store.admitPromptContent([{type:'text',text:'key '+leaked()}]),(error:any)=>error.code==='gateway/bad-request'&&/GitHub/.test(error.message))
 assert.deepEqual(await store.admitPromptContent([{type:'text',text:'普通问题'}]),[{type:'text',text:'普通问题'}])
})

test('个人会话：已存值命中同样拒收',async t=>{
 const ctx=new Context(),home=await tempHome(t),stored='stored-'+rand(20)
 t.after(()=>ctx.fiber.dispose())
 ctx.provide('credentials',{secretValues:()=>[stored]} as never)
 await ctx.plugin(TeloaAttachmentStore,{dshHome:home})
 const store=ctx.get('attachments') as TeloaAttachmentStore
 await assert.rejects(store.admitPromptContent([{type:'text',text:'这是 '+stored}]),(error:any)=>error.code==='gateway/bad-request'&&!error.message.includes(stored))
})

test('队列项 steer 只搬运已准入的消息；队列编辑不经准入（官方无钩子，列为残余）',()=>{
 const path=fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'))
 const source=readFileSync(path,'utf8'),body=source.slice(source.indexOf('async updateQueue(request)'),source.indexOf('async updateQueue(request)')+4000)
 assert.ok(body.includes('agent.inbox.replace(')&&body.includes('agent.steer(message)'))
 assert.equal(body.slice(0,body.indexOf('return { accepted: true }')).includes('admitPromptContent'),false,'上游若在队列编辑里加了准入，改为接入同一闸并去掉 §6 残余')
})
