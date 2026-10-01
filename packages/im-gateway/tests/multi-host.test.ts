import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {createTeloaWorkService} from '../../harness-dsh/src/teloa-work-service.ts'
import {createTelegramAdapter} from '../src/channels/telegram.ts'
import * as imGateway from '../src/index.ts'
import {fakeAdapter,fakeCredentials,withTemp} from './im-fakes.ts'

const signal=new AbortController().signal
const token='123456:TEST-token_value'
type Status={connected:boolean;error?:string}

async function enabledTelegram(root:string):Promise<void>{
 await mkdir(join(root,'im-gateway'),{recursive:true})
 await writeFile(join(root,'im-gateway','channels.json'),JSON.stringify({channels:[{channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'}]}))
}

/** 一台宿主：独立 Context，teloaWork 指向给定运行目录；凭据已保存 telegram。 */
async function host(root:string,createAdapter:NonNullable<imGateway.ImGatewayOptions['createAdapter']>){
 const fakes=fakeCredentials()
 fakes.store.set(credentialKey('im-gateway','telegram'),{kind:'api-key',env:{TELEGRAM_BOT_TOKEN:token}} as never)
 const teloaWork=createTeloaWorkService({
  owner:'local:teloa-owner',runtimeRoot:root,
  dispatch:async endpoint=>endpoint==='roles/list'||endpoint==='groups/list'?[]:undefined,
  broadcast:{add:()=>()=>{}} as never,
  install:async()=>join(root,'sdk'),attachAllowed:()=>true,
 })
 const ctx=new Context()
 ctx.provide('teloaWork',teloaWork)
 ctx.provide('credentials',fakes.credentials)
 ctx.provide('sessionController',{})
 ctx.provide('sessions',{})
 const fiber=ctx.plugin(imGateway,{createAdapter})
 await fiber
 const call=(endpoint:string,payload:unknown)=>teloaWork.dispatchExtension(endpoint,payload,signal)!
 const status=async()=>((await call('im/channels/list',{})) as {status:Status}[])[0]!.status
 return {fiber,call,status}
}
const settle=async(check:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200&&!(await check());i+=1)await new Promise(resolve=>setTimeout(resolve,5))}

test('N8 锁半边：同一运行目录两台宿主（同一存活 pid），第二台 lock.held=false、只读可见原因，第一台不受影响',()=>withTemp(async root=>{
 await enabledTelegram(root)
 const first=fakeAdapter('telegram'),second=fakeAdapter('telegram')
 const a=await host(root,()=>first.adapter)
 await settle(()=>first.calls.start===1)
 const b=await host(root,()=>second.adapter)
 const lockPath=join(root,'im-gateway','instance.lock')
 assert.equal(JSON.parse(readFileSync(lockPath,'utf8')).pid,process.pid)
 assert.deepEqual(await b.status(),{connected:false,error:'another-host'})
 await assert.rejects(b.call('im/channels/enable',{requestId:'11111111-1111-4111-8111-111111111111',channelId:'telegram'}),{code:'teloa/conflict'})
 assert.equal(second.calls.start,0,'第二台不启动任何渠道')
 assert.deepEqual(await a.status(),{connected:true})
 await b.fiber.dispose()
 assert.ok(existsSync(lockPath),'未持锁的宿主退出不得删掉他人的锁')
 assert.deepEqual(await a.status(),{connected:true})
 await a.fiber.dispose()
 assert.equal(first.calls.stop,1)
 assert.equal(existsSync(lockPath),false)
}))

test('N8 平台半边：不同运行目录（各自持锁）连同一 bot，Telegram getUpdates 回 409 → 第二台状态含「另一宿主」',()=>withTemp(async base=>{
 const rootA=join(base,'a'),rootB=join(base,'b')
 await enabledTelegram(rootA);await enabledTelegram(rootB)
 const first=fakeAdapter('telegram')
 const a=await host(rootA,()=>first.adapter)
 const fetch409=(async(input:string|URL|Request,init?:RequestInit)=>{
  const method=new URL(String(input)).pathname.split('/').at(-1)
  if(method==='getMe')return Response.json({ok:true,result:{id:1,is_bot:true,first_name:'bot',username:'bot'}})
  if(method==='getUpdates')return Response.json({ok:false,error_code:409,description:'Conflict: terminated by other getUpdates request'},{status:409})
  return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))
 }) as typeof fetch
 const b=await host(rootB,(_kind,deps)=>createTelegramAdapter({...deps,fetch:fetch409,sleep:()=>new Promise(resolve=>setImmediate(resolve))}))
 await settle(async()=>(await b.status()).error!==undefined)
 const status=await b.status()
 assert.equal(status.connected,false)
 assert.equal(status.error,'another-host')
 assert.equal((await a.status()).connected,true)
 await b.fiber.dispose()
 await a.fiber.dispose()
}))
