import {WorkError,retrievalLimits,type RetrievalSearchResult} from '@teloa/contract'

type Hit=RetrievalSearchResult['results'][number]
type Origin={hit:Hit;order:number}
type Section={start:number;end:number;startLine:number;text:string;origins:Origin[]}
const corrupt=()=>new WorkError('teloa/storage-corrupt','检索摘录与原文位置不一致，已停止合并。')
const newlines=(text:string)=>text.split('\n').length-1
const priority=(a:Origin,b:Origin)=>b.hit.score-a.hit.score||a.order-b.order

/** 返回完整 Unicode 码点组成的前缀；字符位置仍使用原文的 UTF-16 半开区间。 */
function bytePrefix(text:string,maximum:number):string{
 let chars=0,bytes=0
 for(const point of text){const size=Buffer.byteLength(point,'utf8');if(bytes+size>maximum)break;chars+=point.length;bytes+=size}
 return text.slice(0,chars)
}

/**
 * 仅在权限、版本复核后的有界原文摘录上消除同一正文的重复区间。
 * 同 sourceId/sourceVersion 的真实重叠逐字核对后合并；不同事实、来源或正文版本保持独立。
 * 每个无重叠输出窗沿用覆盖它的原命中最高余弦，不相加，也不声称全库多样化。
 */
export function coalesceRetrievalEvidence(hits:readonly Hit[],limit:number):Hit[]{
 if(!Number.isSafeInteger(limit)||limit<1||limit>retrievalLimits.maxResults||hits.length>retrievalLimits.maxResults)throw corrupt()
 const groups=new Map<string,Origin[]>()
 hits.forEach((hit,order)=>{
  if(!Number.isFinite(hit.score)||hit.score< -1||hit.score>1||hit.excerpt.length!==hit.chars[1]-hit.chars[0]||hit.lines[1]!==hit.lines[0]+newlines(hit.excerpt.slice(0,-1))||Buffer.byteLength(hit.excerpt,'utf8')>retrievalLimits.maxExcerptBytes)throw corrupt()
  const key=JSON.stringify([hit.sourceId,hit.sourceVersion]),group=groups.get(key)??[]
  group.push({hit,order});groups.set(key,group)
 })
 const sections:Section[]=[]
 for(const group of groups.values()){
  group.sort((a,b)=>a.hit.chars[0]-b.hit.chars[0]||a.hit.chars[1]-b.hit.chars[1]||a.order-b.order)
  let section:Section|undefined
  for(const origin of group){
   const hit=origin.hit,[start,end]=hit.chars
   if(!section||start>=section.end){section={start,end,startLine:hit.lines[0],text:hit.excerpt,origins:[origin]};sections.push(section);continue}
   const offset=start-section.start,overlap=Math.min(section.end,end)-start
   if(section.text.slice(offset,offset+overlap)!==hit.excerpt.slice(0,overlap)||hit.lines[0]!==section.startLine+newlines(section.text.slice(0,offset)))throw corrupt()
   if(end>section.end){section.text+=hit.excerpt.slice(section.end-start);section.end=end}
   section.origins.push(origin)
  }
 }
 const windows:{hit:Hit;order:number}[]=[]
 for(const section of sections){
  let offset=0,line=section.startLine
  while(offset<section.text.length){
   const excerpt=bytePrefix(section.text.slice(offset),retrievalLimits.maxExcerptBytes)
   if(!excerpt)throw corrupt()
   const start=section.start+offset,end=start+excerpt.length,startLine=line,endLine=line+newlines(excerpt.slice(0,-1))
   offset+=excerpt.length;line+=newlines(excerpt)
   if(!excerpt.trim())continue
   const origin=section.origins.filter(({hit})=>hit.chars[0]<end&&hit.chars[1]>start).sort(priority)[0]
   if(!origin)throw corrupt()
   const h=origin.hit
   // 引用由宿主按新窗口生成，不能沿用输入中可能属于旧区间的 citationPath。
   windows.push({order:origin.order,hit:{resourceId:h.resourceId,resourceVersion:h.resourceVersion,title:h.title,sourceId:h.sourceId,sourceVersion:h.sourceVersion,heading:h.heading,score:h.score,chars:[start,end],lines:[startLine,endLine],excerpt}})
  }
 }
 return windows.sort((a,b)=>b.hit.score-a.hit.score||a.order-b.order||a.hit.chars[0]-b.hit.chars[0]).slice(0,limit).map(row=>row.hit)
}
