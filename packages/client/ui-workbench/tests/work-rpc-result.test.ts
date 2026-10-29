import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {unwrapWorkRpcResult,createRejectedWorkRpcCall} from '../lib/types/client/work-rpc-result.js'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'
import {createManagedMcpConnectionApi} from '../lib/types/client/mcp-connections-api.js'

test('文件冲突经 RPC 保留错误码，显示本地化提示且不泄露服务端正文',()=>{
 const result={ok:false as const,error:{code:'teloa/file-changed',message:'内部路径与诊断，不可展示'}}
 assert.throws(()=>unwrapWorkRpcResult(result),error=>{
  assert.ok(error instanceof Error)
  assert.equal(localizeWorkError('zh-CN',error),'原文件内容已变化，未覆盖。请保留草稿并重新读取后再保存。')
  assert.equal(localizeWorkError('en',error),'The original file has changed and was not overwritten. Keep your draft and read the file again before saving.')
  assert.equal('rejected' in error,false)
  return true
 })
})

test('成功回包保持原值；存储错误不被误当作没有写入的确定拒绝',()=>{
 const value={id:'same-result'}
 assert.equal(unwrapWorkRpcResult({ok:true,value}),value)
 assert.throws(()=>unwrapWorkRpcResult({ok:false,error:{code:'teloa/storage-unavailable',message:'不可用'}}),error=>{
  assert.ok(error instanceof Error)
  assert.equal(localizeWorkError('zh-CN',error),'存储服务暂时不可用，请稍后重试。')
  assert.equal('rejected' in error,false)
  return true
 })
})

test('MCP认证拒绝原因穿过通用RPC解包与连接API，使用固定本地化提示',async()=>{
 const calls:string[]=[],secret='SYNTHETIC_PRIVATE_RESPONSE',details={reason:'mcp-auth-rejected'}
 const api=createManagedMcpConnectionApi(async endpoint=>{
  calls.push(endpoint)
  return unwrapWorkRpcResult({ok:false,error:{code:'teloa/dependency-unavailable',message:secret,details}})
 })
 await assert.rejects(()=>api.connect('11111111-1111-4111-8111-111111111111'),error=>{
  assert.ok(error instanceof Error)
  assert.deepEqual((error as Error&{details?:unknown}).details,details)
  assert.match(localizeWorkError('zh-CN',error),/401\/403.*请求头名称.*前缀/)
  assert.match(localizeWorkError('en',error),/401\/403/)
  assert.doesNotMatch(localizeWorkError('zh-CN',error),new RegExp(secret))
  assert.equal('rejected'in error,false,'保留未知写入结果语义，不自行清理请求')
  return true
 })
 assert.deepEqual(calls,['mcp-connections/connect'])
})

test('未知或畸形details不崩溃、不展示任意正文、不升级授权或确定拒绝',()=>{
 class NonJsonDetails{reason='mcp-auth-rejected'}
 const accessor=Object.defineProperty({},'reason',{get:()=>{throw Error('访问器不应执行')},enumerable:true})
 for(const details of [undefined,null,[],42,'mcp-auth-rejected',new Date(),new NonJsonDetails(),accessor,{reason:{kind:'mcp-auth-rejected'},allowed:true,credentials:'SYNTHETIC_SECRET'}]){
  const reply={ok:false as const,error:{code:'teloa/dependency-unavailable',message:'SYNTHETIC_PRIVATE_RESPONSE',details}}
  assert.throws(()=>Reflect.apply(unwrapWorkRpcResult,undefined,[reply]),error=>{
   assert.ok(error instanceof Error)
   assert.equal(localizeWorkError('zh-CN',error),'所需服务暂不可用，请重试原请求。')
   assert.equal('rejected'in error,false)
   assert.equal('allowed'in error,false)
   assert.equal('credentials'in error,false)
   return true
  })
 }
})

test('真实市场调用器保留跨执行域JSON的MCP错误原因和原拒绝语义，不将传输未知改成拒绝',async()=>{
 for(const [reason,expected] of [['mcp-auth-rejected',/401\/403/],['mcp-network-unavailable',/网络|连接/],['mcp-service-error',/Streamable HTTP/]] as const){
  const reply=runInNewContext('JSON.parse(wire)',{wire:JSON.stringify({ok:false,error:{code:'teloa/dependency-unavailable',message:'SYNTHETIC_PRIVATE_RESPONSE',details:{reason}}})})
  assert.notEqual(Object.getPrototypeOf(reply.error.details),Object.prototype)
  const call=createRejectedWorkRpcCall(async()=>reply),api=createManagedMcpConnectionApi(call)
  await assert.rejects(api.connect('11111111-1111-4111-8111-111111111111'),error=>{
   assert.ok(error instanceof Error)
   assert.deepEqual((error as Error&{details?:unknown}).details,{reason})
   assert.equal(Reflect.get(error,'rejected'),true)
   assert.match(localizeWorkError('zh-CN',error),expected)
   assert.doesNotMatch(localizeWorkError('zh-CN',error),/SYNTHETIC_PRIVATE_RESPONSE/)
   return true
  })
 }
 const transportError=Error('response lost'),unknown=createRejectedWorkRpcCall(async()=>{throw transportError})
 await assert.rejects(unknown('mcp-connections/connect',{}),error=>error===transportError&&!('rejected'in transportError))
 const value={id:'original'},success=createRejectedWorkRpcCall(async()=>({ok:true,value}))
 assert.equal(await success('mcp-connections/get',{}),value)
})
