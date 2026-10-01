import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createConnectorHandler} from '../src/connectors.ts'

const instanceId='12345678-1234-4234-8234-123456789012',probedAt='2026-09-14T00:00:00.000Z'
const ok={kind:'data-source' as const,instanceId,probedAt,ok:true as const}
const failed={kind:'mcp' as const,instanceId,probedAt,ok:false as const,reason:'MCP 服务当前没有登记这些工具。'}

test('连接器测试连接入口固定本人并把 AbortSignal 交给真实探针',async()=>{
 const calls:unknown[][]=[]
 const handler=createConnectorHandler('owner',async()=>({probe:async(...args)=>{calls.push(args);return (args[1] as {kind:string}).kind==='mcp'?failed:ok}}))
 const signal=new AbortController().signal
 assert.deepEqual(await handler('connectors/probe',{kind:'data-source',instanceId},signal),ok)
 assert.deepEqual(await handler('connectors/probe',{kind:'mcp',instanceId},signal),failed)
 assert.deepEqual(calls,[['owner',{kind:'data-source',instanceId},signal],['owner',{kind:'mcp',instanceId},signal]])
})

test('连接器测试连接入口拒绝未知端点、非法字段与未知连接类型',async()=>{
 let opened=0
 const unopened=createConnectorHandler('owner',async()=>{opened++;throw Error('不应打开服务')})
 await assert.rejects(unopened('connectors/authorize',{kind:'data-source',instanceId},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('connectors/probe',{kind:'plugin',instanceId},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('connectors/probe',{kind:'data-source',instanceId,expectedRevision:1},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('connectors/probe',{kind:'data-source',instanceId:'not-a-uuid'},new AbortController().signal),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

test('连接器测试连接入口拒绝回包身份不符或携带白名单之外字段',async()=>{
 const mismatchedKind=createConnectorHandler('owner',async()=>({probe:async()=>({...ok,kind:'mcp'})}))
 await assert.rejects(mismatchedKind('connectors/probe',{kind:'data-source',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
 const mismatchedId=createConnectorHandler('owner',async()=>({probe:async()=>({...ok,instanceId:'22345678-1234-4234-8234-123456789012'})}))
 await assert.rejects(mismatchedId('connectors/probe',{kind:'data-source',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
 const leaking=createConnectorHandler('owner',async()=>({probe:async()=>({...ok,details:'不该出现'})}))
 await assert.rejects(leaking('connectors/probe',{kind:'data-source',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
 const noReason=createConnectorHandler('owner',async()=>({probe:async()=>{const {reason:_reason,...rest}=failed;return rest}}))
 await assert.rejects(noReason('connectors/probe',{kind:'mcp',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
 const badStamp=createConnectorHandler('owner',async()=>({probe:async()=>({...ok,probedAt:'不是时刻'})}))
 await assert.rejects(badStamp('connectors/probe',{kind:'data-source',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
 // reason 里混入 C0 控制字符（垂直换行 \x0b）：禁 C0/DEL 控制字符，沿用 business-definitions.ts:16 的正则。
 const controlChar=createConnectorHandler('owner',async()=>({probe:async()=>({...failed,reason:'第一行\x0b第二行'})}))
 await assert.rejects(controlChar('connectors/probe',{kind:'mcp',instanceId},new AbortController().signal),{code:'teloa/invalid-host-response'})
})

test('正式宿主在 RPC 前初始化并路由连接器测试连接端点，且只读复用三个既有就绪端口',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 assert.notEqual(initializeIndex,-1)
 assert.ok(initializeIndex<source.indexOf("connection.rpc.handle('/teloa'"))
 assert.match(source,/\.\.\.connectorEndpoints/)
 assert.match(source,/connectorHandler\(endpoint,payload,signal\)/)
 assert.match(source,/new ConnectorProbeService\(pool,identity,\{/)
 // 三个就绪端口原样复用推进路径已在用的那三个，不新建第二套核验逻辑。
 assert.match(source,/ready:createIndustryDataSourceReadiness\(\[securityAlertSource\],identity\.now\)\.ready/)
 assert.match(source,/ready:createIndustryMcpReadiness\(\(\)=>ctx\.tools\.schemas\(\),identity\.now\)\.ready/)
 assert.match(source,/ready:securityReadiness\.ready/)
})
