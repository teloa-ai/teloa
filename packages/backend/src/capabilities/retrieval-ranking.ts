/** DB 已过滤可见候选之后的纯余弦排序；不承担授权，也不扩大公开查询条数。 */
export type RankedChunk={ordinal:number;start:number;end:number;startLine:number;endLine:number;heading:string|null}
export type RankedIndex={vectors:Float32Array;norms:Float32Array;chunks:RankedChunk[]}
export function rankRetrievalVectors<T extends {resourceId:string}>(queryVector:Float32Array,entries:readonly {row:T;index:RankedIndex}[],limit:number){
 if(!Number.isSafeInteger(limit)||limit<1)throw new Error('排序条数必须为正整数。')
 const dimensions=queryVector.length
 let queryNorm=0
 for(let d=0;d<dimensions;d++)queryNorm+=queryVector[d]!*queryVector[d]!
 queryNorm=Math.sqrt(queryNorm)
 const top:{score:number;row:T;chunk:RankedChunk}[]=[]
 for(const {row,index} of entries){
  for(const chunk of index.chunks){
   const base=chunk.ordinal*dimensions,norm=index.norms[chunk.ordinal]!
   let dot=0
   for(let d=0;d<dimensions;d++)dot+=queryVector[d]!*index.vectors[base+d]!
   const score=norm===0||queryNorm===0?0:Math.max(-1,Math.min(1,dot/(norm*queryNorm)))
   if(top.length===limit&&score<=top.at(-1)!.score)continue
   top.push({score,row,chunk})
   top.sort((a,b)=>b.score-a.score||a.row.resourceId.localeCompare(b.row.resourceId)||a.chunk.ordinal-b.chunk.ordinal)
   if(top.length>limit)top.pop()
  }
 }
 return top
}
