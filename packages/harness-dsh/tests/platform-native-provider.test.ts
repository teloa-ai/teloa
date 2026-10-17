import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import type {ResolvedSubagentStartRequest,SubagentProvider} from '@deepseek-ai/dsh-subagent'
import {createPlatformNativeProvider} from '../src/platform-native-provider.ts'
import {createPlatformModelAccess} from '../src/platform-model-connection.ts'

async function fixture(t:import('node:test').TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-platform-provider-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 let token:string|undefined='platform-only',disposed=0,calls=0
 const configurations:Record<string,unknown>[]=[],spawns:unknown[]=[]
 ctx.provide('subprocess',{spawn:(spec:unknown)=>{spawns.push(spec);return {}}})
 const native={Config:(value:unknown)=>value,apply(context:Context,config:Record<string,unknown>){
  configurations.push(config)
  const provider={name:'codex',capabilities:{},inheritsParentContext:false,async start(request:ResolvedSubagentStartRequest){
   calls++;context.subprocess.spawn({argv:['native','app-server','--stdio'],env:config.env as Record<string,string>,cwd:request.cwd,stdio:{stdin:'pipe',stdout:'pipe',stderr:'pipe'},graceMs:1000})
   return {id:'external',result:Promise.resolve({stopReason:'completed',output:[]}),dispose:async()=>{disposed++}}
  }}
  context.subagents.registerProvider(provider as unknown as SubagentProvider)
 }}
 const settings={describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers:{'teloa-platform-responses':{api:'openai-responses',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',baseURL:'https://platform.example.test/v1',models:[{id:'platform-model'}]}}}}]}
 const access=createPlatformModelAccess({settings,credentials:{resolve:async()=>token?{value:token,source:'file'}:undefined}})
 const provider=createPlatformNativeProvider(ctx,native,{engine:'codex',native:{env:{OPENAI_API_KEY:'personal-key',SAFE_SETTING:'keep'},model:'personal-model'},runtimeRoot:root,access})
 const request=(platform=true)=>({parent:{session:{requestContext:()=>({provider:platform?'teloa-platform-responses':'byok'})}},cwd:root,prompt:[{type:'text',text:'fixture'}],signal:new AbortController().signal}) as unknown as ResolvedSubagentStartRequest
 return {provider,request,configurations,spawns,setToken:(value:string|undefined)=>{token=value},facts:()=>({calls,disposed})}
}
test('BYOK 沿原官方提供方执行，不要求平台登录且保留原配置',async t=>{
 const f=await fixture(t);f.setToken(undefined)
 const run=await f.provider.start!(f.request(false));await run.result
 assert.equal(f.configurations.at(-1)!.model,'personal-model')
 assert.equal((f.configurations.at(-1)!.env as Record<string,string>).OPENAI_API_KEY,'personal-key')
})
test('平台执行只把平台模型 Token 交给官方提供方，不继承个人密钥',async t=>{
 const f=await fixture(t),run=await f.provider.start!(f.request());await run.result
 const config=f.configurations.at(-1)!,env=config.env as Record<string,string>
 assert.equal(config.model,'platform-model');assert.equal(env.TELOA_PLATFORM_MODEL_TOKEN,'platform-only')
 assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.SAFE_SETTING,'keep')
 assert.equal(f.facts().calls,1)
})
test('平台凭据缺失时零原生启动，不能回退本人账号',async t=>{
 const f=await fixture(t);f.setToken(undefined)
 await assert.rejects(f.provider.start!(f.request()),/平台模型/)
 assert.equal(f.facts().calls,0)
})

test('共享 subprocess 二次合并环境时，平台模式显式移除个人路由开关',async t=>{
 const names=['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','AWS_PROFILE','OPENAI_BASE_URL','NODE_OPTIONS']
 const saved=names.map(name=>[name,process.env[name]] as const)
 t.after(()=>{for(const [name,value] of saved){if(value===undefined)delete process.env[name];else process.env[name]=value}})
 for(const name of names)process.env[name]='personal-setting'
 const f=await fixture(t),run=await f.provider.start!(f.request());await run.result
 const spec=f.spawns.at(-1) as {env:NodeJS.ProcessEnv}
 for(const name of names){assert.ok(Object.hasOwn(spec.env,name),'必须有显式删除项：'+name);assert.equal(spec.env[name],undefined)}
 assert.equal(spec.env.TELOA_PLATFORM_MODEL_TOKEN,'platform-only')
})
