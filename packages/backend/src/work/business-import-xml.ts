import {WorkError} from '@teloa/contract'

export interface BusinessImportXmlName {namespace:string;local:string}
export interface BusinessImportXmlAttribute {name:BusinessImportXmlName;value:string}
export type BusinessImportXmlEvent=
 | {type:'start';name:BusinessImportXmlName;position:number;attributes:readonly BusinessImportXmlAttribute[]}
 | {type:'end';name:BusinessImportXmlName;position:number}
 | {type:'text';value:string;position:number}
const XML='http://www.w3.org/XML/1998/namespace'
const XMLNS='http://www.w3.org/2000/xmlns/'
function fail():never{throw new WorkError('teloa/invalid-input','业务表格 XML 格式或大小不符合导入要求。')}
const space=(c:string|undefined)=>c===' '||c==='\t'||c==='\n'||c==='\r'
const xmlCharacter=(n:number)=>n===9||n===10||n===13||(n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff)
const initial=(c:string)=>/^[A-Za-z_]$/.test(c)
const subsequent=(c:string)=>/^[A-Za-z0-9_.-]$/.test(c)

/** 只读取普通 OOXML 所需的闭合 XML 子集；数字文本不参与数值转换。 */
export async function readBusinessImportXml(bytes:Uint8Array,maxBytes:number,signal?:AbortSignal):Promise<readonly BusinessImportXmlEvent[]>{
 signal?.throwIfAborted()
 if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>2*1024*1024||bytes.byteLength>maxBytes)fail()
 let source:string
 try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{fail()}
 if(source.startsWith('\ufeff'))source=source.slice(1)
 if(source.startsWith('\ufeff'))fail()
 const yieldNow=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));signal?.throwIfAborted()}
 // 4096 UTF-16 单位最多占 16KiB UTF-8；全文先验，防止尾部非法字符被忽略。
 let validationYield=4096
 for(let offset=0;offset<source.length;offset++){
  if(offset>=validationYield){await yieldNow();validationYield=offset+4096}
  const point=source.codePointAt(offset)!
  if(!xmlCharacter(point))fail()
  if(point>0xffff)offset++
 }
 source=source.replace(/\r\n?/g,'\n')
 let cursor=0,nextYield=4096,eventYield=256,elements=0,rootSeen=false
 const events:BusinessImportXmlEvent[]=[]
 const frames:{qname:string;name:BusinessImportXmlName;scope:Map<string,string>}[]=[]
 const checkpoint=async()=>{
  if(cursor>=nextYield||events.length>=eventYield){await yieldNow();nextYield=cursor+4096;eventYield=events.length+256}
 }
 const moveTo=async(target:number)=>{
  while(cursor<target){cursor=Math.min(target,cursor+4096);await checkpoint()}
 }
 const whitespace=async()=>{while(space(source[cursor])){cursor++;if(cursor>=nextYield)await checkpoint()}}
 const qname=()=>{
  const start=cursor
  if(!initial(source[cursor]??''))fail()
  cursor++
  while(subsequent(source[cursor]??'')){cursor++;if(cursor-start>64)fail()}
  if(source[cursor]===':'){
   cursor++;if(!initial(source[cursor]??''))fail();cursor++
   while(subsequent(source[cursor]??'')){cursor++;if(cursor-start>64)fail()}
  }
  if(cursor-start>64||source[cursor]===':')fail()
  return source.slice(start,cursor)
 }
 const decode=(raw:string,attribute:boolean)=>{
  let value=''
  for(let index=0;index<raw.length;index++){
   let character=raw[index]!
   if(character==='&'){
    const end=raw.indexOf(';',index+1)
    if(end<0||end-index>32)fail()
    const entity=raw.slice(index+1,end)
    const predefined:Record<string,string>={lt:'<',gt:'>',amp:'&',apos:"'",quot:'"'}
    if(Object.hasOwn(predefined,entity))character=predefined[entity]!
    else{
     const hex=entity.startsWith('#x'),digits=entity.slice(hex?2:1)
     if(!entity.startsWith('#')||!digits||!(hex?/^[0-9a-fA-F]+$/:/^[0-9]+$/).test(digits))fail()
     const point=Number.parseInt(digits,hex?16:10)
     if(!Number.isSafeInteger(point)||!xmlCharacter(point))fail()
     character=String.fromCodePoint(point)
    }
    index=end
   }else if(attribute&&space(character))character=' '
   value+=character
   if(value.length>4000)fail()
  }
  return value
 }
 const quoted=async()=>{
  const quote=source[cursor]
  if(quote!=='"'&&quote!=="'")fail()
  cursor++;const start=cursor
  while(cursor<source.length&&source[cursor]!==quote){
   if(source[cursor]==='<')fail()
   cursor++;if(cursor>=nextYield)await checkpoint()
  }
  if(cursor===source.length)fail()
  const value=decode(source.slice(start,cursor),true);cursor++;return value
 }
 const emit=(event:BusinessImportXmlEvent)=>{if(events.length>=60000)fail();events.push(event)}
 const expand=(raw:string,scope:Map<string,string>,attribute=false):BusinessImportXmlName=>{
  const colon=raw.indexOf(':')
  if(colon<0)return {namespace:attribute?'':scope.get('')??'',local:raw}
  const prefix=raw.slice(0,colon),namespace=scope.get(prefix)
  if(prefix==='xmlns'||!namespace)fail()
  return {namespace,local:raw.slice(colon+1)}
 }
 // 声明是文首的专用语法，其他处理指令一律拒绝。
 if(source.startsWith('<?xml')){
  cursor=5
  const declaration:{key:string;value:string}[]=[]
  while(true){
   const hadSpace=space(source[cursor]);await whitespace()
   if(source.startsWith('?>',cursor)){cursor+=2;break}
   if(!hadSpace)fail()
   const key=qname();await whitespace();if(source[cursor++]!=='=')fail();await whitespace()
   // 声明值不接受实体引用。
   const start=cursor,value=await quoted()
   if(source.slice(start,cursor).includes('&'))fail()
   declaration.push({key,value});if(declaration.length>3)fail()
  }
  if(declaration[0]?.key!=='version'||declaration[0]?.value!=='1.0')fail()
  let next=1
  if(declaration[next]?.key==='encoding'){if(declaration[next]!.value.toLowerCase()!=='utf-8')fail();next++}
  if(declaration[next]?.key==='standalone'){if(!['yes','no'].includes(declaration[next]!.value))fail();next++}
  if(next!==declaration.length)fail()
 }
 while(cursor<source.length){
  await checkpoint()
  const position=cursor
  if(source.startsWith('<!--',cursor)){
   const end=source.indexOf('-->',cursor+4)
   if(end<0)fail()
   const content=source.slice(cursor+4,end)
   if(content.includes('--')||content.endsWith('-'))fail()
   await moveTo(end+3);continue
  }
  if(source[cursor]!=='<'){
   const end=source.indexOf('<',cursor),target=end<0?source.length:end
   await moveTo(target)
   const raw=source.slice(position,cursor)
   if(!frames.length){for(const character of raw)if(!space(character))fail();continue}
   if(raw.includes(']]>'))fail()
   emit({type:'text',value:decode(raw,false),position});continue
  }
  cursor++
  if(source[cursor]==='/'){
   cursor++;const raw=qname();await whitespace();if(source[cursor++]!=='>')fail()
   const frame=frames.pop();if(!frame||frame.qname!==raw)fail()
   emit({type:'end',name:frame.name,position});continue
  }
  if(source[cursor]==='!'||source[cursor]==='?')fail()
  if(!frames.length){if(rootSeen)fail();rootSeen=true}
  if(frames.length>=16||++elements>20000)fail()
  const raw=qname(),attributes:{raw:string;value:string}[]=[],rawNames=new Set<string>()
  let empty=false
  while(true){
   const separated=space(source[cursor]);await whitespace()
   if(source[cursor]==='>'){cursor++;break}
   if(source.startsWith('/>',cursor)){cursor+=2;empty=true;break}
   if(!separated||attributes.length>=24)fail()
   const name=qname();if(rawNames.has(name))fail();rawNames.add(name)
   await whitespace();if(source[cursor++]!=='=')fail();await whitespace()
   attributes.push({raw:name,value:await quoted()})
  }
  const scope=new Map(frames.at(-1)?.scope??[['xml',XML]])
  for(const attribute of attributes){
   if(attribute.raw==='xmlns'||attribute.raw.startsWith('xmlns:')){
    const prefix=attribute.raw==='xmlns'?'':attribute.raw.slice(6),uri=attribute.value
    if(prefix==='xmlns'||uri===XMLNS||(prefix==='xml'?uri!==XML:uri===XML)||(prefix!==''&&uri===''))fail()
    scope.set(prefix,uri)
   }
  }
  const name=expand(raw,scope),expanded:BusinessImportXmlAttribute[]=[],names=new Set<string>()
  for(const attribute of attributes){
   if(attribute.raw==='xmlns'||attribute.raw.startsWith('xmlns:'))continue
   const name=expand(attribute.raw,scope,true),identity=JSON.stringify([name.namespace,name.local])
   if(names.has(identity))fail();names.add(identity);expanded.push({name,value:attribute.value})
  }
  emit({type:'start',name,position,attributes:expanded})
  if(empty)emit({type:'end',name,position})
  else frames.push({qname:raw,name,scope})
 }
 if(!rootSeen||frames.length)fail()
 signal?.throwIfAborted()
 return events
}
