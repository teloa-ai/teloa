import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,groupAttachmentUploadInput} from '@teloa/contract'
import {createAttachmentPorts,type SavedFileRef,type SavedImageRef} from '../src/attachments.ts'

/** 与 `@deepseek-ai/dsh-attachment` 的 AttachmentError 同形：按 `code` 路由，不按原型链。 */
class AttachmentError extends Error {
 readonly code:string
 constructor(message:string,code:string){super(message);this.name='AttachmentError';this.code=code}
}

const invalidInputCodes=['TOO_MANY_IMAGES','IMAGES_TOO_LARGE','UNSUPPORTED_IMAGE_TYPE','INVALID_IMAGE_BASE64','INVALID_IMAGE','IMAGE_TYPE_MISMATCH','IMAGE_TOO_LARGE','IMAGE_TOO_MANY_PIXELS','IMAGE_DIMENSION_TOO_LARGE','INVALID_FILE_BASE64','INVALID_ATTACHMENT_REF']
const unavailableCodes=['ATTACHMENT_WRITE_FAILED','ATTACHMENT_FILES_UNSUPPORTED','ATTACHMENT_PROJECTION_UNSUPPORTED']
const unreadableCodes=['ATTACHMENT_NOT_FOUND','ATTACHMENT_CORRUPT','ATTACHMENT_READ_FAILED']

const imageRef:SavedImageRef={attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/jpeg',bytes:341,width:128,height:96}
const fileRef:SavedFileRef={attachmentId:'sha256:'+'b'.repeat(64),name:'往返探针.bin',bytes:32}

function portsThrowing(error:unknown){
 const refuse=async()=>{throw error}
 return createAttachmentPorts({saveImage:refuse,readImage:refuse,saveFile:refuse,readFileStream:async function*(){throw error}})
}
function calls(ports:ReturnType<typeof portsThrowing>){
 return [
  ()=>ports.saveImage('AAAA','image/png','图.png'),
  ()=>ports.saveFile('AAAA','件.bin'),
  ()=>ports.readImageBytes(imageRef),
  ()=>ports.readFileBytes(fileRef),
  ()=>ports.readFileBytesBounded(fileRef,100),
 ]
}
async function refusalOf(call:()=>Promise<unknown>){
 try{await call()}catch(error){return error}
 throw Error('端口在附件仓失败时没有拒绝。')
}

test('DSH 附件错误按映射表折成三个正式码，五个方法同一口径',async()=>{
 for(const [codes,expected,message] of [
  [invalidInputCodes,'teloa/invalid-input','附件内容不符合要求，请换一个文件再试。'],
  [unavailableCodes,'teloa/dependency-unavailable','附件存储当前不可用，请稍后再试。'],
  [unreadableCodes,'teloa/source-unavailable','附件内容已不可读取。'],
 ] as const){
  for(const code of codes){
   const ports=portsThrowing(new AttachmentError('Attachment refused: '+code+'.',code))
   for(const call of calls(ports)){
    const refusal=await refusalOf(call)
    assert.ok(refusal instanceof WorkError,code+' 必须折成 WorkError')
    assert.equal(refusal.code,expected,code+' 的映射码')
    assert.equal(refusal.message,message,code+' 的文案')
   }
  }
 }
})

test('拒绝既不带 details，也不把 DSH 的 code 透传进文案',async()=>{
 for(const code of [...invalidInputCodes,...unavailableCodes,...unreadableCodes]){
  const ports=portsThrowing(new AttachmentError('Attachment refused: '+code+'.',code))
  for(const call of calls(ports)){
   const refusal=await refusalOf(call) as WorkError
   // WorkError 的 details 是可选字段；不赋值即 undefined，宿主透传时不会出现在回包里。
   assert.equal(refusal.details,undefined,code+' 不得带 details')
   assert.equal(refusal.message.includes(code),false,code+' 不得出现在文案里')
   assert.equal(refusal.message.includes('ATTACHMENT'),false,'文案不得含 DSH 码片段')
  }
 }
})

test('认不出的失败算存储不可用，不猜成可纠正的输入问题',async()=>{
 for(const error of [new AttachmentError('unknown','ATTACHMENT_SOMETHING_NEW'),Error('sharp 原生崩溃'),new WorkError('teloa/storage-corrupt','上游不得透传的全文',{raw:'源数据'}),'字符串失败',undefined]){
  for(const call of calls(portsThrowing(error))){
   const refusal=await refusalOf(call) as WorkError
   assert.equal(refusal.code,'teloa/dependency-unavailable')
   assert.equal(refusal.message,'附件存储当前不可用，请稍后再试。')
  }
 }
})

test('非规范 base64 由契约解析器在入口判掉，端口不做第二次判定',async()=>{
 const seen:unknown[]=[]
 const ports=createAttachmentPorts({
  saveImage:async(input:{data:Uint8Array})=>{seen.push(input.data.length);return {...imageRef}},
  readImage:async()=>({data:new Uint8Array()}),
  saveFile:async(input:{data:Uint8Array})=>{seen.push(input.data.length);return {...fileRef}},
  readFileStream:async function*(){},
 })
 const payload=(dataBase64:string)=>({requestId:'11111111-1111-4111-8111-111111111111',groupId:'22222222-2222-4222-8222-222222222222',expectedVersion:1,mime:'text/markdown',name:'样本.md',dataBase64})
 for(const data of ['AAA','A A A A','_-==','AAAA=']){
  // 判据在这里：契约的 attachmentBase64() 按长度、字符集、填充与声明字节数四条逐字判。
  assert.throws(()=>groupAttachmentUploadInput(payload(data)),{code:'teloa/invalid-input'},JSON.stringify(data)+' 必须在解析器处被拒')
  // 端口只解码：同一条判据不该有两个说法，因此这里照常把字节交给附件仓。
  await ports.saveImage(data,'image/png','图.png')
  await ports.saveFile(data,'件.bin')
 }
 assert.equal(seen.length,8,'端口不再二次判定，八次调用都应触达附件仓')
})

test('落盘回执只投出声明的键，读字节把分块拼回原序',async()=>{
 const ports=createAttachmentPorts({
  saveImage:async()=>({...imageRef,name:'图.png',originalDimensions:{width:256,height:192}}),
  readImage:async()=>({data:Uint8Array.from([1,2,3])}),
  saveFile:async()=>({...fileRef,hostPath:'/tmp/不该出现'}),
  readFileStream:async function*(){yield Uint8Array.from([7,8]);yield Uint8Array.from([9])},
 })
 assert.deepEqual(await ports.saveImage('','image/jpeg','图.png'),imageRef)
 assert.deepEqual(await ports.saveFile('','件.bin'),fileRef)
 assert.deepEqual([...await ports.readImageBytes(imageRef)],[1,2,3])
 assert.deepEqual([...await ports.readFileBytes(fileRef)],[7,8,9])
})

test('readFileBytes 可给字节上限：读够即停，不把整份文件读进内存（审查：文本附件有界读取）',async()=>{
 let pulled=0
 const ports=createAttachmentPorts({saveImage:async()=>{throw Error()},readImage:async()=>{throw Error()},saveFile:async()=>{throw Error()},
  readFileStream:async function*(){for(let index=0;index<100;index++){pulled++;yield Uint8Array.from([index,index,index,index])}}})
 const bytes=await ports.readFileBytes({attachmentId:'sha256:'+'a'.repeat(64),name:'长.txt',bytes:400},undefined,10)
 assert.deepEqual([...bytes],[0,0,0,0,1,1,1,1,2,2])
 assert.ok(pulled<=3,'读够 10 字节后不再继续拉：实际拉了 '+pulled+' 块')
 pulled=0
 assert.equal((await ports.readFileBytes({attachmentId:'sha256:'+'a'.repeat(64),name:'长.txt',bytes:400})).length,400)
 assert.equal(pulled,100)
})

test('readFileBytesBounded 必须读完整流，恰好上限和零字节均不截断',async()=>{
 let pulled=0
 const ports=createAttachmentPorts({readFileStream:async function*(){pulled++;yield Uint8Array.of(1,2);pulled++;yield Uint8Array.of(3,4)}})
 assert.deepEqual([...await ports.readFileBytesBounded({...fileRef,bytes:4},4)],[1,2,3,4])
 assert.equal(pulled,2)
 const empty=createAttachmentPorts({readFileStream:async function*(){}})
 assert.equal((await empty.readFileBytesBounded({...fileRef,bytes:0},0)).length,0)
})

test('readFileBytesBounded 不相信声明长度，实际超过上限拒绝并关闭流',async()=>{
 let pulled=0,closed=false
 const ports=createAttachmentPorts({readFileStream:async function*(){try{for(let i=0;i<3;i++){pulled++;yield Uint8Array.of(1,2)}}finally{closed=true}}})
 await assert.rejects(ports.readFileBytesBounded({...fileRef,bytes:1},3),{code:'teloa/invalid-input'})
 assert.equal(pulled,2)
 assert.equal(closed,true)
})

test('readFileBytesBounded 的非法上限在读取前拒绝',async()=>{
 let opened=false
 const ports=createAttachmentPorts({readFileStream:()=>{opened=true;return (async function*(){})()}})
 for(const limit of [-1,0.5,Infinity,NaN])await assert.rejects(ports.readFileBytesBounded(fileRef,limit),{code:'teloa/invalid-input'})
 assert.equal(opened,false)
})

test('readFileBytesBounded 取消保持原 reason、关闭流且不返回部分字节',async()=>{
 const controller=new AbortController(),reason=new Error('仅用于测试的取消原因')
 let closed=false
 const ports=createAttachmentPorts({readFileStream:async function*(_ref:SavedFileRef,signal:AbortSignal){
  assert.equal(signal,controller.signal)
  try{yield Uint8Array.of(1);controller.abort(reason);yield Uint8Array.of(2)}finally{closed=true}
 }})
 await assert.rejects(ports.readFileBytesBounded(fileRef,10,controller.signal),error=>error===reason)
 assert.equal(closed,true)
})

test('readFileBytesBounded 在等待下一块时取消也结束读取并调用 return',async()=>{
 const controller=new AbortController(),reason=new Error('等待中取消')
 let opened=false,closed=false
 const ports=createAttachmentPorts({readFileStream:()=>({[Symbol.asyncIterator]:()=>({
  next:()=>{opened=true;return new Promise<IteratorResult<Uint8Array>>(()=>{})},
  return:async()=>{closed=true;return {done:true,value:undefined}},
 })})})
 const reading=ports.readFileBytesBounded(fileRef,10,controller.signal)
 await Promise.resolve()
 assert.equal(opened,true)
 controller.abort(reason)
 await assert.rejects(reading,error=>error===reason)
 assert.equal(closed,true)
})

test('readFileBytesBounded 已取消时不打开流，官方失败仍沿附件错误映射',async()=>{
 const controller=new AbortController(),reason=new Error('读取前取消')
 controller.abort(reason)
 let opened=false
 const ports=createAttachmentPorts({readFileStream:()=>{opened=true;return (async function*(){})()}})
 await assert.rejects(ports.readFileBytesBounded(fileRef,10,controller.signal),error=>error===reason)
 assert.equal(opened,false)
 await assert.rejects(portsThrowing(new AttachmentError('不得透传的原始内容','ATTACHMENT_CORRUPT')).readFileBytesBounded(fileRef,10),{code:'teloa/source-unavailable',message:'附件内容已不可读取。'})
})

test('readFileBytesBounded 保存每块当时的完整字节，流重用可变缓冲区不篡改前块',async()=>{
 const ports=createAttachmentPorts({readFileStream:async function*(){
  const chunk=Uint8Array.of(1,2)
  yield chunk
  chunk.set([3,4]);yield chunk
 }})
 assert.deepEqual([...await ports.readFileBytesBounded({...fileRef,bytes:4},4)],[1,2,3,4])
})

test('readFileBytesBounded 必须等完整流校验结束，迟到完整性失败不能返回先前字节',async()=>{
 const ports=createAttachmentPorts({readFileStream:async function*(){yield Uint8Array.of(1,2);throw new AttachmentError('完整性失败含源全文','ATTACHMENT_CORRUPT')}})
 await assert.rejects(ports.readFileBytesBounded({...fileRef,bytes:2},2),{code:'teloa/source-unavailable',message:'附件内容已不可读取。'})
})
