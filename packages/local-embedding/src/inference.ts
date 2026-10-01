import {realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join,sep} from 'node:path'
import {lastTokenPool} from './pooling.ts'
import type {TextTokenizer} from './tokenize.ts'

/** 子进程推理配置：取自 `assets.json` 的 `profile` 与内存策略，由宿主经 argv 传入。 */
export type InferenceConfig={queryInstruction:string;documentPrefix:string;padTokenId:number;kvLayers:number;kvHeads:number;headDim:number;batchSize:number;dimensions:number}
/** ORT 会话选项（内存评估 可测参数）：只在显式给出时追加到 `InferenceSession.create`，缺省保持今天只传 `executionProviders` 的行为。 */
export type OrtSessionOptions={enableCpuMemArena?:boolean;enableMemPattern?:boolean}
export type WorkerConfig=InferenceConfig&{runtimeDir:string;modelPath:string;tokenizerPath:string;tokenizerConfigPath:string;maxTokens:number;appendedTokenId:number;sessionOptions?:OrtSessionOptions}
type TensorLike={readonly type:string;readonly data:ArrayLike<number|bigint>;readonly dims:readonly number[]}
/** `onnxruntime-node` 用到的最小外形（测试注入假实现）。 */
export type OrtLike={Tensor:new(type:string,data:ArrayLike<number|bigint>,dims:readonly number[])=>TensorLike}
export type SessionLike={run(feeds:Record<string,unknown>,fetches:readonly string[]):Promise<Record<string,unknown>>}

/** 建会话：固定 CPU EP，`config.sessionOptions` 原样追加；缺省时参数与引入该选项前逐字相同。 */
export function createSession(ort:{InferenceSession:{create(path:string,options:object):Promise<SessionLike>}},config:Pick<WorkerConfig,'modelPath'|'sessionOptions'>):Promise<SessionLike>{
 return ort.InferenceSession.create(config.modelPath,{executionProviders:['cpu'],...config.sessionOptions})
}

/**
 * 子进程加载入口：用 `createRequire` 从受管目录解析 `onnxruntime-node`，解析结果（按真实路径）必须仍在该目录内，
 * 不从仓库或全局 node_modules 加载。
 */
export function resolveRuntimeEntry(dir:string):string{
 try{
  const real=realpathSync(dir)
  const entry=realpathSync(createRequire(join(real,'node_modules','onnxruntime-node','package.json')).resolve('onnxruntime-node'))
  if(!entry.startsWith(real+sep))throw new Error('escape')
  return entry
 }catch{
  throw new Error('推理运行时不在受管安装目录内，请重新准备。')
 }
}

/**
 * 一次嵌入（规格 §4.4）：查询侧拼官方指令前缀、文档侧拼 documentPrefix（空串），按 batchSize 切微批；
 * 每个微批右填充 padTokenId，`position_ids` 为 0..len-1（填充位补 0），28 层 `past_key_values.*` 各喂 `[batch,8,0,128]`
 * 的空 float32 张量，只取 `last_hidden_state`（`present.*` 不取回），在本进程内做 last-token 池化与 L2 归一化。
 */
export async function embedTexts(deps:{ort:OrtLike;session:SessionLike;tokenizer:TextTokenizer;config:InferenceConfig},kind:'query'|'passage',texts:readonly string[]):Promise<{vectors:Float32Array[];truncated:number}>{
 const {ort,session,tokenizer,config}=deps
 const prefix=kind==='query'?config.queryInstruction:config.documentPrefix
 const vectors:Float32Array[]=[]
 let truncated=0
 for(let start=0;start<texts.length;start+=config.batchSize){
  const encoded=texts.slice(start,start+config.batchSize).map(text=>tokenizer.encode(prefix+text))
  truncated+=encoded.filter(row=>row.truncated).length
  const batch=encoded.length,seq=Math.max(...encoded.map(row=>row.ids.length))
  const ids=new BigInt64Array(batch*seq).fill(BigInt(config.padTokenId)),mask=new BigInt64Array(batch*seq),positions=new BigInt64Array(batch*seq)
  encoded.forEach((row,b)=>row.ids.forEach((id,t)=>{ids[b*seq+t]=BigInt(id);mask[b*seq+t]=1n;positions[b*seq+t]=BigInt(t)}))
  const feeds:Record<string,TensorLike>={input_ids:new ort.Tensor('int64',ids,[batch,seq]),attention_mask:new ort.Tensor('int64',mask,[batch,seq]),position_ids:new ort.Tensor('int64',positions,[batch,seq])}
  for(let layer=0;layer<config.kvLayers;layer++)for(const part of ['key','value'])feeds[`past_key_values.${layer}.${part}`]=new ort.Tensor('float32',new Float32Array(0),[batch,config.kvHeads,0,config.headDim])
  const output=(await session.run(feeds,['last_hidden_state'])).last_hidden_state as TensorLike|undefined
  if(!output||output.type!=='float32'||output.dims.length!==3||output.dims[0]!==batch||output.dims[1]!==seq)throw new Error('模型输出形状不符。')
  vectors.push(...lastTokenPool(output.data as Float32Array,[batch,seq,output.dims[2]!],mask))
 }
 return {vectors,truncated}
}
