import test from 'node:test'
import assert from 'node:assert/strict'
import {captureRetrievalPreparation,readRetrievalPrepareInput,sameRetrievalPreparation,resourceTitle,isResourceSpec} from '../src/index.ts'
const provider={id:'model',location:'host-local' as const,catalogId:'fixture.model',catalogVersion:'1',profileHash:'a'.repeat(64),variant:'fp32' as const,totalMemoryBytes:8*1024**3,memoryRisk:true,preparationDetails:{
 modelName:'Fixture model',license:'Apache-2.0',upstreamRepo:'fixture/model',conversionRepo:'fixture/converted',modelDirectory:'/model',runtimeDirectory:'/runtime',
 files:[{path:'model.onnx',source:'example.invalid',bytes:1,sha256:'b'.repeat(64),shared:false}],
 runtime:{package:'fixture-runtime',version:'1.0.0',source:'example.invalid',integrity:'sha512-YQ==',unpackedBytesEstimate:1},
 reserveBytes:1,memoryBytesEstimate:[1,2] as [number,number],
}}
test('prepare 请求必须包含完整 expected；旧 {}、额外字段、缺失/损坏确认均拒绝',()=>{
 const expected=captureRetrievalPreparation(provider)
 assert.deepEqual(readRetrievalPrepareInput({expected}),{expected})
 for(const payload of [{},{expected:{}},{expected,force:true},{expected:{...expected,extra:true}},{expected:{...expected,preparationDetails:undefined}},{expected:{...expected,profileHash:'oops'}}]){
  assert.throws(()=>readRetrievalPrepareInput(payload),{code:'teloa/invalid-input'})
 }
})
test('预期配置深拷贝、键序规范化；工件/路径/许可/版本/内存风险漂移均参与比较',()=>{
 const expected=captureRetrievalPreparation(provider)
 const reordered=JSON.parse(JSON.stringify(expected),(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value)
 assert.equal(sameRetrievalPreparation(expected,reordered),true)
 for(const patch of [{catalogVersion:'2'},{profileHash:'c'.repeat(64)},{memoryRisk:false},{preparationDetails:{...expected.preparationDetails,license:'new'}},{preparationDetails:{...expected.preparationDetails,runtimeDirectory:'/changed'}}]){
  assert.equal(sameRetrievalPreparation(expected,{...expected,...patch}),false)
 }
 const copy=captureRetrievalPreparation(provider)
 assert.ok(copy.preparationDetails.kind===undefined)
 copy.preparationDetails.files[0]!.bytes=20
 assert.equal(provider.preparationDetails.files[0]!.bytes,1)
 assert.equal(sameRetrievalPreparation(expected,copy),false)
})
test('共享标题判据与真实 ResourceSpec 合法域一致，不排除 Cc/Cf/ZWJ',()=>{
 for(const title of ['👩‍💻 研发手册','家人👩‍👩‍👧‍👦','a\nb','a\u200db','x\u0000y','x'.repeat(200),'',' \n ','x'.repeat(201),null,1]){
  assert.equal(resourceTitle(title),isResourceSpec({title,sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['general']}))
 }
})
