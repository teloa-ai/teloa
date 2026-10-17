import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire,registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,createUserMessage} from '@deepseek-ai/dsh-llm'
import type {ResolvedSubagentStartRequest} from '@deepseek-ai/dsh-subagent'
import {createPlatformNativeProvider} from '../src/platform-native-provider.ts'
import {createPlatformModelAccess} from '../src/platform-model-connection.ts'

// 本测试实际启动固定 Codex CLI 和 Claude Agent SDK。模型端为回环协议夹具，不能充作真实模型质量。
const project=fileURLToPath(new URL('../../../',import.meta.url)),harness=createRequire(new URL('../package.json',import.meta.url))
const host=createRequire(harness.resolve('@deepseek-ai/dsh/package.json'))
const profile=createRequire(join(project,'.runtime/dsh/profiles/teloa/package.json'))
const nativeNames=['@deepseek-ai/dsh-subagent-codex','@deepseek-ai/dsh-subagent-claude-code']
test('DSH 原生适配器、包内 Codex CLI、Claude Agent SDK 共用平台 Token 完成协议闭环',{timeout:90_000,skip:process.env.TELOA_NATIVE_PLATFORM_ACCEPTANCE!=='1'},async t=>{
 for(const name of nativeNames){let found=false;try{found=existsSync(profile.resolve(name))}catch{};assert.ok(found,'此隔离验收需要已登记的官方可选包：'+name)}
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-platform-three-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const ambient={CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',AWS_PROFILE:'isolated-personal-route-must-not-load',OPENAI_BASE_URL:'http://127.0.0.1:1/personal'}
 const saved=Object.keys(ambient).map(name=>[name,process.env[name]] as const)
 t.after(()=>{for(const [name,value] of saved){if(value===undefined)delete process.env[name];else process.env[name]=value}})
 Object.assign(process.env,ambient)
 const token='isolated-platform-model-token',marker='PLATFORM_NATIVE_PROTOCOL_OK',seen:Array<{path:string;model:string;platformToken:boolean}>=[]
 const server=createServer(async(req,res)=>{
  const buffers:Buffer[]=[];for await(const chunk of req)buffers.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(buffers).toString()||'{}'),path=new URL(req.url!,'http://127.0.0.1').pathname
  const authorized=req.headers.authorization==='Bearer '+token||req.headers['x-api-key']===token
  seen.push({path,model:body.model,platformToken:authorized})
  if(!authorized){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture credential rejected'}}));return}
  if(path.endsWith('/count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":4}');return}
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'})
  const event=(type:string,value:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
  if(path.endsWith('/responses')){
   const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:marker,annotations:[]}]}
   const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:4,output_tokens:5,total_tokens:9}}
   event('response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}})
   event('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}})
   event('response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:marker})
   event('response.output_item.done',{type:'response.output_item.done',output_index:0,item})
   event('response.completed',{type:'response.completed',response})
  }else{
   event('message_start',{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:4,output_tokens:0}}})
   event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
   event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:marker}})
   event('content_block_stop',{type:'content_block_stop',index:0})
   event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})
   event('message_stop',{type:'message_stop'})
  }
  res.end()
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port
 // 模拟项目自带的个人服务配置；平台执行不得让它选择另一条认证路径。
 await mkdir(join(root,'.codex'));await mkdir(join(root,'.claude'))
 await writeFile(join(root,'.codex/config.toml'),`model_provider = "personal"\n[model_providers.personal]\nname = "Personal"\nbase_url = "${base}/personal"\nwire_api = "responses"\nexperimental_bearer_token = "personal-fixture-token"\n`)
 await writeFile(join(root,'.claude/settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:base+'/personal',ANTHROPIC_AUTH_TOKEN:'personal-fixture-token'}}))
 const routes={
  'teloa-platform-responses':{displayName:'平台 Responses',api:'openai-responses',baseURL:base+'/v1',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',models:[{id:'gpt-5.6-sol',contextWindow:4096,maxTokens:128}]},
  'teloa-platform-messages':{displayName:'平台 Messages',api:'anthropic-messages',baseURL:base+'/anthropic',apiKeyEnv:'TELOA_PLATFORM_MODEL_TOKEN',models:[{id:'claude-sonnet-4-6',contextWindow:4096,maxTokens:128}]},
 }
 // 同官方 profile 的共享 peer 解析：只处理已安装可选包缺失的 DSH peers，不替换原生可执行文件。
 const hooks=registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(!specifier.startsWith('@deepseek-ai/'))throw error;return next(pathToFileURL(host.resolve(specifier)).href,context)}}});t.after(()=>hooks.deregister())
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 ctx.provide('credentials',{resolve:async()=>({value:token,source:'file'}),readRecord:async()=>undefined,modifyRecord:async()=>{throw Error('协议验收不能写入个人登录')},deleteRecord:async()=>{},listRecords:async()=>[]})
 const access=createPlatformModelAccess({settings:{describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers:routes}}]},credentials:{resolve:async()=>({value:token,source:'file'})},allowLoopbackHttp:true})
 t.after(()=>access.dispose())
 ctx.plugin(LlmRuntime)
 const pi=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
 await ctx.plugin(pi,{providers:routes})
 const blocks:unknown[]=[]
 for await(const chunk of ctx.llm.stream({provider:'teloa-platform-messages',model:'claude-sonnet-4-6',messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'只返回协议标记。'}]})]})){if(chunk.type==='block-end')blocks.push(chunk.block);if(chunk.type==='finish')assert.equal(chunk.reason.kind,'stop',JSON.stringify(chunk.reason))}
 assert.ok(JSON.stringify(blocks).includes(marker),'DSH 原生模型回复必须实际回流')
 const local=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-subprocess-local')).href)
 await ctx.plugin(local.default??local.LocalSubprocessRuntime)
 for(const [index,engine] of (['codex','claude-code'] as const).entries()){
  const native=await import(pathToFileURL(profile.resolve(nativeNames[index]!)).href)
  const provider=createPlatformNativeProvider(ctx,native,{engine,native:{permissionMode:engine==='codex'?'never':'dontAsk',env:{NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}},runtimeRoot:root,access})
  const request={parent:{session:{requestContext:()=>({provider:'teloa-platform-messages'})}},cwd:root,prompt:[{type:'text',text:'不调用工具，只回复协议标记。'}],signal:AbortSignal.timeout(60_000)} as unknown as ResolvedSubagentStartRequest
  const run=await provider.start!(request)
  t.after(()=>run.dispose())
  const result=await run.result
  assert.equal(result.stopReason,'completed',engine+' 必须由真实引擎报告完成：'+JSON.stringify(result))
  assert.ok(JSON.stringify(result.output).includes(marker),engine+' 的原生最终文本必须回流')
 }
 assert.ok(seen.some(row=>row.path.endsWith('/responses')))
 assert.ok(seen.filter(row=>row.path.endsWith('/messages')).length>=2)
 const inference=seen.filter(row=>row.path.endsWith('/responses')||row.path.endsWith('/messages'))
 assert.equal(inference.length,3)
 assert.ok(inference.every(row=>row.platformToken),'三引擎推理只能使用同一平台模型 Token：'+JSON.stringify(seen))
 assert.ok(seen.filter(row=>!inference.includes(row)).every(row=>!row.platformToken),'非推理探测不得携带平台令牌')
})
