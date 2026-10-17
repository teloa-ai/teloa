/** HTTP按句供给；双向会话合并小句，由供应商连续分句。两者都逐字保留、有界且不截断代理对。 */
export function speechSegments(text:string,mode:'sentences'|'continuous'='sentences'):string[]{
 const segments:string[]=[]
 // 连续批次仍限制在480字内，避免把整篇长文积压到供应商或8MiB音频队列。
 const limit=mode==='continuous'?480:160
 let start=0
 while(start<text.length){
  let end=Math.min(start+limit,text.length)
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--
  const candidate=text.slice(start,end),boundaries=[...candidate.matchAll(/[。！？!?；;\n](?:[”’」』）)]+)?/g)]
  const match=mode==='sentences'?boundaries[0]:end<text.length?boundaries.at(-1):undefined
  if(match)end=start+match.index+match[0].length
  const segment=text.slice(start,end)
  // HTTP空白尾段合并到前一句；连续模式保持批次硬上限，媒体层会跳过纯空白批次。
  if(mode==='sentences'&&!segment.trim()&&segments.length)segments[segments.length-1]+=segment
  else segments.push(segment)
  start=end
 }
 return segments
}
