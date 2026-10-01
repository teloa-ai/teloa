import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryMcpConnectionApi} from '../src/client/industry-mcp-connection-api.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'local:teloa-owner',loadId,itemInstanceId,itemLocalId:'threat-intel-mcp',contentId:'42345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,state:'needs_connection' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{serverName:'threat-intel',tools:[{raw:'lookup_indicator',fullName:'mcp__threat-intel__lookup_indicator'}],definitionHash:'b'.repeat(64),observedAt:stamp}}

test('行业 MCP 连接 API 登记固定来源并以预期版本显式连接',async()=>{
 const calls:unknown[][]=[]
 const api=createIndustryMcpConnectionApi(async(method,payload)=>{calls.push([method,payload]);return method.endsWith('/list')?{items:[record]}:method.endsWith('/connect')?active:record})
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.deepEqual(await api.connect({requestId:id,instanceId:id,expectedRevision:1}),active)
 assert.deepEqual(await api.get(id),record)
 assert.deepEqual(await api.list(),{items:[record]})
 assert.deepEqual(calls,[['industry-mcp-connections/instantiate',{requestId:id,loadId,itemInstanceId}],['industry-mcp-connections/connect',{requestId:id,instanceId:id,expectedRevision:1}],['industry-mcp-connections/get',{instanceId:id}],['industry-mcp-connections/list',{}]])
})

test('行业 MCP 连接 API 拒绝映射漂移、伪造可用状态与重复实例',async()=>{
 const api=(value:unknown)=>createIndustryMcpConnectionApi(async()=>value)
 await assert.rejects(api({...record,loadId:id}).instantiate({requestId:id,loadId,itemInstanceId}),/映射/)
 await assert.rejects(api({...record,state:'active'}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...active,binding:{...active.binding,tools:[{raw:'lookup_indicator',fullName:'mcp__other__lookup_indicator'}]}}).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api({...active,binding:{...active.binding,serverName:'threat intel'}}).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api({...active,binding:{...active.binding,tools:[]}}).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api({...active,binding:{...active.binding,observedAt:'2026-09-14T00:00:00Z'}}).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api(active).connect({...{requestId:id,instanceId:id,expectedRevision:1},serverName:'forged'} as never),/请求格式/)
 await assert.rejects(api({items:[record,{...record,id:'52345678-1234-4234-8234-123456789012'}]}).list(),/重复/)
 // 逐行失败项不得自身重复，也不得与已返回的实例身份重合。
 await assert.rejects(api({items:[record],errors:[{instanceId:record.id,code:'teloa/storage-corrupt'}]}).list(),/格式/)
 await assert.rejects(api({items:[record],errors:[{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/storage-corrupt'},{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/source-unavailable'}]}).list(),/格式/)
})

test('行业 MCP 连接核验失败保留原请求并以完全相同参数恢复',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},input={requestId:id,instanceId:id,expectedRevision:1},calls:unknown[][]=[]
 const api=createIndustryMcpConnectionApi(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('连接断开');return active},journal)
 await assert.rejects(api.connect(input),/连接断开/)
 assert.deepEqual(api.pending(),input)
 assert.match(raw||'',/teloa\.industry-mcp-connect\/v1/)
 assert.deepEqual(createIndustryMcpConnectionApi(async()=>active,journal).pending(),input)
 assert.deepEqual(await api.recover(),active)
 assert.deepEqual(calls,[['industry-mcp-connections/connect',input],['industry-mcp-connections/connect',input]])
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('行业 MCP 连接登记不写恢复日志，日志损坏时停止核验',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryMcpConnectionApi(async()=>record,journal)
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.equal(raw,null)
 assert.equal(api.pending(),undefined)
 const damaged=createIndustryMcpConnectionApi(async()=>active,{read:()=>'{broken',write:()=>{},clear:()=>{}})
 assert.equal(damaged.recoveryMessage()?.code,'teloa/storage-corrupt')
 await assert.rejects(damaged.connect({requestId:id,instanceId:id,expectedRevision:1}),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
 await assert.rejects(damaged.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('行业 MCP 连接核验被明确拒绝时清除恢复记录',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryMcpConnectionApi(async()=>{throw Object.assign(Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(api.connect({requestId:id,instanceId:id,expectedRevision:1}),/版本冲突/)
 assert.equal(journal.read(),null)
 assert.equal(api.pending(),undefined)
})

test('行业 MCP 连接 API 接受带点号的原始工具名与归一化完整名，仍拒绝跨服务器完整名',async()=>{
 // 飞书官方 MCP 的工具名形如 im.v1.message.list；DSH 公开名把点号换成下划线并追加 12 位摘要，服务端冻结的就是这个名字。
 const lark={...active,binding:{...active.binding,serverName:'lark',tools:[{raw:'im.v1.message.list',fullName:'mcp__lark__im_v1_message_list_0123456789ab'}]}}
 assert.deepEqual(await createIndustryMcpConnectionApi(async()=>lark).connect({requestId:id,instanceId:id,expectedRevision:1}),lark)
 await assert.rejects(createIndustryMcpConnectionApi(async()=>({...lark,binding:{...lark.binding,tools:[{raw:'im.v1.message.list',fullName:'mcp__other__im_v1_message_list_0123456789ab'}]}})).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(createIndustryMcpConnectionApi(async()=>({...lark,binding:{...lark.binding,tools:[{raw:'im.v1.message.list',fullName:'mcp__lark__im.v1.message.list'}]}})).connect({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
})
