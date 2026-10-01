import assert from 'node:assert/strict'
import test from 'node:test'
import {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader} from '@zip.js/zip.js/lib/zip-native.js'
import {readBusinessImportArchive} from '../src/business-import-archive.ts'
async function archive(level:number){const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false,useCompressionStream:true,dataDescriptor:false});await writer.add('xl/a.xml',new Uint8ArrayReader(new Uint8Array([0,255,13,10])),{level});await writer.add('xl/b.xml',new Uint8ArrayReader(new TextEncoder().encode('原始001 ')),{level});return writer.close()}
for(const level of [0,6])test(`Store/Deflate ${level} 保留完整原字节`,async()=>{assert.deepEqual(await readBusinessImportArchive(await archive(level)),[{path:'xl/a.xml',bytes:new Uint8Array([0,255,13,10])},{path:'xl/b.xml',bytes:new TextEncoder().encode('原始001 ')}])})

import {WorkError} from '@teloa/contract'
import {ZipReader,type ZipWriterAddDataOptions} from '@zip.js/zip.js/lib/zip-native.js'
const encoder=new TextEncoder(),LIMIT=1024*1024
async function make(items:{path:string;bytes?:Uint8Array;options?:ZipWriterAddDataOptions}[],options:ZipWriterAddDataOptions={}){
 const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false,useCompressionStream:true,dataDescriptor:false,...options})
 for(const item of items)await writer.add(item.path,item.bytes===undefined?undefined:new Uint8ArrayReader(item.bytes),{level:options.level??6,...item.options})
 return writer.close()
}
async function bad(bytes:Uint8Array){await assert.rejects(readBusinessImportArchive(bytes),error=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.message==='表格文件的压缩结构、路径或大小不受支持，请检查后重新导入。')}
function records(bytes:Uint8Array,signature:number){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),result:number[]=[];for(let i=0;i+4<=bytes.length;i++)if(view.getUint32(i,true)===signature)result.push(i);return result}
function mutate(bytes:Uint8Array,change:(view:DataView,local:number[],central:number[])=>void){const copy=bytes.slice();change(new DataView(copy.buffer),records(copy,0x04034b50),records(copy,0x02014b50));return copy}
const small=()=>make([{path:'xl/a.xml',bytes:encoder.encode('first')},{path:'unused.bin',bytes:encoder.encode('unselected')}],{level:0})

test('普通目录与零字节文件保留文件部件，descriptor两种签名均完整读取',async()=>{
 for(const signature of [true,false]){const bytes=await make([{path:'xl/',options:{directory:true}},{path:'xl/empty.xml',bytes:new Uint8Array()},{path:'xl/a.xml',bytes:encoder.encode('001'),options:{dataDescriptor:true,dataDescriptorSignature:signature}}]);assert.deepEqual(await readBusinessImportArchive(bytes),[{path:'xl/empty.xml',bytes:new Uint8Array()},{path:'xl/a.xml',bytes:encoder.encode('001')}])}
})
test('全部部件CRC均验证，未选部件损坏整包拒绝',async()=>{
 const source=await small(),reader=new ZipReader(new Uint8ArrayReader(source));const entries=await reader.getEntries(),entry=entries[1];assert.ok(entry&&!entry.directory);await entry.getData(new WritableStream(),{checkOverlappingEntryOnly:true});assert.ok(entry.localDirectory);const offset=entry.localDirectory.dataOffset;await reader.close();const bytes=source.slice();bytes[offset]=bytes[offset]!^1;await bad(bytes)
})
for(const path of ['../a','a/../b','./a','/a','a//b','a\\b','C:a','a%2fb','a?b','a#b','a\0b','a\u001fb','a\u007fb','a'.repeat(301)])test(`非法原路径 ${JSON.stringify(path)}`,async()=>{await bad(await make([{path,bytes:encoder.encode('x')}]))})
for(const paths of [['a','A'],['é','e\u0301'],['a/','a']])test(`原名/NFC/case/目录文件冲突 ${JSON.stringify(paths)}`,async()=>{await bad(await make(paths.map(path=>({path,...(path.endsWith('/')?{options:{directory:true}}:{bytes:encoder.encode('x')})}))))})
test('重复中央目录名字拒绝',async()=>{await bad(mutate(await make([{path:'a',bytes:encoder.encode('x')},{path:'b',bytes:encoder.encode('y')}]),(v,l,c)=>{v.setUint8(l[1]!+30,97);v.setUint8(c[1]!+46,97)}))})
test('固定UTF8旗标中文原名保持，非旗标编码别名与非法UTF8拒绝',async()=>{
 const chinese=await make([{path:'客户.xml',bytes:encoder.encode('x')}]),chineseView=new DataView(chinese.buffer)
 for(const offset of records(chinese,0x04034b50))assert.equal(chineseView.getUint16(offset+6,true)&0x800,0x800)
 for(const offset of records(chinese,0x02014b50))assert.equal(chineseView.getUint16(offset+8,true)&0x800,0x800)
 assert.equal((await readBusinessImportArchive(chinese))[0]!.path,'客户.xml')
 const alias=mutate(chinese,(v,l,c)=>{v.setUint16(l[0]!+6,v.getUint16(l[0]!+6,true)&~0x800,true);v.setUint16(c[0]!+8,v.getUint16(c[0]!+8,true)&~0x800,true)})
 const aliasView=new DataView(alias.buffer);assert.equal(aliasView.getUint16(records(alias,0x04034b50)[0]!+6,true)&0x800,0);assert.equal(aliasView.getUint16(records(alias,0x02014b50)[0]!+8,true)&0x800,0)
 await bad(alias)
 const ascii=await make([{path:'a',bytes:encoder.encode('x')}]),asciiView=new DataView(ascii.buffer)
 assert.equal(asciiView.getUint16(records(ascii,0x04034b50)[0]!+6,true)&0x800,0);assert.equal(asciiView.getUint16(records(ascii,0x02014b50)[0]!+8,true)&0x800,0)
 assert.equal((await readBusinessImportArchive(ascii))[0]!.path,'a')
 const invalidUtf8=mutate(ascii,(v,l,c)=>{v.setUint16(l[0]!+6,0x800,true);v.setUint16(c[0]!+8,0x800,true);v.setUint8(l[0]!+30,0xff);v.setUint8(c[0]!+46,0xff)})
 const invalidView=new DataView(invalidUtf8.buffer);assert.equal(invalidView.getUint16(records(invalidUtf8,0x04034b50)[0]!+6,true)&0x800,0x800);assert.equal(invalidView.getUint16(records(invalidUtf8,0x02014b50)[0]!+8,true)&0x800,0x800)
 await bad(invalidUtf8)
})
test('输入/空包/包含目录的条目预算拒绝',async()=>{
 await bad(new Uint8Array());await bad(new Uint8Array(2*LIMIT+1));await bad(await make([]));await bad(await make([{path:'only/',options:{directory:true}}]));await bad(await make(Array.from({length:65},(_,i)=>({path:`d${i}/`,options:{directory:true}}))))
})
test('单文件与全包声明展开预算各自拒绝，小压缩工件',async()=>{
 await bad(await make([{path:'large',bytes:new Uint8Array(LIMIT+1)}]));await bad(await make(Array.from({length:3},(_,i)=>({path:`part${i}`,bytes:new Uint8Array(750000)}))))
})
test('实际输出超过伪造声明时保留固定业务错误',async()=>{
 const source=await make([{path:'a',bytes:new Uint8Array(10000)}]);await bad(mutate(source,(v,l,c)=>{v.setUint32(l[0]!+22,1,true);v.setUint32(c[0]!+24,1,true)}))
})
test('实际输出少于伪造声明拒绝',async()=>{await bad(mutate(await small(),(v,l,c)=>{v.setUint32(l[0]!+22,100,true);v.setUint32(c[0]!+24,100,true)}))})
test('local与central名字/flags/method/size分别不一致拒绝',async()=>{
 const source=await small();for(const change of [(v:DataView,l:number[])=>v.setUint8(l[0]!+30,98),(v:DataView,l:number[])=>v.setUint16(l[0]!+6,0x800,true),(v:DataView,l:number[])=>v.setUint16(l[0]!+8,8,true),(v:DataView,l:number[])=>v.setUint32(l[0]!+22,10,true)])await bad(mutate(source,change))
})
test('全部文件本地范围重叠在输出前拒绝',async()=>{await bad(mutate(await small(),(v,l,c)=>{const size=l[1]!-l[0]!;v.setUint32(l[0]!+18,size,true);v.setUint32(l[0]!+22,size,true);v.setUint32(c[0]!+20,size,true);v.setUint32(c[0]!+24,size,true)}))})
test('零目录头与文件范围重叠拒绝',async()=>{
 const source=await make([{path:'dir/',options:{directory:true}},{path:'a',bytes:encoder.encode('x')}]);await bad(mutate(source,(v,l)=>{const start=l[0]!+30+v.getUint16(l[0]!+26,true);v.setUint16(l[0]!+28,l[1]!-start+10,true);v.setUint16(start,0xeeee,true);v.setUint16(start+2,l[1]!-start+6,true)}))
})
test('目录CRC/flags/名字/压缩/descriptor/损坏extra逐项拒绝',async()=>{
 const source=await make([{path:'dir/',options:{directory:true}},{path:'a',bytes:encoder.encode('x')}]);
 const changes=[(v:DataView,l:number[])=>v.setUint32(l[0]!+14,1,true),(v:DataView,l:number[])=>v.setUint16(l[0]!+6,0x800,true),(v:DataView,l:number[])=>v.setUint8(l[0]!+30,98),(v:DataView,l:number[],c:number[])=>{v.setUint16(l[0]!+8,8,true);v.setUint16(c[0]!+10,8,true)},(v:DataView,l:number[],c:number[])=>{v.setUint16(l[0]!+6,8,true);v.setUint16(c[0]!+8,8,true)},(v:DataView,l:number[])=>v.setUint16(l[0]!+30+4+2,0xffff,true)]
 for(const change of changes)await bad(mutate(source,change))
})
test('未知压缩/加密/ZIP64/多盘/链接/特殊mode/未知版本拒绝',async()=>{
 const source=await small();const changes=[(v:DataView,l:number[],c:number[])=>{v.setUint16(l[0]!+8,99,true);v.setUint16(c[0]!+10,99,true)},(v:DataView,l:number[],c:number[])=>{v.setUint16(l[0]!+6,1,true);v.setUint16(c[0]!+8,1,true)},(v:DataView,l:number[],c:number[])=>v.setUint32(c[0]!+24,0xffffffff,true),(v:DataView,l:number[],c:number[])=>v.setUint16(c[0]!+34,1,true),(v:DataView,l:number[],c:number[])=>v.setUint32(c[0]!+38,0o120777*65536,true),(v:DataView,l:number[],c:number[])=>v.setUint32(c[0]!+38,0o106644*65536,true),(v:DataView,l:number[],c:number[])=>{v.setUint16(l[0]!+4,99,true);v.setUint16(c[0]!+6,99,true)}]
 for(const change of changes)await bad(mutate(source,change))
})
test('descriptor值不一致、非致命malformed extra及前后缀拒绝',async()=>{
 const source=await make([{path:'a',bytes:encoder.encode('x'),options:{dataDescriptor:true}}]);const descriptor=records(source,0x08074b50)[0]!;const corrupted=source.slice();new DataView(corrupted.buffer).setUint32(descriptor+4,123,true);await bad(corrupted)
 await bad(mutate(await small(),(v,l,c)=>{v.setUint16(l[0]!+30+v.getUint16(l[0]!+26,true)+2,0xffff,true);v.setUint16(c[0]!+46+v.getUint16(c[0]!+28,true)+2,0xffff,true)}))
 const ordinary=await small();const prefix=new Uint8Array(ordinary.length+1);prefix.set(ordinary,1);await bad(prefix);const suffix=new Uint8Array(ordinary.length+1);suffix.set(ordinary);await bad(suffix)
})
test('预取消及native流在途取消保留原reason',async()=>{
 const pre=new AbortController(),reason={cancelled:'original'};pre.abort(reason);await assert.rejects(readBusinessImportArchive(await small(),pre.signal),error=>error===reason)
 const input=await make([{path:'a',bytes:new Uint8Array(LIMIT)},{path:'b',bytes:new Uint8Array(LIMIT)}]),active=new AbortController();const pending=readBusinessImportArchive(input,active.signal);const timer=setTimeout(()=>active.abort(reason),0);try{await assert.rejects(pending,error=>error===reason)}finally{clearTimeout(timer)}
})

test('收口完成至最终返回之间取消仍保留原reason',async()=>{
 const input=await small(),controller=new AbortController(),reason={cancelled:'during-close'},original=ZipReader.prototype.close
 ZipReader.prototype.close=async function(){const result=await original.call(this);controller.abort(reason);return result}
 try{await assert.rejects(readBusinessImportArchive(input,controller.signal),error=>error===reason)}finally{ZipReader.prototype.close=original}
})
test('文件local未知版本独立拒绝',async()=>{await bad(mutate(await small(),(v,l)=>v.setUint16(l[0]!+4,99,true)))})
test('Node Buffer调用方异步改写不会污染已固定输入',async()=>{
 const source=Buffer.from(await small()),pending=readBusinessImportArchive(source);source.fill(0);assert.deepEqual((await pending).map(part=>part.path),['xl/a.xml','unused.bin'])
})
test('close原生错误不向业务暴露',async()=>{
 const input=await small(),original=ZipReader.prototype.close;ZipReader.prototype.close=async function(){await original.call(this);throw new Error('private zip detail')}
 try{await bad(input)}finally{ZipReader.prototype.close=original}
})

test('公开generator枚举逐项检查取消，不先收集完整条目',async()=>{
 const input=await small(),controller=new AbortController(),reason={cancelled:'enumeration'},original=ZipReader.prototype.getEntriesGenerator;let yielded=0
 ZipReader.prototype.getEntriesGenerator=async function*(options){for await(const entry of original.call(this,options)){yielded++;if(yielded===1)controller.abort(reason);yield entry}return true}
 try{await assert.rejects(readBusinessImportArchive(input,controller.signal),error=>error===reason);assert.equal(yielded,1)}finally{ZipReader.prototype.getEntriesGenerator=original}
})
