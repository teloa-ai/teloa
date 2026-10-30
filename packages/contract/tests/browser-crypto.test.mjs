import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {sha256Digest} from '../src/browser-crypto.mjs'

test('HTTP 的 SHA-256 与原生摘要相同，包括填充边界、UTF-8 和大输入',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto'),native=globalThis.crypto
 const rows=[new Uint8Array(),new TextEncoder().encode('abc'),new TextEncoder().encode('HTTP 中文资料 🔐'),...([55,56,63,64,65,1000000].map(size=>new Uint8Array(size).fill(97)))]
 try{
  for(const bytes of rows){
   const expected=createHash('sha256').update(bytes).digest('hex')
   Object.defineProperty(globalThis,'crypto',{configurable:true,value:native})
   assert.equal(Buffer.from(await sha256Digest(bytes)).toString('hex'),expected)
   Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:native.getRandomValues.bind(native)}})
   assert.equal(Buffer.from(await sha256Digest(bytes)).toString('hex'),expected)
  }
 }finally{Object.defineProperty(globalThis,'crypto',original)}
})

test('摘要只读取视图的有效字节，调用后修改原缓冲区不影响结果',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto')
 try{
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}})
  const backing=Uint8Array.from([9,97,98,99,8]),expected=createHash('sha256').update('abc').digest('hex')
  for(const view of [backing.subarray(1,4),new DataView(backing.buffer,1,3)])assert.equal(Buffer.from(await sha256Digest(view)).toString('hex'),expected)
  const input=new TextEncoder().encode('abc'),pending=sha256Digest(input);input.fill(0)
  assert.equal(Buffer.from(await pending).toString('hex'),expected)
  assert.equal(Buffer.from(await sha256Digest(new TextEncoder().encode('abc').buffer)).toString('hex'),expected)
 }finally{Object.defineProperty(globalThis,'crypto',original)}
})

test('原生摘要失败时保留错误，不悄悄切换实现',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto'),error=new Error('native digest failed')
 try{
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async()=>{throw error}}}})
  await assert.rejects(sha256Digest(new Uint8Array()),value=>value===error)
 }finally{Object.defineProperty(globalThis,'crypto',original)}
})
