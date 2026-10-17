import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,createUserMessage,type ContentBlock} from '@deepseek-ai/dsh-llm'
import {readMarketCatalogIndex} from '@teloa/contract'
import {officialCatalogIndex} from '../../backend/src/market/official-catalog-snapshot.ts'
import {retiredMinimaxEntry} from './fixtures/retired-catalog-entries.ts'

// 按 MiniMax 模型配方（协议与端点）配置 DSH 原生 pi-ai 路由，检查回复流的块类型（不覆盖界面渲染）。
// 市场目录 2026.10.14.5 起不再收录 MiniMax 条目；MiniMax 仍可在原生模型设置/BYOK 配置，配方取自已下架条目夹具（固定来源与摘要），不回目录。
// 内存替身按 MiniMax 国内站两种接口的回复形态作答，形态以 2026-10-07 在国际站同款接口上的真实请求为准：
// OpenAI 兼容接口（/v1/chat/completions）不传 reasoning_split 时，把思考以 <think>…</think> 混在正文；
// Anthropic 兼容接口（/anthropic/v1/messages）把思考放在独立 thinking 块，M2.7 每次都会思考。替身不发真实请求。
const MINIMAX_CN_ORIGIN='https://api.minimax.cn'
const MINIMAX_CN_ANTHROPIC=MINIMAX_CN_ORIGIN+'/anthropic'
const MODEL='MiniMax-M2.7'
const THINKING='用户问 1+1，答案是 2。'
const ANSWER='2'

const sse=(events:readonly [string|null,object][],tail='')=>new Response(events.map(([name,data])=>(name===null?'':'event: '+name+'\n')+'data: '+JSON.stringify(data)+'\n\n').join('')+tail,{headers:{'content-type':'text/event-stream'}})

function minimaxReply(url:URL):Response{
 if(url.pathname==='/v1/chat/completions')return sse([
  [null,{id:'fixture',object:'chat.completion.chunk',model:MODEL,choices:[{index:0,delta:{role:'assistant',content:'<think>\n'+THINKING+'\n</think>\n\n'+ANSWER},finish_reason:null}]}],
  [null,{id:'fixture',object:'chat.completion.chunk',model:MODEL,choices:[{index:0,delta:{},finish_reason:'stop'}]}],
 ],'data: [DONE]\n\n')
 if(url.pathname==='/anthropic/v1/messages')return sse([
  ['message_start',{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:MODEL,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:12,output_tokens:0}}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:THINKING}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'fixture-signature'}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],
  ['content_block_start',{type:'content_block_start',index:1,content_block:{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:1,delta:{type:'text_delta',text:ANSWER}}],
  ['content_block_stop',{type:'content_block_stop',index:1}],
  ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:8}}],
  ['message_stop',{type:'message_stop'}],
 ])
 throw new Error('MiniMax 国内站没有这个接口：'+url.href)
}

test('按 MiniMax 模型配方配置 DSH pi-ai 路由：思考作为 reasoning 块返回，正文不含 <think>，请求发往国内站 Anthropic 兼容接口',async()=>{
 const index=readMarketCatalogIndex(officialCatalogIndex,text=>createHash('sha256').update(text).digest('hex'))
 assert.equal(index.entries.find(row=>row.id==='teloa.model.minimax'),undefined,'当前目录已不收录 MiniMax 条目，配方只来自夹具')
 const entry=retiredMinimaxEntry
 assert.ok(entry.kind==='model'&&entry.model.form==='cloud'&&entry.model.cloud.provider.kind==='custom','MiniMax 配方须给出自定义协议与端点')
 const {provider,models}=entry.model.cloud
 const model=models.find(row=>row.id===MODEL)
 assert.ok(model,'条目须列出 '+MODEL)
 const previous=globalThis.fetch,ctx=new Context(),seen:string[]=[]
 const key='TELOA_TEST_MINIMAX_KEY',oldKey=process.env[key]
 process.env[key]='local-test-only'
 try{
  globalThis.fetch=async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input))
   assert.equal(url.origin,MINIMAX_CN_ORIGIN,'只能请求 MiniMax 国内站');assert.equal(init?.method??(input instanceof Request?input.method:'GET'),'POST')
   seen.push(url.pathname)
   return minimaxReply(url)
  }
  await ctx.plugin(LlmRuntime)
  const host=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const piAi=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  await ctx.plugin(piAi,{providers:{'teloa-market-minimax':{apiKeyEnv:key,api:provider.api,baseURL:provider.baseURL,
   models:[{id:model.id,...(model.contextWindow===null?{}:{contextWindow:model.contextWindow}),...(model.maxTokens===null?{}:{maxTokens:model.maxTokens})}]}}})
  const blocks:ContentBlock[]=[]
  let finished=false
  for await(const chunk of ctx.llm.stream({provider:'teloa-market-minimax',model:model.id,messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'1+1 等于几？只回答数字。'}]})],tools:[],signal:AbortSignal.timeout(5000)})){
   if(chunk.type==='finish'){finished=true;assert.deepEqual(chunk.reason,{kind:'stop'})}
   if(chunk.type==='block-end')blocks.push(chunk.block)
  }
  assert.ok(finished,'回复流须正常结束')
  const text=blocks.flatMap(block=>block.type==='text'?[block.text]:[]).join('')
  assert.doesNotMatch(text,/<\/?think>/,'回复正文不能出现内联思考标签')
  assert.equal(text.trim(),ANSWER)
  assert.deepEqual(blocks.flatMap(block=>block.type==='reasoning'?[block.text]:[]),[THINKING],'思考须作为 reasoning 块返回')
  assert.deepEqual(seen,['/anthropic/v1/messages'],'只发一次请求，且发往国内站 Anthropic 兼容接口')
  assert.equal(provider.baseURL,MINIMAX_CN_ANTHROPIC)
 }finally{
  try{await ctx.fiber.dispose()}finally{
   globalThis.fetch=previous
   if(oldKey===undefined)delete process.env[key];else process.env[key]=oldKey
  }
 }
})
