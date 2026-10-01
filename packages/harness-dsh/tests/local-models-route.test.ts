import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,readOllamaAddress} from '@teloa/contract'
import {ensureOllamaRoute,removeFromOllamaRoute,OLLAMA_PLACEHOLDER_CREDENTIAL} from '../src/local-models-route.ts'

type Op={op:string;path:readonly string[];value?:unknown}
function fakeSettings(initial:Record<string,unknown>|undefined,opts:{writable?:boolean;hasPiAi?:boolean;conflictOnce?:boolean}={}){
 const section:Record<string,unknown>={providers:initial?{ollama:{api:'openai-completions',baseURL:'http://127.0.0.1:11434/v1',...initial}}:{}}
 let revision=3,conflict=opts.conflictOnce??false
 const ops:[string,Op[],number|undefined][]=[]
 return {ops,current:()=>section,writable:opts.writable??true,
  describe:()=>opts.hasPiAi===false?[]:[{ns:'llm-pi-ai',revision,value:section,user:section,autoGenerate:true,schema:{},applies:'live' as const,secrets:[]}],
  mutate:async(ns:string,edits:readonly Op[],expected?:number)=>{
   if(conflict){conflict=false;revision++;throw Object.assign(Error('stale'),{code:'SETTINGS_CONFLICT'})}
   if(expected!==revision)throw Object.assign(Error('stale'),{code:'SETTINGS_CONFLICT'})
   ops.push([ns,[...edits],expected])
   for(const edit of edits){
    let cursor=section
    for(const key of edit.path.slice(0,-1)){if(typeof cursor[key]!=='object'||cursor[key]===null)cursor[key]={};cursor=cursor[key] as Record<string,unknown>}
    const last=edit.path[edit.path.length-1]!
    if(edit.op==='set')cursor[last]=edit.value;else delete cursor[last]
   }
   revision++
  }}
}
function fakeCredentials(state:{configured:boolean;writable?:boolean}){
 const sets:[string,string][]=[]
 return {sets,describe:async(_ref:string)=>({configured:state.configured,writable:state.writable??true}),set:async(ref:string,value:string)=>{sets.push([ref,value])}}
}
const localAddress=readOllamaAddress('http://127.0.0.1:11434')
const model={id:'qwen3:4b',name:'qwen3:4b',contextWindow:40960,maxTokens:8192,input:['text'] as ('text'|'image')[]}
const code=(error:unknown)=>error instanceof WorkError?error.code:String(error)
const ollama=(settings:ReturnType<typeof fakeSettings>)=>(settings.current().providers as Record<string,Record<string,unknown>>).ollama!

test('①无路由 → 一次整体写入 providers.ollama：占位凭据引用、openai-completions、baseURL 加 /v1、models 含该模型',async()=>{
 const settings=fakeSettings(undefined),credentials=fakeCredentials({configured:false})
 await ensureOllamaRoute({settings,credentials},localAddress,[model],[])
 assert.equal(settings.ops.length,1)
 assert.deepEqual(settings.ops[0]![1][0]!.path,['providers','ollama'])
 const route=ollama(settings)
 assert.equal(route.apiKeyEnv,'OLLAMA_API_KEY')
 assert.equal(route.api,'openai-completions')
 assert.equal(route.baseURL,'http://127.0.0.1:11434/v1')
 assert.equal(route.displayName,'本机模型（Ollama）')
 assert.deepEqual(route.models,[model])
})

test('②已有路由（用户改过 displayName、自加 foo:latest）→ 只写 models：保留 foo:latest 与新 id，displayName 未动',async()=>{
 const settings=fakeSettings({displayName:'我的 Ollama',apiKeyEnv:'OLLAMA_API_KEY',api:'openai-completions',baseURL:'http://127.0.0.1:11434/v1',models:[{id:'foo:latest'}]})
 await ensureOllamaRoute({settings,credentials:fakeCredentials({configured:true})},localAddress,[model],[])
 assert.equal(settings.ops.length,1)
 assert.deepEqual(settings.ops[0]![1].map(op=>op.path),[['providers','ollama','models']])
 const route=ollama(settings)
 assert.equal(route.displayName,'我的 Ollama')
 assert.deepEqual((route.models as {id:string}[]).map(m=>m.id),['foo:latest','qwen3:4b'])
 // 再写一次同一模型（已登记）：替换而不重复
 await ensureOllamaRoute({settings,credentials:fakeCredentials({configured:true})},localAddress,[{...model,contextWindow:8192}],['qwen3:4b'])
 assert.deepEqual((route.models as {id:string;contextWindow:number}[]).map(m=>[m.id,m.contextWindow]),[['foo:latest',undefined],['qwen3:4b',8192]])
 // 同 id 但不是 Teloa 登记的用户项：不覆盖、不写
 const userOwned=fakeSettings({models:[{id:'qwen3:4b',contextWindow:1234}]})
 await ensureOllamaRoute({settings:userOwned,credentials:fakeCredentials({configured:true})},localAddress,[model],[])
 assert.equal(userOwned.ops.length,0)
 assert.deepEqual(ollama(userOwned).models,[{id:'qwen3:4b',contextWindow:1234}])
})

test('③removeFromOllamaRoute 只删自己 owned 的 id，foo:latest 保留；路由或 id 不存在时不写',async()=>{
 const settings=fakeSettings({models:[{id:'foo:latest'},{id:'qwen3:4b'}]}),credentials=fakeCredentials({configured:true})
 await removeFromOllamaRoute({settings,credentials},'qwen3:4b',localAddress)
 assert.equal(settings.ops.length,1)
 assert.deepEqual(ollama(settings).models,[{id:'foo:latest'}])
 await removeFromOllamaRoute({settings,credentials},'qwen3:4b',localAddress)
 assert.equal(settings.ops.length,1)
 const none=fakeSettings(undefined)
 await removeFromOllamaRoute({settings:none,credentials},'qwen3:4b',localAddress)
 assert.equal(none.ops.length,0)
})

test('④SETTINGS_CONFLICT 一次 → 重读重试成功且只落一次写；连续冲突 → teloa/version-conflict',async()=>{
 const settings=fakeSettings(undefined,{conflictOnce:true}),credentials=fakeCredentials({configured:true})
 await ensureOllamaRoute({settings,credentials},localAddress,[model],[])
 assert.equal(settings.ops.length,1)
 assert.equal(settings.ops[0]![2],4)
 const always=fakeSettings(undefined)
 always.mutate=async()=>{throw Object.assign(Error('stale'),{code:'SETTINGS_CONFLICT'})}
 await assert.rejects(ensureOllamaRoute({settings:always,credentials},localAddress,[model],[]),error=>code(error)==='teloa/version-conflict')
 // 非冲突错误原样上抛
 const broken=fakeSettings(undefined)
 broken.mutate=async()=>{throw new Error('disk full')}
 await assert.rejects(ensureOllamaRoute({settings:broken,credentials},localAddress,[model],[]),/disk full/)
})

test('⑤没有 llm-pi-ai → teloa/dependency-unavailable，且不碰凭据',async()=>{
 const credentials=fakeCredentials({configured:false})
 await assert.rejects(ensureOllamaRoute({settings:fakeSettings(undefined,{hasPiAi:false}),credentials},localAddress,[model],[]),error=>code(error)==='teloa/dependency-unavailable')
 assert.equal(credentials.sets.length,0)
})

test('⑥settings 不可写 → teloa/forbidden，且不碰凭据',async()=>{
 const credentials=fakeCredentials({configured:false})
 await assert.rejects(ensureOllamaRoute({settings:fakeSettings(undefined,{writable:false}),credentials},localAddress,[model],[]),error=>code(error)==='teloa/forbidden')
 assert.equal(credentials.sets.length,0)
})

test('⑦凭据已配置不 set；未配置 set 一次且值为常量占位；凭据不可写 → teloa/dependency-unavailable',async()=>{
 const configured=fakeCredentials({configured:true})
 await ensureOllamaRoute({settings:fakeSettings(undefined),credentials:configured},localAddress,[model],[])
 assert.equal(configured.sets.length,0)
 const missing=fakeCredentials({configured:false})
 await ensureOllamaRoute({settings:fakeSettings(undefined),credentials:missing},localAddress,[model],[])
 assert.deepEqual(missing.sets,[['OLLAMA_API_KEY',OLLAMA_PLACEHOLDER_CREDENTIAL]])
 assert.equal(OLLAMA_PLACEHOLDER_CREDENTIAL,'ollama')
 const readonly=fakeSettings(undefined)
 await assert.rejects(ensureOllamaRoute({settings:readonly,credentials:fakeCredentials({configured:false,writable:false})},localAddress,[model],[]),error=>code(error)==='teloa/dependency-unavailable')
 assert.equal(readonly.ops.length,0)
})

test('⑧地址非本机 → displayName 为「外部 Ollama（host）」，baseURL 用该地址加 /v1',async()=>{
 const settings=fakeSettings(undefined)
 await ensureOllamaRoute({settings,credentials:fakeCredentials({configured:true})},readOllamaAddress('http://ollama.lan:11434'),[model],[])
 const route=ollama(settings)
 assert.equal(route.displayName,'外部 Ollama（ollama.lan）')
 assert.equal(route.baseURL,'http://ollama.lan:11434/v1')
})
test('读取原生解析后的 value：user 空层不能遮掉组合已有路由；同名用户模型不取得删除权',async()=>{
 const settings=fakeSettings({displayName:'已有路由',models:[model,{id:'foo:latest'}]})
 const describe=settings.describe
 settings.describe=()=>describe().map(row=>({...row,user:{}}))
 const owned=await ensureOllamaRoute({settings,credentials:fakeCredentials({configured:true})},localAddress,[model],[])
 assert.deepEqual(owned,[])
 assert.equal(settings.ops.length,0)
 assert.equal(ollama(settings).displayName,'已有路由')
})
test('已有路由指向另一服务或协议：拒绝写入与凭据变更，避免拉取和推理连接不同地址',async()=>{
 for(const overrides of [{baseURL:'http://other.lan:11434/v1'},{api:'anthropic-messages'}]){
  const settings=fakeSettings({...overrides,models:[]}),credentials=fakeCredentials({configured:false})
  await assert.rejects(ensureOllamaRoute({settings,credentials},localAddress,[model],[]),error=>code(error)==='teloa/version-conflict')
  assert.equal(settings.ops.length,0);assert.equal(credentials.sets.length,0)
 }
})

test('移除最后一项不能向 DSH 写空 models，撤下该连接；其他连接不受影响',async()=>{
 const settings=fakeSettings({models:[model]}),credentials=fakeCredentials({configured:true})
 await removeFromOllamaRoute({settings,credentials},model.id,localAddress)
 assert.deepEqual(settings.ops[0]?.[1],[{op:'unset',path:['providers','ollama']}])
 assert.equal((settings.current().providers as Record<string,unknown>).ollama,undefined)
})
