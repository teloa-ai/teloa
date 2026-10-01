import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local'
import {WorkError,type BusinessImportFileRef} from '@teloa/contract'
import {createAttachmentPorts,type SavedFileRef} from '../src/attachments.ts'
import {createBusinessImportFilePort} from '../src/business-import-files.ts'

const limit=2_097_152
const abcHash='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const emptyHash='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const file:BusinessImportFileRef={attachmentId:'opaque:fixture-file',name:'原表.csv',bytes:3,sha256:abcHash}
const nativeRef:SavedFileRef={attachmentId:file.attachmentId,name:file.name,bytes:file.bytes}

/** 字节仓只控制公开 save/read 边界，完整读取与业务校验均使用生产实现。 */
function fixture(data=Uint8Array.of(97,98,99)){
 let saved=0,read=0,closed=false
 const attachments=createAttachmentPorts({
  saveFile:async(input:{data:Uint8Array;name:string})=>{saved++;assert.deepEqual([...input.data],[...data]);return {...nativeRef,name:'DSH清洗后的.csv',bytes:data.byteLength}},
  readFileStream:async function*(ref:SavedFileRef){read++;assert.deepEqual(Object.keys(ref).sort(),['attachmentId','bytes','name']);try{yield data.subarray(0,1);yield data.subarray(1)}finally{closed=true}},
 })
 return {port:createBusinessImportFilePort(attachments),counts:()=>({saved,read,closed})}
}

test('save 委托官方端口保存并完整读回，hash 由真实字节计算且保留清洗后的名字',async()=>{
 const f=fixture()
 assert.deepEqual(await f.port.save({dataBase64:'YWJj',name:'原表.csv',bytes:3}),{...file,name:'DSH清洗后的.csv'})
 assert.deepEqual(f.counts(),{saved:1,read:1,closed:true})
})

test('zero_byte_file_is_saved_and_read_without_fabricating_table',async()=>{
 const f=fixture(new Uint8Array())
 const ref=await f.port.save({dataBase64:'',name:'空表.csv',bytes:0})
 assert.equal(ref.bytes,0)
 assert.equal(ref.sha256,emptyHash)
 assert.equal((await f.port.read(ref)).byteLength,0)
})

test('declared_bytes_do_not_bypass_real_limit',async()=>{
 const f=fixture()
 for(const input of [
  {dataBase64:Buffer.alloc(limit+1).toString('base64'),name:'超限.csv',bytes:1},
  {dataBase64:'YWJj',name:'声明不符.csv',bytes:2},
  {dataBase64:'YWJj',name:'声明超限.csv',bytes:limit+1},
 ])await assert.rejects(f.port.save(input),{code:'teloa/invalid-input'})
 assert.deepEqual(f.counts(),{saved:0,read:0,closed:false})
})

test('read 恰好 2MiB 必须完整读取并核验，不能返回旧前缀 API 的部分结果',async()=>{
 const data=Buffer.alloc(limit,7),ref={...file,bytes:limit,sha256:createHash('sha256').update(data).digest('hex')}
 let ended=false
 const port=createBusinessImportFilePort(createAttachmentPorts({readFileStream:async function*(){try{yield data.subarray(0,limit-1);yield data.subarray(limit-1)}finally{ended=true}}}))
 assert.deepEqual(await port.read(ref),data)
 assert.equal(ended,true)
})

test('attachment_hash_or_length_mismatch_refuses_preview',async()=>{
 for(const data of [Uint8Array.of(97,98),Uint8Array.of(97,98,100)]){
  const port=createBusinessImportFilePort(createAttachmentPorts({readFileStream:async function*(){yield data}}))
  const error=await port.read(file).catch(error=>error)
  assert.ok(error instanceof WorkError)
  assert.equal(error.code,'teloa/storage-corrupt')
  assert.equal(error.details,undefined)
  assert.equal(error.message.includes('abd'),false)
 }
 const port=createBusinessImportFilePort(createAttachmentPorts({saveFile:async()=>nativeRef,readFileStream:async function*(){yield Uint8Array.of(97,98,100)}}))
 await assert.rejects(port.save({dataBase64:'YWJj',name:'原表.csv',bytes:3}),{code:'teloa/storage-corrupt'})
})

test('实际读取超限时拒绝并关闭，不因草案声明小文件而读回部分内容',async()=>{
 let closed=false
 const port=createBusinessImportFilePort(createAttachmentPorts({readFileStream:async function*(){try{yield Buffer.alloc(limit);yield Uint8Array.of(1)}finally{closed=true}}}))
 const error=await port.read(file).catch(error=>error)
 assert.ok(error instanceof WorkError)
 assert.equal(error.code,'teloa/invalid-input')
 assert.deepEqual(error.details,{businessImportIssues:[{code:'file-too-large',message:'导入文件不能超过 2 MiB。'}]})
 assert.equal(closed,true)
})

test('foreign_native_receipt_is_not_a_file_authority',async()=>{
 let opened=false
 const port=createBusinessImportFilePort(createAttachmentPorts({readFileStream:()=>{opened=true;return (async function*(){yield Uint8Array.of(97,98,99)})()}}))
 for(const value of [nativeRef,{...file,hostPath:'/private/foreign.csv'},{...file,sha256:'not-a-hash'}]){
  await assert.rejects(port.read(value as BusinessImportFileRef),{code:'teloa/invalid-host-response'})
 }
 assert.equal(opened,false)
})

test('abort_closes_or_stops_read_without_table',async()=>{
 const controller=new AbortController(),reason=new Error('用户取消导入')
 let closed=false
 const port=createBusinessImportFilePort(createAttachmentPorts({readFileStream:async function*(){try{yield Uint8Array.of(97);controller.abort(reason);yield Uint8Array.of(98,99)}finally{closed=true}}}))
 await assert.rejects(port.read(file,controller.signal),error=>error===reason)
 assert.equal(closed,true)
 let saved=false
 const before=new AbortController();before.abort(reason)
 const beforePort=createBusinessImportFilePort(createAttachmentPorts({saveFile:async()=>{saved=true;return nativeRef}}))
 await assert.rejects(beforePort.save({dataBase64:'YWJj',name:'原表.csv',bytes:3},before.signal),error=>error===reason)
 assert.equal(saved,false)
})

test('save 等待官方保存期间取消后不产生可用来源回执',async()=>{
 const controller=new AbortController(),reason=new Error('保存中取消')
 let read=false
 const port=createBusinessImportFilePort(createAttachmentPorts({saveFile:async()=>{controller.abort(reason);return nativeRef},readFileStream:async function*(){read=true;yield Uint8Array.of(97,98,99)}}))
 await assert.rejects(port.save({dataBase64:'YWJj',name:'原表.csv',bytes:3},controller.signal),error=>error===reason)
 assert.equal(read,false)
})

test('真实 DSH0.1.7-rc.1 LocalAttachmentStore 公共保存与流完整往返',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-business-import-files-'))
 const ctx=new Context()
 try{
  const store=new LocalAttachmentStore(ctx,{dshHome:home})
  const port=createBusinessImportFilePort(createAttachmentPorts(store))
  for(const data of [Buffer.alloc(0),Buffer.from('\ufeff编号,名称\r\n001,"原文\n换行"\r\n','utf8'),Buffer.alloc(limit,65)]){
   const ref=await port.save({dataBase64:data.toString('base64'),name:'官方完整字节.csv',bytes:data.byteLength})
   assert.equal(ref.bytes,data.byteLength)
   assert.equal(ref.sha256,createHash('sha256').update(data).digest('hex'))
   assert.deepEqual(await port.read(ref),data)
  }
 }finally{try{await ctx.fiber.dispose()}finally{await rm(home,{recursive:true,force:true})}}
})
