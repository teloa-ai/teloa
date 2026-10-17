import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import type {Context} from '@deepseek-ai/cordis'

const file=new URL('../src/model-catalog-readiness.ts',import.meta.url)
async function load(){assert.ok(existsSync(file),'原生目录缺少凭据元数据投影');return import('../src/model-catalog-readiness.ts')}
const catalog={default:{provider:'missing',model:'m'},groups:[{id:'missing',name:'Unconfigured',models:[{id:'m',name:'Model M'}]},{id:'ready',name:'Configured',models:[{id:'r',name:'Model R'}]},{id:'ambient',name:'Ambient auth',models:[{id:'a',name:'Model A'}]}],routableProviders:['missing','ready','ambient'],failures:[],hasProviderApiKey:true}
function host(){const calls:{describeOptions:unknown[];refs:string[];resolve:number}={describeOptions:[],refs:[],resolve:0};const configured=new Set(['READY_KEY']);const ctx={llm:{listConfigurableProviders:()=>['missing','ready','ambient'].map(provider=>({provider,settingsNs:'models',settingsPath:['providers',provider]}))},settings:{describe:(options:unknown)=>{calls.describeOptions.push(options);return [{ns:'models',value:{providers:{missing:{apiKeyEnv:'MISSING_KEY',apiKey:'private-secret'},ready:{apiKeyEnv:'READY_KEY'},ambient:{}}}}]}},credentials:{describe:async(ref:string)=>{calls.refs.push(ref);return {configured:configured.has(ref)}},resolve:async()=>{calls.resolve++;throw Error('must not read secret')}}} as unknown as Context;return {ctx,calls,configured}}
test('只读凭据描述过滤已确认缺密钥的原生候选，保留默认身份、顺序与未核实路由',async()=>{
 const {readModelCatalogReadiness,runnableModelCatalog}=await load(),f=host(),original=structuredClone(catalog),state=await readModelCatalogReadiness(f.ctx,catalog,new AbortController().signal)
 assert.deepEqual(state.missingCredentialProviders,['missing']);const projected=runnableModelCatalog(state)
 assert.deepEqual(projected.groups.map(row=>row.id),['ready','ambient']);assert.deepEqual(projected.routableProviders,['ready','ambient']);assert.deepEqual(projected.default,catalog.default)
 assert.deepEqual(catalog,original);assert.deepEqual(f.calls.describeOptions,[{redactSecrets:true}]);assert.equal(f.calls.resolve,0);assert.doesNotMatch(JSON.stringify(projected),/private-secret|MISSING_KEY|READY_KEY|apiKeyEnv/)
})
test('凭据更新立即体现在同一读入口，旧快照不被篡改，描述失败不伪造已配置或缺失',async()=>{
 const {readModelCatalogReadiness,runnableModelCatalog}=await load(),f=host(),before=await readModelCatalogReadiness(f.ctx,catalog)
 f.configured.add('MISSING_KEY');const after=await readModelCatalogReadiness(f.ctx,catalog)
 assert.deepEqual(before.missingCredentialProviders,['missing']);assert.deepEqual(after.missingCredentialProviders,[]);assert.equal(runnableModelCatalog(after).groups.length,3)
 f.ctx.credentials.describe=async()=>{throw Error('private credentials error')};const unknown=await readModelCatalogReadiness(f.ctx,catalog)
 assert.deepEqual(unknown.missingCredentialProviders,[]);assert.doesNotMatch(JSON.stringify(unknown),/private credentials error/)
})
test('凭据描述迟到后取消不能发布目录，取消之前不读取元数据或密钥值',async()=>{
 const {readModelCatalogReadiness}=await load(),f=host(),controller=new AbortController();controller.abort()
 await assert.rejects(readModelCatalogReadiness(f.ctx,catalog,controller.signal),{name:'AbortError'});assert.equal(f.calls.refs.length,0)
 const next=new AbortController();f.ctx.credentials.describe=async()=>{next.abort();return {configured:false} as any}
 await assert.rejects(readModelCatalogReadiness(f.ctx,catalog,next.signal),{name:'AbortError'});assert.equal(f.calls.resolve,0)
})
test('官方账号登录路由不以 BYOK 密钥判断，不读取无关的账号凭据引用',async()=>{
 const {readModelCatalogReadiness}=await load(),f=host()
 f.ctx.llm.listConfigurableProviders=()=>[{provider:'deepseek-account',displayName:'Account',settingsNs:'models',settingsPath:['providers','missing']}]
 const state=await readModelCatalogReadiness(f.ctx,catalog)
 assert.deepEqual(state.missingCredentialProviders,[]);assert.deepEqual(f.calls.refs,[]);assert.equal(f.calls.resolve,0)
})
