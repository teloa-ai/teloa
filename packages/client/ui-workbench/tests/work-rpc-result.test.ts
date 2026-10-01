import test from 'node:test'
import assert from 'node:assert/strict'
import {unwrapWorkRpcResult} from '../lib/types/client/work-rpc-result.js'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'

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
