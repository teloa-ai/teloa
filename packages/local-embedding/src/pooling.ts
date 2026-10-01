/** 固定输出维度（规格 §3.1：本期不裁维）。 */
export const embeddingDimensions=1024

/**
 * last-token 池化（规格 §4.4）：输入右填充，第 i 行取 `last_hidden_state[i, sum(attention_mask[i])-1, :]`，再 L2 归一化。
 * 维度不是 1024、全填充行、非右填充掩码、零向量或非有限值一律抛错，不返回可疑向量。
 */
export function lastTokenPool(hidden:Float32Array,shape:readonly [number,number,number],attentionMask:ArrayLike<number|bigint>):Float32Array[]{
 const [batch,seq,dims]=shape
 if(dims!==embeddingDimensions)throw new Error(`隐状态维度必须为 ${embeddingDimensions}。`)
 if(hidden.length!==batch*seq*dims||attentionMask.length!==batch*seq)throw new Error('隐状态或注意力掩码的形状与数据长度不符。')
 const vectors:Float32Array[]=[]
 for(let row=0;row<batch;row++){
  let length=0
  for(let t=0;t<seq;t++){
   const on=Number(attentionMask[row*seq+t])===1
   if(on&&t!==length)throw new Error('注意力掩码不是右填充。')
   if(on)length++
  }
  if(length===0)throw new Error('整行都是填充，无法池化。')
  const start=(row*seq+length-1)*dims
  const vector=hidden.slice(start,start+dims)
  let sum=0
  for(const value of vector){
   if(!Number.isFinite(value))throw new Error('隐状态含非有限值。')
   sum+=value*value
  }
  const norm=Math.sqrt(sum)
  if(!(norm>0))throw new Error('池化结果为零向量。')
  for(let d=0;d<dims;d++)vector[d]=vector[d]!/norm
  vectors.push(vector)
 }
 return vectors
}
