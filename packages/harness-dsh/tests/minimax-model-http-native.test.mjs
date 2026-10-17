import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from '../../../scripts/runtime/native-runtime.mjs'

const project=resolve(fileURLToPath(new URL('../../..',import.meta.url)))
const sse=[
 {type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',content:[],model:'MiniMax-M3',usage:{input_tokens:1,output_tokens:0}}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'本机合成回包。'}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:6}},
 {type:'message_stop'},
].map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join('')

test('真实受管SDK使用可选宿主fetch，凭据等待期间冻结原端口；无端口仍走官方默认fetch',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-model-http-native-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const plan=await prepareNativeRuntime({programRoot:project,runtimeRoot:root});installNativeRuntime(plan)
 const require=createRequire(join(project,'package.json')),official=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const {Context}=await import(pathToFileURL(official.resolve('@deepseek-ai/cordis')).href),{LlmRuntime,createUserMessage}=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-llm')).href),plugin=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 let credentialEntered=false,release;const gate=new Promise(resolve=>{release=resolve});t.after(release)
 ctx.provide('credentials',{async resolve(){credentialEntered=true;await gate;return {value:'synthetic-minimax-key'}}})
 let provided=0,used=0,defaults=0
 const receive=async(_url,init)=>{
  const body=JSON.parse(init.body);assert.equal(body.model,'MiniMax-M3');assert.deepEqual(body.thinking,{type:'disabled'})
  assert.equal(new Headers(init.headers).get('x-api-key'),'synthetic-minimax-key')
  return new Response(sse,{headers:{'content-type':'text/event-stream'}})
 }
 let transport=async(...args)=>{used++;return receive(...args)}
 ctx.provide('dshLlmHttp',{forProvider(provider){provided++;assert.equal(provider,'minimax');return transport}})
 await ctx.plugin(LlmRuntime);await ctx.plugin(plugin,{providers:{minimax:{apiKeyEnv:'MINIMAX_SYNTHETIC'}}})
 const request={provider:'minimax',model:'MiniMax-M3',reasoningEffort:'off',maxTokens:64,messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'合成测试，不访问外网。'}]})]}
 const read=async()=>{let text='';for await(const chunk of ctx.llm.stream(request))if(chunk.type==='text-delta')text+=chunk.text;return text}
 const first=read();while(!credentialEntered)await new Promise(resolve=>setImmediate(resolve))
 transport=()=>{throw Error('等待凭据不能更换在途调用已经固定的传输')};release()
 assert.equal(await first,'本机合成回包。');assert.equal(used,1);assert.equal(provided,1)
 transport=undefined
 const original=globalThis.fetch;globalThis.fetch=async(...args)=>{defaults++;return receive(...args)}
 try{assert.equal(await read(),'本机合成回包。');assert.equal(defaults,1);assert.equal(used,1)}finally{globalThis.fetch=original}
})
