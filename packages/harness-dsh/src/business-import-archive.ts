import {WorkError} from '@teloa/contract'
import {ZipReader,Uint8ArrayReader,type Entry} from '@zip.js/zip.js/lib/zip-native.js'

export interface BusinessImportArchivePart {path:string;bytes:Uint8Array}
const INPUT_LIMIT=2*1024*1024,FILE_LIMIT=1024*1024,TOTAL_LIMIT=2*1024*1024
function invalid():never {throw new WorkError('teloa/invalid-input','表格文件的压缩结构、路径或大小不受支持，请检查后重新导入。')}
function bounded(value:number|undefined,max:number):number {if(value===undefined||!Number.isSafeInteger(value)||value<0||value>max)invalid();return value}
function checkCancelled(signal?:AbortSignal){signal?.throwIfAborted()}
function same(a:Uint8Array,b:Uint8Array){return a.length===b.length&&a.every((value,index)=>value===b[index])}
function pathKey(entry:Entry):string {
 const path=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(entry.rawFilename)
 if(path!==entry.filename||!path||path.length>300||/[\x00-\x1f\x7f\\:%?#]/u.test(path)||path.startsWith('/'))invalid()
 const name=entry.directory&&path.endsWith('/')?path.slice(0,-1):path
 if(!name||name.split('/').some(segment=>!segment||segment==='.'||segment==='..'))invalid()
 return name.normalize('NFC').toLowerCase()
}
function checkMetadata(entry:Entry,inputLength:number){
 bounded(entry.offset,inputLength);bounded(entry.compressedSize,inputLength);bounded(entry.uncompressedSize,FILE_LIMIT)
 bounded(entry.crc32,0xffffffff)
 const mode=entry.unixMode??0,type=mode&0o170000
 if(entry.encrypted||entry.zipCrypto||entry.zip64||entry.extraFieldZip64||entry.diskNumberStart!==0||entry.symlink||entry.setuid||entry.setgid||entry.sticky||mode&0o7000||(type!==0&&type!==(entry.directory?0o040000:0o100000))||((entry.msdosAttributesRaw??0)&8)||![0,8].includes(entry.compressionMethod)||entry.version<10||entry.version>20||entry.rawBitFlag===undefined||(entry.rawBitFlag&~0x080e)!==0||entry.warnings?.length)invalid()
}
// DirectoryEntry 没有公开 getData；只证明普通零字节 Store 目录的本地头没有 payload。
function directoryEnd(entry:Entry,bytes:Uint8Array):number {
 if(entry.compressionMethod!==0||entry.compressedSize!==0||entry.uncompressedSize!==0||entry.crc32!==0||entry.bitFlag?.dataDescriptor)invalid()
 const start=entry.offset
 if(start+30>bytes.length)invalid()
 const view=new DataView(bytes.buffer,bytes.byteOffset+start,bytes.length-start)
 if(view.getUint32(0,true)!==0x04034b50||view.getUint16(4,true)!==entry.version||view.getUint16(6,true)!==entry.rawBitFlag||view.getUint16(8,true)!==0||view.getUint32(14,true)!==0||view.getUint32(18,true)!==0||view.getUint32(22,true)!==0)invalid()
 const nameLength=view.getUint16(26,true),extraLength=view.getUint16(28,true),end=bounded(start+30+nameLength+extraLength,bytes.length)
 if(!same(bytes.subarray(start+30,start+30+nameLength),entry.rawFilename))invalid()
 // 长度仅用于验证目录 extra 的边界；不解析 payload 或实现中央目录读取。
 let cursor=start+30+nameLength
 while(cursor<end){if(cursor+4>end)invalid();const extra=new DataView(bytes.buffer,bytes.byteOffset+cursor,4);if(extra.getUint16(0,true)===1)invalid();cursor+=4+extra.getUint16(2,true);if(cursor>end)invalid()}
 return end
}

export async function readBusinessImportArchive(bytes:Uint8Array,signal?:AbortSignal):Promise<readonly BusinessImportArchivePart[]> {
 checkCancelled(signal)
 if(!bytes.length||bytes.length>INPUT_LIMIT)invalid()
 // 固定输入快照，防止调用方在异步验证与读取之间改写原数组。
 const input=new Uint8Array(bytes),reader=new ZipReader(new Uint8ArrayReader(input),{strictness:'strict',extractPrependedData:true,extractAppendedData:true,useWebWorkers:false,useCompressionStream:true})
 let result:readonly BusinessImportArchivePart[]|undefined
 try {
  const entries:Entry[]=[]
  for await(const entry of reader.getEntriesGenerator()){checkCancelled(signal);if(entries.length>=64)invalid();entries.push(entry)}
  checkCancelled(signal)
  if(!entries.length||entries.length>64||reader.warnings?.length||reader.prependedData?.length||reader.appendedData?.length)invalid()
  const centralStart=bounded(reader.directoryOffset,input.length),centralLength=bounded(reader.directoryLength,input.length)
  if(centralStart+centralLength>input.length)invalid()
  const names=new Set<string>(),ranges:{start:number;end:number}[]=[]
  let declared=0
  for(const entry of entries){
   checkCancelled(signal);checkMetadata(entry,input.length)
   const key=pathKey(entry);if(names.has(key))invalid();names.add(key)
   declared+=entry.uncompressedSize;if(declared>TOTAL_LIMIT)invalid()
   let end:number
   if(entry.directory)end=directoryEnd(entry,input)
   else {
    await entry.getData(new WritableStream<Uint8Array>(),{...(signal?{signal}:{}),strictness:'strict',checkOverlappingEntryOnly:true,useWebWorkers:false,useCompressionStream:true})
    checkCancelled(signal)
    const local=entry.localDirectory;if(!local||local.version!==entry.version||local.rawBitFlag!==entry.rawBitFlag||local.compressionMethod!==entry.compressionMethod||entry.warnings?.length||local.extraField?.has(1))invalid()
    const dataStart=bounded(local.dataOffset,input.length)
    if(dataStart<entry.offset+30||!local.rawFilename||!same(local.rawFilename,entry.rawFilename))invalid()
    const descriptor=local.dataDescriptor
    if(entry.bitFlag?.dataDescriptor&&(!descriptor||descriptor.crc32!==entry.crc32||descriptor.compressedSize!==entry.compressedSize||descriptor.uncompressedSize!==entry.uncompressedSize))invalid()
    if(!entry.bitFlag?.dataDescriptor&&descriptor)invalid()
    end=bounded(dataStart+entry.compressedSize+(descriptor?(descriptor.signature?16:12):0),input.length)
   }
   if(end>centralStart||end<=entry.offset)invalid()
   ranges.push({start:entry.offset,end})
  }
  ranges.sort((a,b)=>a.start-b.start)
  for(let index=1;index<ranges.length;index++)if(ranges[index]!.start<ranges[index-1]!.end)invalid()
  const parts:BusinessImportArchivePart[]=[];let total=0
  for(const entry of entries){
   checkCancelled(signal);if(entry.directory)continue
   const chunks:Uint8Array[]=[];let actual=0,sinkFailure:unknown
   const sink=new WritableStream<Uint8Array>({write(chunk){
    try {checkCancelled(signal);if(!(chunk instanceof Uint8Array)||actual+chunk.length>entry.uncompressedSize||actual+chunk.length>FILE_LIMIT||total+chunk.length>TOTAL_LIMIT)invalid();actual+=chunk.length;total+=chunk.length;chunks.push(new Uint8Array(chunk))}
    catch(error){sinkFailure=error;throw error}
   }})
   try {await entry.getData(sink,{...(signal?{signal}:{}),strictness:'strict',checkCrc32:true,useWebWorkers:false,useCompressionStream:true})}
   catch(error){if(sinkFailure!==undefined)throw sinkFailure;throw error}
   checkCancelled(signal);if(actual!==entry.uncompressedSize||entry.warnings?.length)invalid()
   const output=new Uint8Array(actual);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}
   parts.push({path:entry.filename,bytes:output})
  }
  checkCancelled(signal);if(!parts.length)invalid();result=parts
 } catch(error){checkCancelled(signal);if(error instanceof WorkError)throw error;invalid()}
 finally {try {await reader.close()}catch {checkCancelled(signal);invalid()}}
 checkCancelled(signal)
 if(!result)invalid()
 return result
}
