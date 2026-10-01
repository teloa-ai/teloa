import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {mcpToolFullName} from '@teloa/contract'
import {createIndustryMcpConnectionHandler} from '../src/industry-mcp-connections.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
const contentId='42345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'reference-mcp',contentId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+contentId,state:'needs_connection' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{serverName:'teloa_reference',tools:[{raw:'read_reference',fullName:'mcp__teloa_reference__read_reference'}],definitionHash:'b'.repeat(64),observedAt:stamp}}
const instantiateInput={requestId:id,loadId,itemInstanceId}

test('行业 MCP 连接入口固定本人并把 AbortSignal 交给真实连接',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryMcpConnectionHandler('owner',async()=>({
  instantiate:async(...args)=>{calls.push(['instantiate',...args]);return record},
  connect:async(...args)=>{calls.push(['connect',...args]);return active},
  get:async(...args)=>{calls.push(['get',...args]);return record},
  list:async(...args)=>{calls.push(['list',...args]);return {items:[record]}},
 }))
 const signal=new AbortController().signal
 assert.deepEqual(await handler('industry-mcp-connections/instantiate',instantiateInput),record)
 assert.deepEqual(await handler('industry-mcp-connections/connect',{requestId:id,instanceId:id,expectedRevision:1},signal),active)
 assert.deepEqual(await handler('industry-mcp-connections/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-mcp-connections/list',{}),{items:[record]})
 assert.deepEqual(calls,[['instantiate','owner',instantiateInput],['connect','owner',{requestId:id,instanceId:id,expectedRevision:1},signal],['get','owner',{instanceId:id}],['list','owner',{}]])
})

test('行业 MCP 连接入口拒绝伪造字段、可用状态与重复映射',async()=>{
 let opened=0
 const unopened=createIndustryMcpConnectionHandler('owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const payload of [{...instantiateInput,ownerId:'other'},{...instantiateInput,scope:'general'},{...instantiateInput,itemInstanceId:'bad'}])await assert.rejects(unopened('industry-mcp-connections/instantiate',payload),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 await assert.rejects(unopened('industry-mcp-connections/connect',{requestId:id,instanceId:id,expectedRevision:1,serverName:'forged'},new AbortController().signal),{code:'teloa/invalid-input'})
 const bad=createIndustryMcpConnectionHandler('owner',async()=>({instantiate:async()=>({...record,state:'active'}),connect:async()=>({...active,binding:{...active.binding,tools:[{raw:'x',fullName:'mcp__other__x'}]}}),get:async()=>({...record,state:'active'}),list:async()=>({items:[record,{...record,id:contentId}]})}))
 await assert.rejects(bad('industry-mcp-connections/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-mcp-connections/connect',{requestId:id,instanceId:id,expectedRevision:1},new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-mcp-connections/list',{}),{code:'teloa/invalid-host-response'})
})

test('正式宿主在 RPC 前初始化并路由行业 MCP 连接端点',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializeIndustryMcpConnections\(pool\)/)
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 assert.notEqual(initializeIndex,-1)
 assert.ok(initializeIndex<source.indexOf("connection.rpc.handle('/teloa'"))
 assert.match(source,/\.\.\.industryMcpConnectionEndpoints/)
 assert.match(source,/industryMcpConnectionHandler\(endpoint,payload,signal\)/)
 assert.match(source,/IndustryMcpConnectionSource\(market,loads\)/)
 assert.match(source,/createIndustryMcpReadiness\(\(\)=>ctx\.tools\.schemas\(\)/)
})

test('行业 MCP 连接入口接受带点号的原始工具名及其归一化完整名（飞书官方 MCP 形态）',async()=>{
 const raw='im.v1.message.list',fullName=mcpToolFullName('lark',raw)
 assert.match(fullName,/^mcp__lark__im_v1_message_list_[a-f0-9]{12}$/)
 const lark={...active,binding:{...active.binding,serverName:'lark',tools:[{raw,fullName}]}}
 const handler=createIndustryMcpConnectionHandler('owner',async()=>({instantiate:async()=>record,connect:async()=>lark,get:async()=>lark,list:async()=>({items:[lark]})}))
 assert.deepEqual(await handler('industry-mcp-connections/connect',{requestId:id,instanceId:id,expectedRevision:1}),lark)
 // 未归一化的简单拼接名在宿主注册表里并不存在，必须判为回包不一致。
 const forged={...lark,binding:{...lark.binding,tools:[{raw,fullName:'mcp__lark__'+raw}]}}
 await assert.rejects(createIndustryMcpConnectionHandler('owner',async()=>({instantiate:async()=>record,connect:async()=>forged,get:async()=>forged,list:async()=>({items:[forged]})}))('industry-mcp-connections/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
})
