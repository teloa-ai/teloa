import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {readDshModelOptions} from '../src/model-options.ts'
import {inject} from '../src/index.ts'
import {createModelCatalogReader} from '../src/model-catalog-readiness.ts'
const signal=new AbortController().signal
function host(){
 let calls=0
 const ctx={sessionController:{modelCatalog:async()=>{calls++;return {default:{provider:'cloud',model:'large'},routableProviders:['cloud','ollama'],groups:[{id:'cloud',name:'Cloud',models:[{id:'large',name:'Large',description:'private description',reasoning:{efforts:[{id:'high',name:'High',description:'details'}],defaultEffort:'high'}}]},{id:'ollama',name:'Ollama',models:[{id:'small',name:'Small'}]},{id:'not-configured',name:'Not ready',models:[{id:'x',name:'X'}]}],failures:[{id:'offline',name:'Offline',message:'private error token'}]}}},llm:{listConfigurableProviders:()=>['cloud','ollama'].map(provider=>({provider,settingsNs:'llm-pi-ai',settingsPath:['providers',provider],declared:true}))},settings:{describe:()=>[{ns:'llm-pi-ai',value:{providers:{cloud:{baseURL:'https://api.example.test',apiKey:'secret'},ollama:{baseURL:'http://localhost:11434'}}}}]}} as unknown as Context
 ctx.teloaModelCatalog=createModelCatalogReader(ctx,()=>ctx.sessionController.modelCatalog())
 return {ctx,calls:()=>calls}
}
test('原生目录投影仅列可路由模型且不外发错误、说明或设置正文',async()=>{
 const {ctx,calls}=host(),result=await readDshModelOptions(ctx,{},signal)
 assert.equal(calls(),1);assert.deepEqual(result.groups.map(({id,remote})=>({id,remote})),[{id:'cloud',remote:true},{id:'ollama',remote:false}])
 assert.deepEqual(result.failures,[{id:'offline',name:'Offline'}])
 assert.deepEqual(result.groups[0]?.models[0]?.reasoning,{efforts:[{id:'high',name:'High'}],defaultEffort:'high'})
 assert.doesNotMatch(JSON.stringify(result),/private|secret|baseURL|apiKey|description|message/)
})
test('模型目录不接受客户端身份，取消与服务错误有明确出口',async()=>{
 const {ctx,calls}=host();await assert.rejects(readDshModelOptions(ctx,{ownerId:'other'},signal));assert.equal(calls(),0)
 ctx.sessionController.modelCatalog=async()=>{throw Error('secret')}
 await assert.rejects(readDshModelOptions(ctx,{},signal),(error:any)=>error.code==='teloa/source-unavailable'&&!error.message.includes('secret'))
 const abort=new AbortController();abort.abort();await assert.rejects(readDshModelOptions(ctx,{},abort.signal),{name:'AbortError'})
})

test('真实 Cordis 兄弟服务可由宿主依赖声明读取，根上下文桩不能掩盖漏注入',async t=>{
 const ctx=new Context(),data=host().ctx;t.after(()=>ctx.fiber.dispose())
 for(const service of inject)if(!['llm','settings','sessionController','teloaModelCatalog'].includes(service))ctx.provide(service,{})
 await ctx.plugin({name:'model-services',apply:(owner:Context)=>{owner.provide('llm',data.llm);owner.provide('settings',Reflect.get(data,'settings'));owner.provide('sessionController',data.sessionController);owner.provide('teloaModelCatalog',data.teloaModelCatalog)}})
 let read:(()=>Promise<unknown>)|undefined
 await ctx.plugin({name:'model-options-consumer',inject,apply:(owner:Context)=>{read=()=>readDshModelOptions(owner,{},signal)}})
 assert.ok(read);assert.equal((await read() as any).groups[0].remote,true)
})

test('管理目录同源保留缺密钥的模型名与默认身份，仅增加缺失标记',async()=>{
 const f=host(),settings=Reflect.get(f.ctx,'settings') as {describe:()=>unknown[]}
 settings.describe=()=>[{ns:'llm-pi-ai',value:{providers:{cloud:{apiKeyEnv:'CLOUD_KEY'},ollama:{baseURL:'http://localhost:11434'}}}}]
 Reflect.set(f.ctx,'credentials',{describe:async()=>({configured:false})})
 const result=await readDshModelOptions(f.ctx,{},signal)
 assert.equal(result.groups.find(row=>row.id==='cloud')?.credentialMissing,true)
 assert.equal(result.groups.find(row=>row.id==='ollama')?.credentialMissing,undefined)
 assert.deepEqual(result.default,{provider:'cloud',model:'large'});assert.equal(f.calls(),1)
 assert.doesNotMatch(JSON.stringify(result),/CLOUD_KEY|apiKeyEnv|private|secret/)
})
