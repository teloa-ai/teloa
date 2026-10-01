import {createHash} from 'node:crypto'
import {WorkError,readBusinessImportFileRef,type BusinessImportFilePort,type BusinessImportFileRef} from '@teloa/contract'
import type {AttachmentPorts,SavedFileRef} from './attachments.ts'

const maxFileBytes=2_097_152
const sha256=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
const tooLarge=()=>new WorkError('teloa/invalid-input','导入文件不能超过 2 MiB。',{businessImportIssues:[{code:'file-too-large',message:'导入文件不能超过 2 MiB。'}]})
const corrupt=()=>new WorkError('teloa/storage-corrupt','导入文件内容与已保存来源不一致，请重新上传。')
const invalid=()=>new WorkError('teloa/invalid-input','导入文件内容与声明字节数不一致，请重新选择文件。')

/** 文件身份只从已授权草案交入；原生上传回执本身不授予业务来源权限。 */
export function createBusinessImportFilePort(attachments:AttachmentPorts):BusinessImportFilePort{
 async function read(file:BusinessImportFileRef,signal?:AbortSignal):Promise<Uint8Array>{
  signal?.throwIfAborted()
  const ref=readBusinessImportFileRef(file)
  const nativeRef:SavedFileRef={attachmentId:ref.attachmentId,name:ref.name,bytes:ref.bytes}
  let data:Uint8Array
  try{data=await attachments.readFileBytesBounded(nativeRef,maxFileBytes,signal)}
  catch(error){
   signal?.throwIfAborted()
   if(error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.details?.attachmentByteLimit===maxFileBytes)throw tooLarge()
   throw error
  }
  signal?.throwIfAborted()
  if(data.byteLength>maxFileBytes)throw tooLarge()
  if(data.byteLength!==ref.bytes||sha256(data)!==ref.sha256)throw corrupt()
  return data
 }
 return {
  save:async(input,signal)=>{
   signal?.throwIfAborted()
   if(!Number.isSafeInteger(input.bytes)||input.bytes<0||typeof input.dataBase64!=='string')throw invalid()
   if(input.bytes>maxFileBytes||input.dataBase64.length>4*Math.ceil(maxFileBytes/3)||Buffer.byteLength(input.dataBase64,'base64')>maxFileBytes)throw tooLarge()
   // 规范 base64 由 stage 契约统一校验；此处独立核对实际字节与硬上限。
   const data=Buffer.from(input.dataBase64,'base64')
   if(data.byteLength>maxFileBytes)throw tooLarge()
   if(data.byteLength!==input.bytes)throw invalid()
   const saved=await attachments.saveFile(input.dataBase64,input.name)
   signal?.throwIfAborted()
   const ref=readBusinessImportFileRef({...saved,sha256:sha256(data)})
   if(ref.bytes!==data.byteLength)throw corrupt()
   await read(ref,signal)
   return ref
  },
  read,
 }
}
