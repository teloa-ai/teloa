import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {credentialRef} from '@deepseek-ai/dsh-credentials'
import Provider from '../src/credentials/provider.ts'
import {tempHome,memoryKeyring} from './fixtures/credentials.ts'
import {connectPlatformModelAccount} from '../src/platform-account.ts'

test('本人Host凭据源优先且不可写，失效不回退存量平台Token，BYOK不变',async t=>{
 const ctx=new Context(),dshHome=await tempHome(t),keyring=memoryKeyring();t.after(()=>ctx.fiber.dispose())
 class Mounted extends Provider{constructor(c:Context){super(c,{dshHome},{keyring:keyring.port,env:{},keyDir:dshHome+'/keys'})}}
 await ctx.plugin(Mounted)
 const ref=credentialRef('TELOA_PLATFORM_MODEL_TOKEN');await ctx.credentials.set(ref,'old-static-platform-token')
 await ctx.credentials.set(credentialRef('BYOK_KEY'),'byok-value')
 let token:string|undefined='current-account-token'
 ctx.provide('teloaPlatformCredentialSource',{resolve:async()=>token?{value:token,source:'platform-account'}:undefined})
 assert.equal((await ctx.credentials.resolve(ref))?.value,'current-account-token')
 assert.equal((await ctx.credentials.describe(ref)).writable,false)
 await assert.rejects(ctx.credentials.set(ref,'personal-fallback'))
 token=undefined;assert.equal(await ctx.credentials.resolve(ref),undefined)
 assert.equal((await ctx.credentials.resolve(credentialRef('BYOK_KEY')))?.value,'byok-value')
})

test('Host目录合并三种原生协议，保留BYOK；通道关闭后拒绝旧平台Token',async t=>{
 const ctx=new Context(),dshHome=await tempHome(t),keyring=memoryKeyring();t.after(()=>ctx.fiber.dispose())
 class Mounted extends Provider{constructor(c:Context){super(c,{dshHome},{keyring:keyring.port,env:{},keyDir:dshHome+'/keys'})}}
 await ctx.plugin(Mounted);await ctx.credentials.set(credentialRef('TELOA_PLATFORM_MODEL_TOKEN'),'old-static-platform-token')
 const byok={api:'anthropic-messages',apiKeyEnv:'BYOK_KEY',models:[{id:'byok-model'}]},providers:Record<string,unknown>={byok}
 const settings={describe:()=>[{ns:'llm-pi-ai',revision:7,value:{providers}}],mutate:async(ns:string,ops:Array<{path:readonly string[];value:unknown}>,revision:number)=>{assert.equal(ns,'llm-pi-ai');assert.equal(revision,7);for(const op of ops)providers[op.path[1]!]=op.value}}
 ctx.provide('settings',settings as never)
 const routes=Object.fromEntries([['teloa-platform-responses','openai-responses'],['teloa-platform-messages','anthropic-messages'],['teloa-platform-completions','openai-completions']].map(([id,api])=>[id,{api,baseURL:'https://platform.example.test/'+(api==='anthropic-messages'?'anthropic':'v1'),apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',models:[{id:'platform-model'}]}]))
 let notify:()=>void=()=>{},closed=false,changes=0;ctx.on('credentials/reference-updated',()=>{changes++})
 const binding=await connectPlatformModelAccount(ctx,{connection:async()=>({schema:'teloa.platform-model-connection/v1',token:'current-account-token',expiresAt:Date.now()+60000,routes}),subscribe:listener=>{notify=listener;return ()=>{}},close:()=>{closed=true}})
 assert.equal(Object.keys(providers).length,4);assert.equal(providers.byok,byok);assert.equal((await ctx.credentials.resolve(credentialRef('TELOA_PLATFORM_MODEL_TOKEN')))?.source,'platform-account')
 notify();assert.equal(changes,1);binding.close();assert.equal(closed,true);assert.equal(changes,2);await assert.rejects(ctx.credentials.resolve(credentialRef('TELOA_PLATFORM_MODEL_TOKEN')))
})

test('首次未授额或离线后自动恢复平台目录，不需重启Host或自动执行',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());let available=false,calls=0
 const providers:Record<string,unknown>={};ctx.provide('settings',{describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers}}],mutate:async(_ns:string,ops:Array<{path:readonly string[];value:unknown}>)=>{for(const op of ops)providers[op.path[1]!]=op.value}} as never)
 t.mock.timers.enable({apis:['setInterval']})
 const binding=await connectPlatformModelAccount(ctx,{connection:async()=>{calls++;if(!available)throw Error('offline');return {schema:'teloa.platform-model-connection/v1',token:'recovered-token',expiresAt:Date.now()+60000,routes:{'teloa-platform-responses':{api:'openai-responses',baseURL:'https://platform.example.test/v1',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',models:[{id:'recovered-model'}]}}}},subscribe:()=>()=>{},close:()=>{}})
 assert.equal(Object.keys(providers).length,0);available=true;t.mock.timers.tick(15000);await new Promise(resolve=>setImmediate(resolve));assert.equal(Object.keys(providers).length,1)
 const completedCalls=calls;t.mock.timers.tick(15000);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,completedCalls);binding.close()
})
