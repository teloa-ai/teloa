/*!
 * Portions adapted from llmfit v1.1.16 (MIT).
 * Copyright (c) 2026 Alex Jones
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** 固定来源、移植范围与单位修正见 ../LOCAL-MODEL-FIT-PROVENANCE.md。这里只估计内存，不探测服务或决定下载。 */
export type LocalModelFitHardware={totalMemBytes:number;availableMemBytes?:number;platform:string;arch:string}
export type LocalModelFitAssessment={
 requiredMemoryBytes:number
 availableMemoryBytes:number
 /** 沿既有枚举供调用方兼容；这里只表示内存余量，slow 不表示测得推理速度。 */
 fit:'good'|'slow'|'poor'
 contextTokens:number
 maxContextTokens:number
 contextSupported:boolean
 confidence:'estimated'
 basis:{
  source:'llmfit'
  sourceVersion:'1.1.16'
  sourceCommit:'2ac77f5e0d13221c7e2a2414769fe62f660d225c'
  modelId:string
  catalogDigest:string
  parameters:number
  layers:number
  kvHeads:number
  headDim:number
  weightsBytes:number
  kvCacheBytes:number
  kvCacheType:'fp16'
  runtimeOverheadBytes:number
  memoryBasis:'available-memory'|'reserved-physical-memory'
 }
}

type ModelMetadata={modelId:string;parameters:number;layers:number;kvHeads:number;headDim:number;maxContextTokens:number;sizeBytes:number;digest:string}
// 只录入既有受审 Q4_K_M 工件且层/KV 元数据完整的稠密模型；不按名称猜架构、别名或活跃 MoE 参数。
const models:Readonly<Record<string,ModelMetadata>>={
 'qwen3:4b':{modelId:'Qwen/Qwen3-4B',parameters:4_022_468_096,layers:36,kvHeads:8,headDim:128,maxContextTokens:40960,sizeBytes:2_497_293_931,digest:'sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7'},
 'qwen3:8b':{modelId:'Qwen/Qwen3-8B',parameters:8_190_735_360,layers:36,kvHeads:8,headDim:128,maxContextTokens:40960,sizeBytes:5_225_388_164,digest:'sha256:500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41'},
 'qwen3:14b':{modelId:'Qwen/Qwen3-14B',parameters:14_768_307_200,layers:40,kvHeads:8,headDim:128,maxContextTokens:40960,sizeBytes:9_276_198_565,digest:'sha256:bdbd181c33f2ed1b31c972991882db3cf4d192569092138a7d29e973cd9debe8'},
 'deepseek-r1:7b':{modelId:'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',parameters:7_615_616_512,layers:28,kvHeads:4,headDim:128,maxContextTokens:131072,sizeBytes:4_683_075_440,digest:'sha256:755ced02ce7befdb13b7ca74e1e4d08cddba4986afdb63a480f2c93d3140383f'},
 'deepseek-r1:14b':{modelId:'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',parameters:14_770_033_664,layers:48,kvHeads:8,headDim:128,maxContextTokens:131072,sizeBytes:8_988_112_209,digest:'sha256:c333b7232bdb521236694ffbb5f5a6b11cc45d98e9142c73123b670fca400b09'},
 'phi4:14b':{modelId:'microsoft/phi-4',parameters:14_659_507_200,layers:40,kvHeads:10,headDim:128,maxContextTokens:16384,sizeBytes:9_053_116_391,digest:'sha256:ac896e5b8b34a1f4efa7b14d7520725140d5512484457fab45d2a4ea14c69dba'},
}
const GiB=2**30
const wholeBytes=(value:number)=>Number.isSafeInteger(value)&&value>=0

/**
 * 既有工件、单会话、稠密注意力、FP16 KV 的保守内存估计。不能据此宣称 GPU 完全驻留或实测性能。
 * sizeBytes 必须来自受审目录的固定工件；名称、量化、体积或架构元数据未知时交回旧保守判断。
 * availableMemBytes 仅接可靠可用内存，不把 macOS 的 os.freemem() 空闲页当可用内存。
 */
export function assessLocalModelFit(input:{hardware:LocalModelFitHardware;ollamaName:string;quant:string;sizeBytes:number;contextTokens?:number}):LocalModelFitAssessment|undefined{
 if(!Object.hasOwn(models,input.ollamaName)||input.quant!=='Q4_K_M')return
 const model=models[input.ollamaName]!,{totalMemBytes,availableMemBytes}=input.hardware,contextTokens=input.contextTokens??8192
 if(!wholeBytes(totalMemBytes)||totalMemBytes===0||!wholeBytes(input.sizeBytes)||input.sizeBytes!==model.sizeBytes||!Number.isInteger(contextTokens)||contextTokens<=0||contextTokens>0xffff_ffff||(availableMemBytes!==undefined&&!wholeBytes(availableMemBytes)))return
 // Q4_K_M 的 0.58 B/参数来自 llmfit；以受审文件真实体积为下界，覆盖未量化张量和容器开销。
 const weightsBytes=Math.max(input.sizeBytes,Math.ceil(model.parameters*0.58))
 // K 与 V 各一份，FP16 每元素 2 B。用字节统一权重和 KV，避免混合十进制 GB 与 GiB。
 const kvCacheBytes=2*model.layers*model.kvHeads*model.headDim*contextTokens*2
 const runtimeOverheadBytes=GiB/2,requiredMemoryBytes=weightsBytes+kvCacheBytes+runtimeOverheadBytes
 const availableMemoryBytes=availableMemBytes===undefined?Math.floor(totalMemBytes*0.75):Math.min(totalMemBytes,availableMemBytes)
 const contextSupported=contextTokens<=model.maxContextTokens
 const ratio=availableMemoryBytes>0?requiredMemoryBytes/availableMemoryBytes:Infinity
 return {
  requiredMemoryBytes,availableMemoryBytes,fit:!contextSupported||ratio>0.98?'poor':ratio<=0.85?'good':'slow',
  contextTokens,maxContextTokens:model.maxContextTokens,contextSupported,confidence:'estimated',
  basis:{source:'llmfit',sourceVersion:'1.1.16',sourceCommit:'2ac77f5e0d13221c7e2a2414769fe62f660d225c',modelId:model.modelId,catalogDigest:model.digest,parameters:model.parameters,layers:model.layers,kvHeads:model.kvHeads,headDim:model.headDim,weightsBytes,kvCacheBytes,kvCacheType:'fp16',runtimeOverheadBytes,memoryBasis:availableMemBytes===undefined?'reserved-physical-memory':'available-memory'},
 }
}
