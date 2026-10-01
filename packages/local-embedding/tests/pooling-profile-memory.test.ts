import test from 'node:test'
import assert from 'node:assert/strict'
import {lastTokenPool} from '../src/pooling.ts'
import {embeddingProfile,profileHash} from '../src/profile.ts'
import {memoryPolicy,ortSessionOptions} from '../src/memory-policy.ts'
import assets from '../runtime/assets.json' with {type:'json'}

const D=1024
/** 构造 [batch, seq, D] 隐状态：第 b 行第 t 位的第 d 维 = b*1000 + t*10 + (d===0?1:0)，便于核对取位。 */
function hidden(batch:number,seq:number,dims=D){
 const data=new Float32Array(batch*seq*dims)
 for(let b=0;b<batch;b++)for(let t=0;t<seq;t++){const base=(b*seq+t)*dims;data[base]=b*1000+t*10+1;data[base+1]=1}
 return data
}

test('last-token 池化：右填充取 sum(attention_mask)-1 位，并做 L2 归一化',()=>{
 const mask=[1,1,1,0, 1,1,0,0]
 const vectors=lastTokenPool(hidden(2,4),[2,4,D],mask)
 assert.equal(vectors.length,2)
 for(const vector of vectors){
  assert.equal(vector.length,D)
  assert.ok(Math.abs(Math.hypot(...vector)-1)<1e-6)
 }
 // 第 0 行取 t=2：x0=21；第 1 行取 t=1：x0=1011
 assert.ok(Math.abs(vectors[0]![0]!/vectors[0]![1]!-21)<1e-3)
 assert.ok(Math.abs(vectors[1]![0]!/vectors[1]![1]!-1011)<1e-2)
})

test('池化拒绝：维度不是 1024、全填充行、左填充或空洞掩码、零向量、非有限值、形状与数据长度不符',()=>{
 assert.throws(()=>lastTokenPool(hidden(1,2,512),[1,2,512],[1,1]),/1024/)
 assert.throws(()=>lastTokenPool(hidden(2,2),[2,2,D],[1,1,0,0]),/填充/)
 assert.throws(()=>lastTokenPool(hidden(1,3),[1,3,D],[0,1,1]),/右填充/)
 assert.throws(()=>lastTokenPool(hidden(1,3),[1,3,D],[1,0,1]),/右填充/)
 assert.throws(()=>lastTokenPool(new Float32Array(2*D),[1,2,D],[1,1]),/零向量/)
 const nan=hidden(1,1);nan[5]=Number.NaN
 assert.throws(()=>lastTokenPool(nan,[1,1,D],[1]),/有限/)
 assert.throws(()=>lastTokenPool(hidden(1,2),[1,3,D],[1,1,1]),/形状/)
 assert.throws(()=>lastTokenPool(hidden(1,2),[1,2,D],[1]),/形状/)
})

test('profileHash：规格 §4.4 字段；字段顺序无关；任一字段变化摘要随之变化；fp32 与 int8 不同',()=>{
 const fp32=embeddingProfile(assets,'fp32')
 assert.deepEqual(Object.keys(fp32).sort(),['catalogId','catalogVersion','dimensions','documentPrefix','maxTokens','normalize','onnxSha256','pooling','queryInstruction','tokenizerSha256','variant'])
 assert.equal(fp32.catalogId,'teloa.model.qwen3-embedding-0-6b')
 assert.equal(fp32.pooling,'last-token')
 assert.equal(fp32.dimensions,1024)
 assert.equal(fp32.normalize,'l2')
 assert.equal(fp32.maxTokens,512)
 assert.equal(fp32.documentPrefix,'')
 assert.equal(fp32.queryInstruction,'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:')
 assert.deepEqual(fp32.onnxSha256,['bf27b2f3f9ef9c32ca337d75b361fa99439deaeaefe82e4701b2dbd8439197cc','f0a61604465929a27e68aa6217c8c89ec6186572f0209fdb7711adda48a9b9a9'])
 assert.equal(fp32.tokenizerSha256,'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a')
 const hash=profileHash(fp32)
 assert.match(hash,/^[a-f0-9]{64}$/)
 const reversed=Object.fromEntries(Object.entries(fp32).reverse()) as typeof fp32
 assert.equal(profileHash(reversed),hash)
 const changes:Partial<typeof fp32>[]=[{catalogVersion:'1.0.1'},{variant:'int8'},{onnxSha256:['0'.repeat(64)]},{tokenizerSha256:'1'.repeat(64)},{maxTokens:511},{queryInstruction:'Instruct: x\nQuery: '},{documentPrefix:' '},{catalogId:'teloa.model.other'}]
 for(const change of changes)assert.notEqual(profileHash({...fp32,...change}),hash,JSON.stringify(change))
 const int8=embeddingProfile(assets,'int8')
 assert.equal(int8.variant,'int8')
 assert.deepEqual(int8.onnxSha256,['6d0ea863f78b4a84afa3c7fcba1ec341572b5e28121aef77b7092b1dfdf679c7'])
 assert.notEqual(profileHash(int8),hash)
 const q4=embeddingProfile(assets,'q4')
 assert.deepEqual(q4.onnxSha256,['8be554b37368134c3f38613c6f6ad0b7bb5f3a6465ab87574dbc0dcf24daa428'])
 assert.ok(![hash,profileHash(int8)].includes(profileHash(q4)))
})

test('profileHash 拒收偏离固定取值的配置：维度、池化、归一化',()=>{
 const fp32=embeddingProfile(assets,'fp32')
 for(const bad of [{dimensions:768},{pooling:'mean'},{normalize:'none'}])assert.throws(()=>profileHash({...fp32,...bad} as never),/配置/)
})

test('内存策略：发行默认批 4（不分机器内存，内存评估 裁定）；totalmem ≤ 8 GiB → 空闲 120000 ms，否则 300000 ms',()=>{
 const gib=1024**3
 assert.deepEqual(memoryPolicy(8*gib),{batchSize:4,idleTimeoutMs:120_000})
 assert.deepEqual(memoryPolicy(4*gib),{batchSize:4,idleTimeoutMs:120_000})
 assert.deepEqual(memoryPolicy(8*gib+1),{batchSize:4,idleTimeoutMs:300_000})
 assert.deepEqual(memoryPolicy(48*gib),{batchSize:4,idleTimeoutMs:300_000})
})

test('验收批大小覆盖：只在 TELOA_LOCAL_EMBEDDING_ACCEPTANCE=1 下且取值为 4 或 8 时生效；空闲时限不变',()=>{
 const gib=1024**3
 assert.deepEqual(memoryPolicy(48*gib,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_BATCH:'8'}),{batchSize:8,idleTimeoutMs:300_000})
 assert.deepEqual(memoryPolicy(8*gib,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_BATCH:'8'}),{batchSize:8,idleTimeoutMs:120_000})
 assert.deepEqual(memoryPolicy(48*gib,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_BATCH:'4'}),{batchSize:4,idleTimeoutMs:300_000})
 assert.deepEqual(memoryPolicy(48*gib,{TELOA_LOCAL_EMBEDDING_BATCH:'8'}),{batchSize:4,idleTimeoutMs:300_000})
 assert.deepEqual(memoryPolicy(48*gib,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'0',TELOA_LOCAL_EMBEDDING_BATCH:'8'}),{batchSize:4,idleTimeoutMs:300_000})
 for(const bad of ['16','0','8 ','abc',''])assert.deepEqual(memoryPolicy(48*gib,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_BATCH:bad}),{batchSize:4,idleTimeoutMs:300_000},bad)
})

test('ORT 会话选项：缺省取清单该变体的值（空对象）；ARENA=off 只在验收开关下覆盖为两者皆 false',()=>{
 const off={enableCpuMemArena:false,enableMemPattern:false}
 for(const variant of ['fp32','int8','q4','bnb4'] as const)assert.deepEqual(ortSessionOptions((assets as {sessionOptions?:Record<string,object>}).sessionOptions?.[variant]),{},variant)
 assert.deepEqual(ortSessionOptions(undefined),{})
 assert.deepEqual(ortSessionOptions({enableMemPattern:true}),{enableMemPattern:true})
 assert.deepEqual(ortSessionOptions(undefined,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ORT_ARENA:'off'}),off)
 assert.deepEqual(ortSessionOptions({enableMemPattern:true},{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ORT_ARENA:'off'}),off)
 assert.deepEqual(ortSessionOptions(undefined,{TELOA_LOCAL_EMBEDDING_ORT_ARENA:'off'}),{})
 assert.deepEqual(ortSessionOptions(undefined,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ORT_ARENA:'default'}),{})
 assert.deepEqual(ortSessionOptions(undefined,{TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ORT_ARENA:'OFF'}),{})
})
