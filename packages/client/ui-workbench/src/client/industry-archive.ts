import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js/lib/zip-core-custom.js'
import { discoverIndustryTemplates, INDUSTRY_FILE_LIMIT, INDUSTRY_TOTAL_LIMIT, validateIndustryPath, type IndustryDiscovery, type IndustryFileInput } from './industry-directory.ts'

/** 仅在内存解包；原生解压流不加载远端 Worker、WASM 或包内脚本。 */
export async function readIndustryArchive(bytes:Uint8Array,name:string):Promise<IndustryDiscovery[]>{
 if(bytes.byteLength>INDUSTRY_TOTAL_LIMIT)throw Error('ZIP 文件不能超过 20 MiB。')
 const reader=new ZipReader(new Uint8ArrayReader(bytes),{useWebWorkers:false,useCompressionStream:true,strictness:'strict',checkCrc32:true,checkOverlappingEntry:true})
 const inputs:IndustryFileInput[]=[],paths=new Set<string>();let total=0,entries=0
 try{
  for await(const entry of reader.getEntriesGenerator()){
   if(++entries>1000)throw Error('ZIP 最多包含 1000 个目录及文件条目。')
   const path=entry.directory?entry.filename.replace(/\/$/,''):entry.filename
   validateIndustryPath(path)
   if(paths.has(path))throw Error('ZIP 路径重复：'+path)
   paths.add(path)
   const type=(entry.externalFileAttributes>>>16)&0xf000
   if(type===0xa000)throw Error('ZIP 不能包含符号链接：'+path)
   if(type&&type!==0x8000&&type!==0x4000)throw Error('ZIP 包含不支持的文件类型：'+path)
   if(entry.encrypted)throw Error('暂不支持加密 ZIP，请先解密后导入。')
   if(entry.directory)continue
   if(inputs.length>=500)throw Error('ZIP 最多包含 500 个文件。')
   if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>INDUSTRY_FILE_LIMIT)throw Error('ZIP 解压单文件不能超过 2 MiB。')
   if(total+entry.uncompressedSize>INDUSTRY_TOTAL_LIMIT)throw Error('ZIP 解压总大小不能超过 20 MiB。')
   if(entry.compressionMethod!==0&&entry.compressionMethod!==8)throw Error('ZIP 仅支持存储或 Deflate 压缩方式。')
   const chunks:Uint8Array[]=[];let size=0
   await entry.getData(new WritableStream<Uint8Array>({write(chunk){
    size+=chunk.byteLength;total+=chunk.byteLength
    if(size>INDUSTRY_FILE_LIMIT||size>entry.uncompressedSize)throw Error('ZIP 解压单文件超出声明大小或 2 MiB 限制。')
    if(total>INDUSTRY_TOTAL_LIMIT)throw Error('ZIP 解压总大小不能超过 20 MiB。')
    chunks.push(Uint8Array.from(chunk))
   }}))
   if(size!==entry.uncompressedSize)throw Error('ZIP 解压大小与声明不一致：'+path)
   const content=new Uint8Array(size);let offset=0
   for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.length}
   inputs.push({path,size,read:async()=>content})
  }
 }catch(error){const message=error instanceof Error?error.message:'无法读取压缩包。';throw Error('ZIP 内容校验失败：'+(message==='Unsafe filename'?'文件路径越界或不安全。':message))}
 finally{await reader.close()}
 return discoverIndustryTemplates(inputs,name)
}
