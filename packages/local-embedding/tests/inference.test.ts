import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createSession,embedTexts,type InferenceConfig,type OrtLike} from '../src/inference.ts'

const config:InferenceConfig={queryInstruction:'Instruct: Q\nQuery:',documentPrefix:'',padTokenId:151643,kvLayers:28,kvHeads:8,headDim:128,batchSize:2,dimensions:1024}

class FakeTensor{
 readonly type:string;readonly data:ArrayLike<number|bigint>;readonly dims:readonly number[]
 constructor(type:string,data:ArrayLike<number|bigint>,dims:readonly number[]){this.type=type;this.data=data;this.dims=dims}
}
/** 假 ORT：记录每次 run 的输入，返回按位置编码的 last_hidden_state（第 t 位第 0 维 = t+1，第 1 维 = 1）。 */
function fakeOrt(){
 const runs:{feeds:Record<string,FakeTensor>;fetches:readonly string[]}[]=[]
 const ort:OrtLike={Tensor:FakeTensor as never}
 const session={async run(feeds:Record<string,unknown>,fetches:readonly string[]){
  const typed=feeds as Record<string,FakeTensor>
  runs.push({feeds:typed,fetches})
  const [batch,seq]=typed.input_ids!.dims as [number,number]
  const data=new Float32Array(batch*seq*1024)
  for(let b=0;b<batch;b++)for(let t=0;t<seq;t++){data[(b*seq+t)*1024]=t+1+b*100;data[(b*seq+t)*1024+1]=1}
  return {last_hidden_state:new FakeTensor('float32',data,[batch,seq,1024])}
 }}
 return {ort,session,runs}
}
/** 假分词器：每个字符一个词元（id = 码位），末尾追加 151643；超过 5 个字符截断。 */
const tokenizer={encode(text:string){const ids=[...text].map(ch=>ch.codePointAt(0)!);const truncated=ids.length>4;return {ids:[...ids.slice(0,4),151643],truncated}}}

test('前向输入：查询拼官方指令、文档不拼；右填充 151643；position_ids 0..len-1 填充位补 0；28 层空 KV [batch,8,0,128] float32；只取 last_hidden_state',async()=>{
 const {ort,session,runs}=fakeOrt()
 const query=await embedTexts({ort,session,tokenizer,config},'query',['ab'])
 assert.equal(runs.length,1)
 const {feeds,fetches}=runs[0]!
 assert.deepEqual(fetches,['last_hidden_state'])
 assert.deepEqual(Array.from(feeds.input_ids!.data).map(Number),[...'Instruct: Q\nQuery:ab'].slice(0,4).map(ch=>ch.codePointAt(0)!).concat(151643))
 assert.equal(query.truncated,1)
 runs.length=0
 const docs=await embedTexts({ort,session,tokenizer,config},'passage',['xy','z'])
 const feed=runs[0]!.feeds
 assert.equal(feed.input_ids!.type,'int64')
 assert.deepEqual(feed.input_ids!.dims,[2,3])
 assert.deepEqual(Array.from(feed.input_ids!.data).map(Number),[120,121,151643, 122,151643,151643])
 assert.deepEqual(Array.from(feed.attention_mask!.data).map(Number),[1,1,1, 1,1,0])
 assert.deepEqual(Array.from(feed.position_ids!.data).map(Number),[0,1,2, 0,1,0])
 const kv=Object.keys(feed).filter(name=>name.startsWith('past_key_values.'))
 assert.equal(kv.length,56)
 for(let layer=0;layer<28;layer++)for(const part of ['key','value']){
  const tensor=feed[`past_key_values.${layer}.${part}`]!
  assert.equal(tensor.type,'float32')
  assert.deepEqual(tensor.dims,[2,8,0,128])
  assert.equal(tensor.data.length,0)
 }
 assert.deepEqual(Object.keys(feed).filter(name=>!name.startsWith('past_key_values.')).sort(),['attention_mask','input_ids','position_ids'])
 // 池化位：第 0 行取 t=2（x0=3），第 1 行取 t=1（x0=102）
 assert.equal(docs.vectors.length,2)
 assert.ok(Math.abs(docs.vectors[0]![0]!/docs.vectors[0]![1]!-3)<1e-5)
 assert.ok(Math.abs(docs.vectors[1]![0]!/docs.vectors[1]![1]!-102)<1e-4)
 assert.equal(docs.truncated,0)
})

test('微批：按 batchSize 切分，顺序保持',async()=>{
 const {ort,session,runs}=fakeOrt()
 const result=await embedTexts({ort,session,tokenizer,config},'passage',['a','b','c','d','e'])
 assert.deepEqual(runs.map(run=>run.feeds.input_ids!.dims[0]),[2,2,1])
 assert.equal(result.vectors.length,5)
})

test('建会话：缺省只传 executionProviders:[cpu]（与引入 sessionOptions 前逐字相同）；给出 sessionOptions 时原样追加',async()=>{
 const calls:{path:string;options:object}[]=[]
 const ort={InferenceSession:{async create(path:string,options:object){calls.push({path,options});return {run:async()=>({})}}}}
 await createSession(ort,{modelPath:'/m/model.onnx'})
 await createSession(ort,{modelPath:'/m/model.onnx',sessionOptions:{}})
 await createSession(ort,{modelPath:'/m/model_q4.onnx',sessionOptions:{enableCpuMemArena:false,enableMemPattern:false}})
 assert.deepEqual(calls,[
  {path:'/m/model.onnx',options:{executionProviders:['cpu']}},
  {path:'/m/model.onnx',options:{executionProviders:['cpu']}},
  {path:'/m/model_q4.onnx',options:{executionProviders:['cpu'],enableCpuMemArena:false,enableMemPattern:false}},
 ])
 const worker=await readFile(new URL('../src/worker.ts',import.meta.url),'utf8')
 assert.match(worker,/await createSession\(ort,config\)/)
 assert.doesNotMatch(worker,/InferenceSession\.create\(/)
})

test('子进程源码不引用网络能力：worker/inference/tokenize/pooling 不含 fetch、http、https、net、tls、dgram',async()=>{
 for(const file of ['worker.ts','inference.ts','tokenize.ts','pooling.ts']){
  const source=await readFile(new URL(`../src/${file}`,import.meta.url),'utf8')
  assert.doesNotMatch(source,/\bfetch\b|node:https?\b|node:net\b|node:tls\b|node:dgram\b|['"](?:https?|net|tls|dgram|undici)['"]|WebSocket|XMLHttpRequest/,file)
 }
})
