import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import type {ModelReference} from '@teloa/contract'
import {isDshRemoteModel,remoteModelAddress,resolveTaskModelPolicy} from '../src/task-model-dsh.ts'
const local={provider:'ollama',model:'small'},remote={provider:'remote',model:'large',reasoningEffort:'high'}
const signal=new AbortController().signal
function host(defaultModel:ModelReference=remote,providers:Record<string,unknown>={remote:{baseURL:'https://api.example.test/v1'},ollama:{baseURL:'http://127.0.0.1:11434/v1'}}){
 return {sessionController:{modelCatalog:async()=>({default:defaultModel})},llm:{listConfigurableProviders:()=>['ollama','remote','deepseek'].map(provider=>({provider,settingsNs:'llm-pi-ai',settingsPath:['providers',provider],declared:provider!=='deepseek'})),resolveCallConfig:async(config:ModelReference)=>config},settings:{describe:()=>[{ns:'llm-pi-ai',value:{providers}}]}} as unknown as Context
}
test('环回、映射地址和自定义无地址的路由不能充当远程备用',()=>{
 for(const address of ['http://localhost:11434','http://127.0.0.2','http://127.1','http://[::1]','http://[::ffff:127.0.0.1]','http://0.0.0.0','http://x.localhost','file:///tmp/a','https://user:secret@example.test'])assert.equal(remoteModelAddress(address),false,address)
 assert.equal(remoteModelAddress('https://api.example.test/v1'),true)
 assert.equal(isDshRemoteModel(host(),local),false)
 assert.equal(isDshRemoteModel(host(remote,{}),remote),false)
 assert.equal(isDshRemoteModel(host(remote,{}),{provider:'deepseek',model:'v4'}),true)
 assert.equal(isDshRemoteModel(host(remote,{deepseek:{baseURL:'http://127.0.0.1'}}),{provider:'deepseek',model:'v4'}),false)
})
test('官方 llm-deepseek 路由：未配置地址按官方公网端点视为远程，配置了环回地址不算远程',()=>{
 const official=(value:Record<string,unknown>)=>({sessionController:{modelCatalog:async()=>({default:remote})},llm:{listConfigurableProviders:()=>[{provider:'deepseek-official',settingsNs:'llm-deepseek',settingsPath:[]},{provider:'ollama',settingsNs:'llm-pi-ai',settingsPath:['providers','ollama']}],resolveCallConfig:async(config:ModelReference)=>config},settings:{describe:()=>[{ns:'llm-deepseek',value},{ns:'llm-pi-ai',value:{providers:{ollama:{baseURL:'http://127.0.0.1:11434/v1'}}}}]}} as unknown as Context)
 assert.equal(isDshRemoteModel(official({apiKeyEnv:'DEEPSEEK_API_KEY'}),{provider:'deepseek-official',model:'deepseek-v4-pro'}),true)
 assert.equal(isDshRemoteModel(official({baseURL:'https://gateway.example.test/anthropic'}),{provider:'deepseek-official',model:'deepseek-v4-pro'}),true)
 assert.equal(isDshRemoteModel(official({baseURL:'http://127.0.0.1:9/anthropic'}),{provider:'deepseek-official',model:'deepseek-v4-pro'}),false)
 assert.equal(isDshRemoteModel(official({}),local),false)
 // 其他未知命名空间的适配器仍不猜测。
 const unknown={...official({}),llm:{listConfigurableProviders:()=>[{provider:'other',settingsNs:'llm-other',settingsPath:[]}]}} as unknown as Context
 assert.equal(isDshRemoteModel(unknown,{provider:'other',model:'x'}),false)
})
test('只认岗位明确配置的远程备用：首选本地、全局默认为云端也不自动兜底；显式备用才进入策略',async()=>{
 assert.deepEqual(await resolveTaskModelPolicy(host(),{model:local},signal),{primary:local})
 assert.deepEqual(await resolveTaskModelPolicy(host(local),undefined,signal),{primary:local})
 assert.deepEqual(await resolveTaskModelPolicy(host(),undefined,signal),{primary:remote})
 assert.deepEqual(await resolveTaskModelPolicy(host(local),{fallbackModel:remote},signal),{primary:local,fallback:remote})
})

test('DSH 0.2 拆分的 API key 与账号路由可显式选作远程备用，配置环回地址时仍拒绝',async()=>{
 for(const [provider,settingsNs] of [['deepseek-official','llm-deepseek-api-key'],['deepseek-account','llm-deepseek-account']]){
  const model={provider:provider!,model:'deepseek-flash'}
  const ctx=host(local)
  ctx.llm.listConfigurableProviders=()=>[{provider:provider!,displayName:'DeepSeek',settingsNs:settingsNs!,settingsPath:[]}]
  const settings=Reflect.get(ctx,'settings') as {describe:()=>unknown[]}
  settings.describe=()=>[{ns:settingsNs,value:{}}]
  assert.deepEqual(await resolveTaskModelPolicy(ctx,{model:local,fallbackModel:model},signal),{primary:local,fallback:model})
  settings.describe=()=>[{ns:settingsNs,value:{baseURL:'http://127.0.0.1:9'}}]
  await assert.rejects(resolveTaskModelPolicy(ctx,{model:local,fallbackModel:model},signal),{stage:'model-resolve'})
 }
})
test('备用配置不可用显式失败；不暴露底层原文，也不偷偷换成另一个远程',async()=>{
 await assert.rejects(resolveTaskModelPolicy(host(),{model:remote,fallbackModel:local},signal),{stage:'model-resolve'})
 const ctx=host();ctx.llm.resolveCallConfig=async()=>{throw Error('private credential value')}
 await assert.rejects(resolveTaskModelPolicy(ctx,{model:local,fallbackModel:remote},signal),(error:any)=>error.stage==='model-resolve'&&!error.message.includes('private'))
 const abort=new AbortController();abort.abort()
 await assert.rejects(resolveTaskModelPolicy(host(),undefined,abort.signal),{name:'AbortError'})
})

test('未配置全局默认时显式岗位模型仍可使用，未选任何模型则稳定拒绝',async()=>{
 const ctx=host({provider:'',model:''})
 assert.deepEqual(await resolveTaskModelPolicy(ctx,{model:local},signal),{primary:local})
 await assert.rejects(resolveTaskModelPolicy(ctx,undefined,signal),{stage:'model-resolve'})
})
