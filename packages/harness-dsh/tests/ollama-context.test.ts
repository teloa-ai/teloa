import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareOllamaContext,ollamaContextBudget} from '../src/ollama-context.ts'
import type {OllamaRunningModel} from '../src/ollama-client.ts'

const digest='sha256:'+'a'.repeat(64),name='qwen3:4b'
test('准备按空加载后的同版本运行容量定预算，标称上限只能收紧',async()=>{
 let loaded=false
 const client={load:async()=>{loaded=true},ps:async()=>{assert.ok(loaded);return [{name,digest,contextLength:4096}]}}
 const allocated=await prepareOllamaContext(client,name,digest,new AbortController().signal)
 assert.deepEqual(ollamaContextBudget(allocated,40960,8192),{contextWindow:4096,maxTokens:2048})
 assert.deepEqual(ollamaContextBudget(131072,32768,4096),{contextWindow:32768,maxTokens:4096})
 assert.deepEqual(ollamaContextBudget(4096,null,1024),{contextWindow:4096,maxTokens:1024})
})
test('没有实际容量、只有其他模型、摘要不一致，均不能接入',async()=>{
 for(const rows of [[],[{name:'other:1b',digest,contextLength:4096}],[{name,digest:null,contextLength:4096}],[{name,digest:'sha256:'+'b'.repeat(64),contextLength:4096}],[{name,digest,contextLength:null}]] as OllamaRunningModel[][]){
  // 终审 Minor 1：容量未报告是运行时版本问题（source-invalid），不与「暂不可核实」（source-unavailable）混用，也不进入远程兜底。
  const expected=rows.some(row=>row.name===name&&row.digest!==digest)?'teloa/version-conflict':rows.some(row=>row.name===name&&row.digest===digest&&row.contextLength===null)?'teloa/source-invalid':'teloa/source-unavailable'
  await assert.rejects(prepareOllamaContext({load:async()=>{},ps:async()=>rows},name,digest,new AbortController().signal),{code:expected})
 }
})
test('取消贯穿加载和运行容量查询，不得在取消后继续核验',async()=>{
 const controller=new AbortController();let reads=0
 await assert.rejects(prepareOllamaContext({load:async()=>{controller.abort()},ps:async()=>{reads++;return []}},name,digest,controller.signal),{name:'AbortError'})
 assert.equal(reads,0)
 let loads=0
 await assert.rejects(prepareOllamaContext({load:async()=>{loads++},ps:async()=>[]},name,digest,controller.signal),{name:'AbortError'})
 assert.equal(loads,0)
})
