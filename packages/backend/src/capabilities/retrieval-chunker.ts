import {createHash} from 'node:crypto'

/**
 * 端侧中文检索分块器 `teloa.chunk.zh/v1`（规格 §6.4）。
 *
 * 规范化换行后按 Markdown 标题与空行切段，段落按字符数合并：目标 300、上限 450；
 * 单个段落超过上限时在句末优先切开，相邻块重叠 60 字。区间以规范化文本的 UTF-16 下标计（半开），
 * 行号从 0 起、含首尾；索引只存区间与摘要，命中后按区间回读原文。参数全部进入版本串，改参数即新索引。
 */
export const retrievalChunkerParameters={target:300,max:450,overlap:60,headingMax:200} as const
const {target,max,overlap,headingMax}=retrievalChunkerParameters
export const retrievalChunker=`teloa.chunk.zh/v1;target=${target};max=${max};overlap=${overlap};heading=${headingMax}`

export type RetrievalChunk={ordinal:number;start:number;end:number;startLine:number;endLine:number;heading:string|null;text:string;textSha256:string}

export const normalizeRetrievalText=(text:string)=>text.replace(/\r\n?/g,'\n')

const headingLine=/^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const fenceLine=/^ {0,3}(?:```|~~~)/
const sentenceEnd=new Set(['。','！','？','；','!','?',';','\n'])
const isHigh=(code:number)=>code>=0xd800&&code<=0xdbff
const isLow=(code:number)=>code>=0xdc00&&code<=0xdfff

function headingPath(titles:string[]):string|null{
 const path=titles.filter(Boolean).join(' > ')
 if(!path)return null
 if(path.length<=headingMax)return path
 let cut=''
 for(const point of path){if(cut.length+point.length>headingMax-1)break;cut+=point}
 return cut.trimEnd()+'…'
}

type Section={start:number;end:number;heading:string|null;paragraphs:[number,number][]}

function sections(text:string):Section[]{
 const result:Section[]=[],stack:{level:number;title:string}[]=[]
 let current:Section={start:0,end:0,heading:null,paragraphs:[]},paragraph:[number,number]|null=null,fenced=false,offset=0
 const close=()=>{if(paragraph){current.paragraphs.push(paragraph);paragraph=null}}
 for(const line of text.split('\n')){
  const lineStart=offset,lineEnd=offset+line.length
  offset=lineEnd+1
  const match=fenced?null:headingLine.exec(line)
  if(fenceLine.test(line))fenced=!fenced
  if(match){
   close();current.end=lineStart;result.push(current)
   const level=match[1]!.length,title=(match[2]??'').replace(/[ \t]+#+[ \t]*$/,'').replace(/^#+$/,'').trim()
   while(stack.length&&stack.at(-1)!.level>=level)stack.pop()
   stack.push({level,title})
   current={start:lineStart,end:lineStart,heading:headingPath(stack.map(item=>item.title)),paragraphs:[]}
  }
  if(!line.trim()){close();continue}
  paragraph=paragraph?[paragraph[0],lineEnd]:[lineStart,lineEnd]
 }
 close();current.end=text.length;result.push(current)
 return result.filter(section=>section.paragraphs.length>0)
}

function cutPoint(text:string,start:number):number{
 for(let index=start+target;index>=start+target/2;index--)if(sentenceEnd.has(text[index-1]!))return index
 for(let index=start+target+1;index<=start+max;index++)if(sentenceEnd.has(text[index-1]!))return index
 const end=start+target
 return isHigh(text.charCodeAt(end-1))?end-1:end
}

/** 输入不变时输出确定；空白文本不产生分块。 */
export function chunkRetrievalText(input:string):RetrievalChunk[]{
 const text=normalizeRetrievalText(input),ranges:{start:number;end:number;heading:string|null}[]=[]
 const emit=(start:number,end:number,heading:string|null)=>{
  while(start<end&&/\s/.test(text[start]!))start++
  while(end>start&&/\s/.test(text[end-1]!))end--
  if(end>start)ranges.push({start,end,heading})
 }
 for(const section of sections(text)){
  let current:[number,number]|null=null
  for(const [paragraphStart,paragraphEnd] of section.paragraphs){
   if(current&&current[1]-current[0]<target&&paragraphEnd-current[0]<=max){current=[current[0],paragraphEnd];continue}
   if(current)emit(current[0],current[1],section.heading)
   let position=paragraphStart
   while(paragraphEnd-position>max){
    const end=cutPoint(text,position)
    emit(position,end,section.heading)
    let next=end-overlap
    if(isLow(text.charCodeAt(next)))next--
    position=Math.max(next,position+1)
   }
   current=[position,paragraphEnd]
  }
  if(current)emit(current[0],current[1],section.heading)
 }
 const newlines:number[]=[]
 for(let index=text.indexOf('\n');index>=0;index=text.indexOf('\n',index+1))newlines.push(index)
 const lineOf=(position:number)=>{let low=0,high=newlines.length;while(low<high){const middle=(low+high)>>1;if(newlines[middle]!<position)low=middle+1;else high=middle}return low}
 return ranges.map((range,ordinal)=>{
  const value=text.slice(range.start,range.end)
  return {ordinal,start:range.start,end:range.end,startLine:lineOf(range.start),endLine:lineOf(range.end-1),heading:range.heading,text:value,textSha256:createHash('sha256').update(value).digest('hex')}
 })
}
