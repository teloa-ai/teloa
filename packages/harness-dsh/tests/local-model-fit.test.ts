import test from 'node:test'
import assert from 'node:assert/strict'
import {assessLocalModelFit} from '../src/local-model-fit.ts'

const GiB=2**30
const hardware={totalMemBytes:16*GiB,platform:'darwin',arch:'arm64'}
const qwen4={ollamaName:'qwen3:4b',quant:'Q4_K_M',sizeBytes:2_497_293_931}
const assessment=()=>assessLocalModelFit({hardware,...qwen4})!

test('固定目录权重、FP16 KV 与运行时余量组成默认 8192 上下文的内存估计',()=>{
 const value=assessment()
 assert.equal(value.contextTokens,8192);assert.equal(value.maxContextTokens,40960);assert.equal(value.contextSupported,true)
 assert.equal(value.requiredMemoryBytes,2_497_293_931+1_207_959_552+GiB/2)
 assert.equal(value.availableMemoryBytes,12*GiB);assert.equal(value.fit,'good')
 assert.equal(value.confidence,'estimated')
 assert.equal(value.basis.weightsBytes,qwen4.sizeBytes);assert.equal(value.basis.kvCacheBytes,1_207_959_552)
 assert.equal(value.basis.memoryBasis,'reserved-physical-memory')
 assert.equal(value.basis.sourceVersion,'1.1.16');assert.equal(value.basis.modelId,'Qwen/Qwen3-4B')
 assert.equal(value.basis.catalogDigest,'sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7')
 assert.equal('estimatedTps' in value,false,'内存容量估计不产生性能承诺')
})

test('长上下文扩大 KV 预算；超过模型支持上限时明确不适用，不静默裁剪',()=>{
 const regular=assessment(),long=assessLocalModelFit({hardware,...qwen4,contextTokens:32768})!
 assert.equal(long.basis.kvCacheBytes,regular.basis.kvCacheBytes*4)
 assert.equal(long.requiredMemoryBytes-regular.requiredMemoryBytes,regular.basis.kvCacheBytes*3)
 const unsupported=assessLocalModelFit({hardware:{...hardware,totalMemBytes:1024*GiB},...qwen4,contextTokens:40961})!
 assert.equal(unsupported.contextTokens,40961);assert.equal(unsupported.contextSupported,false);assert.equal(unsupported.fit,'poor')
})

test('可靠可用内存按 85/98% 边界评估，零可用内存不可宣称可容纳',()=>{
 const required=assessment().requiredMemoryBytes
 const fit=(availableMemBytes:number)=>assessLocalModelFit({hardware:{...hardware,totalMemBytes:64*GiB,availableMemBytes},...qwen4})!
 assert.equal(fit(Math.ceil(required/0.85)).fit,'good')
 assert.equal(fit(Math.floor(required/0.85)).fit,'slow')
 assert.equal(fit(Math.ceil(required/0.98)).fit,'slow')
 assert.equal(fit(Math.floor(required/0.98)).fit,'poor')
 assert.equal(fit(0).fit,'poor');assert.equal(fit(0).availableMemoryBytes,0)
 assert.equal(fit(64*GiB).basis.memoryBasis,'available-memory')
 assert.equal(fit(128*GiB).availableMemoryBytes,64*GiB,'可用值不能超过物理内存')
})

test('没有可靠可用内存时仅预算 75% 物理内存，不把 Node 空闲页或全部统一内存当可用量',()=>{
 const value=assessLocalModelFit({hardware:{...hardware,totalMemBytes:8*GiB},ollamaName:'qwen3:8b',quant:'Q4_K_M',sizeBytes:5_225_388_164})!
 assert.equal(value.availableMemoryBytes,6*GiB);assert.equal(value.fit,'poor')
 assert.equal(value.basis.memoryBasis,'reserved-physical-memory')
 assert.equal(assessLocalModelFit({hardware:{...hardware,platform:'linux',arch:'x64'},...qwen4})!.requiredMemoryBytes,assessment().requiredMemoryBytes,'不虚构 GPU 或平台性能差异')
})

test('仅评估六个完整元数据的固定工件，不猜测别名、量化、MoE、缺失元数据或新工件',()=>{
 const rows=[
  ['qwen3:4b',2_497_293_931],['qwen3:8b',5_225_388_164],['qwen3:14b',9_276_198_565],
  ['deepseek-r1:7b',4_683_075_440],['deepseek-r1:14b',8_988_112_209],['phi4:14b',9_053_116_391],
 ] as const
 for(const [ollamaName,sizeBytes] of rows){const value=assessLocalModelFit({hardware,ollamaName,sizeBytes,quant:'Q4_K_M'})!;assert.ok(value);assert.ok(value.basis.parameters>0);assert.ok(value.basis.layers>0);assert.ok(value.basis.kvHeads>0);assert.equal(value.basis.headDim,128)}
 for(const ollamaName of ['qwen3:30b-a3b','qwen3:latest','QWEN3:4b','llama3.1:8b','gemma3:4b','gemma3:12b','embeddinggemma-2:latest','constructor'])assert.equal(assessLocalModelFit({hardware,...qwen4,ollamaName}),undefined)
 for(const quant of ['Q8_0','q4_k_m','unknown'])assert.equal(assessLocalModelFit({hardware,...qwen4,quant}),undefined)
 assert.equal(assessLocalModelFit({hardware,...qwen4,sizeBytes:qwen4.sizeBytes+1}),undefined)
})

test('无效内存、工件大小或上下文不生成貌似有效的估计',()=>{
 for(const totalMemBytes of [0,-1,NaN,Infinity,1.5])assert.equal(assessLocalModelFit({hardware:{...hardware,totalMemBytes},...qwen4}),undefined)
 for(const availableMemBytes of [-1,NaN,Infinity,1.5])assert.equal(assessLocalModelFit({hardware:{...hardware,availableMemBytes},...qwen4}),undefined)
 for(const contextTokens of [0,-1,1.5,NaN,Infinity,2**32])assert.equal(assessLocalModelFit({hardware,...qwen4,contextTokens}),undefined)
 for(const sizeBytes of [0,-1,NaN,Infinity,1.5])assert.equal(assessLocalModelFit({hardware,...qwen4,sizeBytes}),undefined)
})
