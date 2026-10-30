import test from 'node:test'
import assert from 'node:assert/strict'
import {installBrowserRandomUUID} from '../src/client/browser-crypto-compat.ts'

test('HTTP 的 UUID 使用 16 个安全随机字节，并固定 RFC 版本和变体位',()=>{
 let draws=0
 const provider={getRandomValues:(bytes:Uint8Array)=>{assert.equal(bytes.length,16);draws++;return bytes.fill(255)}} as unknown as Crypto
 installBrowserRandomUUID(provider)
 assert.equal(provider.randomUUID(),'ffffffff-ffff-4fff-bfff-ffffffffffff')
 assert.equal(draws,1)
 const installed=provider.randomUUID;installBrowserRandomUUID(provider);assert.equal(provider.randomUUID,installed)
})

test('原生 UUID 保持原样；缺少安全随机源时不退化到弱随机',()=>{
 const native=()=>crypto.randomUUID(),provider={randomUUID:native} as Crypto
 installBrowserRandomUUID(provider);assert.equal(provider.randomUUID,native)
 const missing={} as Crypto;installBrowserRandomUUID(missing);assert.equal(missing.randomUUID,undefined)
})

test('HTTP 兼容的 UUID 与服务端接受的 v4 格式一致，连续请求身份不重复',()=>{
 const provider={getRandomValues:crypto.getRandomValues.bind(crypto)} as Crypto
 installBrowserRandomUUID(provider)
 const values=Array.from({length:1000},()=>provider.randomUUID())
 assert.equal(new Set(values).size,values.length)
 assert.ok(values.every(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)))
})
