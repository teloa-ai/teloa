import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {createAdapter} from '../src/channels/index.ts'
import {createStubAdapter,stubChannelPort} from '../src/channels/stub.ts'
import type {AdapterDeps,ImInbound} from '../src/core/types.ts'

const freePort=()=>new Promise<number>((done,fail)=>{
 const server=createServer()
 server.once('error',fail)
 server.listen(0,'127.0.0.1',()=>{
  const address=server.address()
  server.close(()=>typeof address==='object'&&address?done(address.port):fail(Error('no port')))
 })
})

function deps(env:Record<string,string>={STUB_TOKEN:'stub-secret-9f3a'}):AdapterDeps&{logs:string[]}{
 const logs:string[]=[]
 return {
  env:async()=>env,
  log:{info:(f,...v)=>logs.push([f,...v].join(' ')),warn:(f,...v)=>logs.push([f,...v].join(' '))},
  now:()=>new Date('2026-09-26T00:00:00.000Z'),
  sleep:async()=>{},
  logs,
 }
}

async function withEnv(values:Record<string,string|undefined>,run:()=>Promise<void>|void):Promise<void>{
 const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]))
 for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value}
 try{await run()}finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

test('1. 正式环境：无 TELOA_BROWSER_ACCEPTANCE 时 createAdapter(stub) 抛错；只有端口没有验收标记同样拒绝',()=>withEnv({TELOA_BROWSER_ACCEPTANCE:undefined,TELOA_IM_STUB_PORT:'45678'},()=>{
 assert.equal(stubChannelPort(),undefined)
 assert.throws(()=>createAdapter('stub',deps()),/验收/)
}))

test('1b. 有验收标记但无端口、端口非法 → 仍拒绝；两者齐备才返回端口',async()=>{
 await withEnv({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_IM_STUB_PORT:undefined},()=>{assert.throws(()=>createAdapter('stub',deps()),/验收/)})
 for(const bad of ['0','65536','abc','12.5',''])await withEnv({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_IM_STUB_PORT:bad},()=>{assert.equal(stubChannelPort(),undefined,bad)})
 await withEnv({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_IM_STUB_PORT:'45678'},()=>{assert.equal(stubChannelPort(),45678)})
})

test('2. 验收环境：/inbound → handler 收到；send 后 /outbound 返回一条并清空；凭据值不出现在回包与日志',async()=>{
 const port=await freePort()
 await withEnv({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_IM_STUB_PORT:String(port)},async()=>{
  const d=deps()
  const adapter=createAdapter('stub',d)
  assert.equal(adapter.id,'stub')
  assert.equal(adapter.capabilities.maxMessageLength,4096)
  const got:ImInbound[]=[]
  await adapter.start(async m=>{got.push(m)})
  try{
   assert.equal(adapter.status().connected,true)
   const base=`http://127.0.0.1:${port}`
   const res=await fetch(`${base}/inbound`,{method:'POST',body:JSON.stringify({chatId:'u1',chatKind:'direct',messageId:'m1',sender:{imUserId:'u1',displayName:'甲'},text:'你好'})})
   assert.equal(res.status,200)
   assert.equal(got.length,1)
   assert.equal(got[0]!.channelId,'stub')
   assert.equal(got[0]!.text,'你好')
   assert.deepEqual(got[0]!.mentions,[])
   assert.deepEqual(got[0]!.media,[])
   await fetch(`${base}/inbound`,{method:'POST',body:JSON.stringify({chatId:'u1',chatKind:'direct',messageId:'m2',sender:{imUserId:'u1',displayName:'甲'},text:'',action:{callbackId:'abcd1234',value:'approve'}})})
   assert.deepEqual(got[1]!.action,{callbackId:'abcd1234',value:'approve',callbackToken:''})
   const sent=await adapter.send('u1','回复')
   const card=await adapter.sendCard!('u1',{title:'bash',lines:['参数：ls'],callbackId:'abcd1234',approveLabel:'批准',rejectLabel:'拒绝'})
   await adapter.editMessage!('u1',card.messageId,'已批准（IM）')
   const out=await (await fetch(`${base}/outbound`)).json() as {kind:string;chatId:string;messageId:string;text:string;card?:unknown}[]
   assert.deepEqual(out.map(row=>row.kind),['send','card','edit'])
   assert.equal(out[0]!.messageId,sent.messageId)
   assert.equal(out[0]!.text,'回复')
   assert.equal((out[1]!.card as {callbackId:string}).callbackId,'abcd1234')
   assert.equal(out[2]!.messageId,card.messageId)
   assert.deepEqual(await (await fetch(`${base}/outbound`)).json(),[],'读取即清空')
   assert.equal((await fetch(`${base}/inbound`,{method:'POST',body:'{"chatId":1}'})).status,400)
   assert.equal((await fetch(`${base}/nope`)).status,404)
   assert.ok(!d.logs.join('\n').includes('stub-secret'))
  }finally{await adapter.stop()}
  assert.equal(adapter.status().connected,false)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/outbound`),'stop 后端口关闭')
 })
})

test('3. /fault conflict → status().error 为 another-host（设置页「另一宿主已连接」）且不再连接；unauthorized → credentials-invalid；disconnect → 退避后重连',async()=>{
 const port=await freePort()
 const base=`http://127.0.0.1:${port}`
 const fault=(kind:string)=>fetch(`${base}/fault`,{method:'POST',body:JSON.stringify({kind})})
 const conflict=createStubAdapter({...deps(),port})
 await conflict.start(async()=>{})
 try{
  assert.equal((await fault('conflict')).status,200)
  assert.equal(conflict.status().connected,false)
  assert.equal(conflict.status().error,'another-host')
  assert.equal((await fetch(`${base}/inbound`,{method:'POST',body:JSON.stringify({chatId:'u1',chatKind:'direct',messageId:'m1',sender:{imUserId:'u1',displayName:'甲'},text:'x'})})).status,503,'终态后不再投递入站')
 }finally{await conflict.stop()}
 const auth=createStubAdapter({...deps(),port})
 await auth.start(async()=>{})
 try{
  assert.equal(auth.status().error,undefined,'重新启动清除终态')
  await fault('unauthorized')
  assert.equal(auth.status().error,'credentials-invalid')
  assert.equal(auth.status().connected,false)
 }finally{await auth.stop()}
 const sleeps:number[]=[]
 const d={...deps(),port,sleep:async(ms:number)=>{sleeps.push(ms)}}
 const flaky=createStubAdapter(d)
 await flaky.start(async()=>{})
 try{
  await fault('disconnect')
  for(let i=0;i<50&&!flaky.status().connected;i+=1)await new Promise(resolve=>setTimeout(resolve,5))
  assert.deepEqual(sleeps,[1000],'按 backoff 第 1 次等待')
  assert.equal(flaky.status().connected,true)
  assert.equal(flaky.status().error,undefined)
  assert.equal((await fault('bogus')).status,400)
 }finally{await flaky.stop()}
})

test('4. 缺 STUB_TOKEN → 启动即 credentials-invalid 终态，不监听',async()=>{
 const port=await freePort()
 const adapter=createStubAdapter({...deps({}),port})
 await adapter.start(async()=>{})
 try{
  assert.equal(adapter.status().connected,false)
  assert.equal(adapter.status().error,'credentials-invalid')
  await assert.rejects(fetch(`http://127.0.0.1:${port}/outbound`))
 }finally{await adapter.stop()}
})
