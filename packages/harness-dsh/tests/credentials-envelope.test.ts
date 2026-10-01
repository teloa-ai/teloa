import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {EnvelopeError,keyIdOf,open,readHeader,seal} from '../src/credentials/envelope.ts'

test('往返一致，密文不含明文，信封头含格式、fileId、keyId',()=>{
 const key=randomBytes(32),fileId=randomUUID(),plain='{"refs":{"A":"secret-value-123"}}'
 const text=seal(key,fileId,plain),header=readHeader(text)
 assert.equal(header.format,'teloa.credentials/v1');assert.equal(header.fileId,fileId);assert.equal(header.keyId,keyIdOf(key))
 assert.ok(!text.includes('secret-value-123'))
 assert.deepEqual(open(key,text),{fileId,keyId:keyIdOf(key),plaintext:plain})
})

test('错钥、篡改密文、篡改 fileId 均失败且不返回内容',()=>{
 const key=randomBytes(32),text=seal(key,randomUUID(),'x')
 assert.throws(()=>open(randomBytes(32),text),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='key-mismatch')
 const row=JSON.parse(text);row.ciphertext=Buffer.from('y').toString('base64')
 assert.throws(()=>open(key,JSON.stringify(row)),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='auth-failed')
 const moved=JSON.parse(text);moved.fileId=randomUUID()
 assert.throws(()=>open(key,JSON.stringify(moved)),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='auth-failed')
 assert.throws(()=>readHeader('not json'),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='format')
})

test('主密钥必须 32 字节',()=>{assert.throws(()=>seal(randomBytes(16),randomUUID(),'x'),RangeError)})

test('GCM 标签必须 16 字节、nonce 必须 12 字节：截断标签与异常 nonce 一律 format 失败',()=>{
 const key=randomBytes(32),text=seal(key,randomUUID(),'secret')
 for(const bytes of [4,8,12,15]){
  const row=JSON.parse(text);row.tag=Buffer.from(row.tag,'base64').subarray(0,bytes).toString('base64')
  assert.throws(()=>open(key,JSON.stringify(row)),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='format')
 }
 for(const bytes of [8,16]){
  const row=JSON.parse(text);row.nonce=randomBytes(bytes).toString('base64')
  assert.throws(()=>readHeader(JSON.stringify(row)),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='format')
 }
})

test('非对象 JSON 抛 EnvelopeError(format)；open 也要求 32 字节主密钥',()=>{
 for(const text of ['null','[]','1','"x"'])assert.throws(()=>readHeader(text),(error:unknown)=>error instanceof EnvelopeError&&error.reason==='format')
 const text=seal(randomBytes(32),randomUUID(),'x')
 assert.throws(()=>open(randomBytes(16),text),RangeError)
})
