import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import {inject} from '../src/index.ts'

async function fixture(providerInject:string[]){
 const ctx=new Context(),routes=new Set<string>()
 // 只替代凭据存储和 HTTP 监听；真实服务提供方是兄弟 fiber，根提供会掩盖漏注入。
 ctx.provide('credentials',{modifyRecord:async(_key:unknown,update:(value:undefined)=>Promise<unknown>)=>update(undefined)})
 await ctx.plugin({name:'http-provider',apply:(owner:Context)=>{owner.provide('webServer',{register:(route:{path:string})=>{routes.add(route.path);return ()=>routes.delete(route.path)}})}})
 // attachments 不能是空桩：Connection 装配时按聚合图片上限核对请求体容量，
 // 这里给 attachment-local 的默认 200 MiB，与真实组合同一条判据。
 const stub=(service:string)=>service==='attachments'?{imageLimits:{maxMessageImageBytes:209715200}}:{}
 for(const service of inject)if(service!=='connection'&&service!=='webServer'&&service!=='credentials')ctx.provide(service,stub(service))
 // 对应 Cordis loader 将配置行 inject 与原插件 inject 合并后的依赖声明。
 await ctx.plugin({...Connection,inject:[...Connection.inject,...providerInject]})
 const register=(extraInject:string[]=[])=>ctx.plugin({name:'teloa-rpc-registration',inject:[...inject,...extraInject],apply:(owner:Context)=>{owner.connection.rpc.handle('/teloa',async()=>({ok:true,value:'ready'}))}})
 return {ctx,routes,register}
}

test('rc.1 独立 RPC 要求 Connection 提供方注入 webServer，仅调用方注入不足',async t=>{
 const missing=await fixture([]);t.after(()=>missing.ctx.fiber.dispose())
 await assert.rejects(async()=>{await missing.register(['webServer'])},/cannot get property "webServer" without inject/)
 assert.equal(missing.routes.has('/teloa'),false)
})

test('Connection 提供方补齐 webServer 后，RPC 注册成功且归调用方卸载',async t=>{
 const ready=await fixture(['webServer']);t.after(()=>ready.ctx.fiber.dispose())
 const mounted=ready.register();await mounted
 assert.equal(ready.routes.has('/teloa'),true)
 await mounted.dispose()
 assert.equal(ready.routes.has('/teloa'),false,'卸载宿主必须撤回自己的 RPC 通道')
 assert.equal(ready.routes.has('/api'),true,'原生 Connection 路由继续由原生 fiber 持有')
})
