import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkAttentionHandler} from '../src/work-attention.ts'

const page={schema:'teloa.work-attention/v1',items:[],incomplete:[]}
test('正式需要你端点固定本人并只转发目录查询，不接受调用方替换身份',async()=>{
 const calls:unknown[]=[]
 const handle=createWorkAttentionHandler('local:owner',async()=>({listWorkAttention:async(owner,input)=>{calls.push({owner,input});return page}}))
 assert.deepEqual(await handle({scope:'SOC',limit:50}),page)
 assert.deepEqual(calls,[{owner:'local:owner',input:{scope:'SOC',limit:50}}])
 await assert.rejects(()=>handle({ownerId:'other'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})

test('目录取消不返回迟到的结果；无效真源回执不伪装可用',async()=>{
 const abort=new AbortController(),cancelled=createWorkAttentionHandler('local:owner',async()=>({listWorkAttention:async()=>{abort.abort();return page}}))
 await assert.rejects(()=>cancelled({},abort.signal),{name:'AbortError'})
 const invalid=createWorkAttentionHandler('local:owner',async()=>({listWorkAttention:async()=>({...page,items:[{source:{kind:'url',href:'https://example.com'}}]})}))
 await assert.rejects(()=>invalid({}),{code:'teloa/invalid-host-response'})
})
