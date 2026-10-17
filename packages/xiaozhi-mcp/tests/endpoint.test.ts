import test from 'node:test'
import assert from 'node:assert/strict'
import {readXiaozhiEndpoint} from '../src/endpoint.ts'

test('官方接入点仅接受可信 WSS 主机，错误不得带出 URL 秘密',()=>{
 const endpoint='wss://api.xiaozhi.me/mcp/?token=private-test-secret'
 assert.equal(readXiaozhiEndpoint(endpoint),endpoint)
 for(const bad of ['ws://api.xiaozhi.me/mcp/?token=secret','wss://evil.example/mcp/?token=secret','wss://api.xiaozhi.me.evil.example/mcp/','wss://user:pass@api.xiaozhi.me/mcp/','wss://api.xiaozhi.me:8443/mcp/','wss://api.xiaozhi.me/other']){
  assert.throws(()=>readXiaozhiEndpoint(bad),error=>error instanceof Error&&!error.message.includes('secret')&&!error.message.includes(bad))
 }
})
