import {WorkError} from '@teloa/contract'

/** 落盘后的图片事实（DSH 归一化之后的真实字节与像素），只留读回所需的五个键。 */
export type SavedImageRef={attachmentId:string;mediaType:string;bytes:number;width:number;height:number}
/** 落盘后的文件事实；`name` 是 DSH 清洗过的叶名，读回时必须逐字带回。 */
export type SavedFileRef={attachmentId:string;name:string;bytes:number}
export type AttachmentPorts={
 saveImage:(dataBase64:string,mediaType:string,name:string)=>Promise<SavedImageRef>
 saveFile:(dataBase64:string,name:string)=>Promise<SavedFileRef>
 readImageBytes:(ref:SavedImageRef,signal?:AbortSignal)=>Promise<Uint8Array>
 /** `maxBytes` 给了就只读前这么多字节，读够即停（文本附件取正文只要前段，不必把整份文件读进内存）。 */
 readFileBytes:(ref:SavedFileRef,signal?:AbortSignal,maxBytes?:number)=>Promise<Uint8Array>
 /** 必须读完整文件；实际流超过 limit 就拒绝并关闭，绝不返回前缀。 */
 readFileBytesBounded:(ref:SavedFileRef,limit:number,signal?:AbortSignal)=>Promise<Uint8Array>
}

/** `ctx.attachments` 里本端口用到的四个方法；结构化窄化，不从 `@deepseek-ai/dsh-attachment` 取类型。 */
type DshAttachmentStore={
 saveImage:(input:{data:Uint8Array;mediaType:string;name?:string})=>Promise<SavedImageRef&{name?:string}>
 readImage:(ref:SavedImageRef,signal?:AbortSignal)=>Promise<{data:Uint8Array}>
 saveFile:(input:{data:Uint8Array;name?:string})=>Promise<SavedFileRef>
 readFileStream:(ref:SavedFileRef,signal?:AbortSignal)=>AsyncIterable<Uint8Array>
}

const invalidInputCodes=['TOO_MANY_IMAGES','IMAGES_TOO_LARGE','UNSUPPORTED_IMAGE_TYPE','INVALID_IMAGE_BASE64','INVALID_IMAGE','IMAGE_TYPE_MISMATCH','IMAGE_TOO_LARGE','IMAGE_TOO_MANY_PIXELS','IMAGE_DIMENSION_TOO_LARGE','INVALID_FILE_BASE64','INVALID_ATTACHMENT_REF']
const unreadableCodes=['ATTACHMENT_NOT_FOUND','ATTACHMENT_CORRUPT','ATTACHMENT_READ_FAILED']

const invalidInput=()=>new WorkError('teloa/invalid-input','附件内容不符合要求，请换一个文件再试。')
class AttachmentByteLimitError extends WorkError{
 constructor(limit:number){super('teloa/invalid-input','附件文件超过允许的大小，请换一个文件再试。',{attachmentByteLimit:limit})}
}

/**
 * 把 DSH 的 `AttachmentError` 折成三个正式码。DSH 的 `code` 只用来选映射，
 * 既不进 `message` 也不进 `details`。`ATTACHMENT_WRITE_FAILED`、
 * `ATTACHMENT_FILES_UNSUPPORTED`、`ATTACHMENT_PROJECTION_UNSUPPORTED`
 * 与认不出的失败同一口径：算存储不可用，不猜成可纠正的输入问题。
 */
function refuse(error:unknown):never{
 const code=typeof error==='object'&&error!==null&&'code' in error&&typeof (error as {code:unknown}).code==='string'?(error as {code:string}).code:''
 if(invalidInputCodes.includes(code))throw invalidInput()
 if(unreadableCodes.includes(code))throw new WorkError('teloa/source-unavailable','附件内容已不可读取。')
 throw new WorkError('teloa/dependency-unavailable','附件存储当前不可用，请稍后再试。')
}

/**
 * 只解码，不判规范性。规范 base64 由契约的 `attachmentBase64()` 在入口逐字判过
 * （长度、字符集、填充与声明字节数四条），两份不同的文本落到同一份字节上这件事
 * 在解析器那一层已经不可能发生；端口再判一次只会让同一条判据有两个说法。
 */
function decode(dataBase64:string):Uint8Array{
 if(typeof dataBase64!=='string')throw invalidInput()
 return Buffer.from(dataBase64,'base64')
}

/** 等待分块时仍可取消；官方流收到同一信号，迭代器也在退出时收回。 */
async function nextChunk(iterator:AsyncIterator<Uint8Array>,signal?:AbortSignal):Promise<IteratorResult<Uint8Array>>{
 if(!signal)return iterator.next()
 signal.throwIfAborted()
 let abort!:()=>void
 const cancelled=new Promise<never>((_resolve,reject)=>{
  abort=()=>reject(signal.reason)
  signal.addEventListener('abort',abort,{once:true})
 })
 try{return await Promise.race([iterator.next(),cancelled])}
 finally{signal.removeEventListener('abort',abort)}
}

async function readBounded(attachments:DshAttachmentStore,ref:SavedFileRef,limit:number,signal?:AbortSignal):Promise<Uint8Array>{
 signal?.throwIfAborted()
 const iterator=attachments.readFileStream(ref,signal)[Symbol.asyncIterator]()
 const chunks:Uint8Array[]=[]
 let total=0,complete=false
 try{
  for(;;){
   const part=await nextChunk(iterator,signal)
   signal?.throwIfAborted()
   if(part.done){complete=true;break}
   if(part.value.byteLength>limit-total)throw new AttachmentByteLimitError(limit)
   total+=part.value.byteLength
   if(part.value.byteLength)chunks.push(Buffer.from(part.value))
  }
  return Buffer.concat(chunks,total)
 }finally{
  if(!complete&&iterator.return){
   const closing=iterator.return()
   // 取消不能被不响应信号的端口拖住；官方流按同一信号结束，return 同时请求关流。
   if(signal?.aborted)void Promise.resolve(closing).catch(()=>{})
   else await closing
  }
 }
}

/**
 * 把 DSH 已挂载的附件仓收成窄端口：字节进、字节出，不含任何业务判据
 * （许可、配额、MIME 白名单、去重口径都在调用方）。`store` 取 `unknown`，
 * 这样本包不引入 `@deepseek-ai/dsh-attachment` 依赖。
 */
export function createAttachmentPorts(store:unknown):AttachmentPorts{
 const attachments=store as DshAttachmentStore
 return {
  saveImage:async(dataBase64,mediaType,name)=>{
   const data=decode(dataBase64)
   try{
    const ref=await attachments.saveImage({data,mediaType,name})
    return {attachmentId:ref.attachmentId,mediaType:ref.mediaType,bytes:ref.bytes,width:ref.width,height:ref.height}
   }catch(error){refuse(error)}
  },
  saveFile:async(dataBase64,name)=>{
   const data=decode(dataBase64)
   try{
    const ref=await attachments.saveFile({data,name})
    return {attachmentId:ref.attachmentId,name:ref.name,bytes:ref.bytes}
   }catch(error){refuse(error)}
  },
  readImageBytes:async(ref,signal)=>{
   try{return (await attachments.readImage(ref,signal)).data}
   catch(error){refuse(error)}
  },
  readFileBytes:async(ref,signal,maxBytes)=>{
   try{
    const chunks:Uint8Array[]=[]
    let total=0
    // 提前 break 会经迭代器的 return() 关掉底层读流，不留半开的文件句柄。
    for await(const chunk of attachments.readFileStream(ref,signal)){
     chunks.push(chunk);total+=chunk.byteLength
     if(maxBytes!==undefined&&total>=maxBytes)break
    }
    const bytes=Buffer.concat(chunks)
    return maxBytes!==undefined&&bytes.length>maxBytes?bytes.subarray(0,maxBytes):bytes
   }catch(error){refuse(error)}
  },
  readFileBytesBounded:async(ref,limit,signal)=>{
   signal?.throwIfAborted()
   if(!Number.isSafeInteger(limit)||limit<0)throw invalidInput()
   try{return await readBounded(attachments,ref,limit,signal)}
   catch(error){signal?.throwIfAborted();if(error instanceof AttachmentByteLimitError)throw error;refuse(error)}
  },
 }
}
