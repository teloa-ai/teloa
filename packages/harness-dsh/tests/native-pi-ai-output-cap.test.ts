import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'

test('原生 pi-ai 在固定调用中给出有限输出上限；模型目录、提供方配置与显式请求依次生效',{timeout:20000},async t=>{
 const runtime=await realpath(await mkdtemp(join(tmpdir(),'teloa-output-cap-')))
 t.after(()=>rm(runtime,{recursive:true,force:true}))
 const program=await realpath(fileURLToPath(new URL('../../../',import.meta.url)))
 const native=await import(pathToFileURL(join(program,'scripts/runtime/native-runtime.mjs')).href)
 native.installNativeRuntime(await native.prepareNativeRuntime({programRoot:program,runtimeRoot:runtime}))
 const [{Context},{LlmRuntime,createUserMessage}]=await Promise.all([import('@deepseek-ai/cordis'),import('@deepseek-ai/dsh-llm')])
 const host=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
 const piAi=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
 const key='TELOA_TEST_OUTPUT_CAP_KEY',oldKey=process.env[key],fetch=globalThis.fetch
 process.env[key]='local-fixture-only'
 let network=0
 globalThis.fetch=async()=>{network++;throw Error('元数据回归不允许供应商请求')}
 t.after(()=>{globalThis.fetch=fetch;if(oldKey===undefined)delete process.env[key];else process.env[key]=oldKey})
 for(const configured of [undefined,32768]){
  const ctx=new Context()
  try{
   await ctx.plugin(LlmRuntime)
   await ctx.plugin(piAi,{providers:{minimax:{apiKeyEnv:key,...(configured===undefined?{}:{modelOverrides:{'MiniMax-M3':{maxTokens:configured}}})}}})
   const seen:number[]=[]
   // 真实 llm/stream 入口读取固定上限，在提供方 I/O 前收尾；不伪造真实模型质量证据。
   ctx.on('llm/stream',async function*(request){assert.equal(typeof request.maxTokens,'number');seen.push(request.maxTokens!);yield {type:'finish' as const,reason:{kind:'stop' as const}}})
   for(const explicit of [undefined,8192]){
    const call=await ctx.llm.prepareCall({provider:'minimax',model:'MiniMax-M3',...(explicit===undefined?{}:{maxTokens:explicit})})
    assert.equal(call.config.maxTokens,explicit??configured??512000)
    assert.ok(Object.isFrozen(call.config))
    for await(const _chunk of call.stream({...call.config,messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'合成上限核对'}]})],tools:[]})){}
   }
   assert.deepEqual(seen,[configured??512000,8192])
  }finally{await ctx.fiber.dispose()}
 }
 assert.equal(network,0)
})
