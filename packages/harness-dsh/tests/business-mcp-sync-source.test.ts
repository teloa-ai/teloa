import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {readBusinessSourceMappingDefinition,type MarketCatalogConnectorEntry} from '@teloa/contract'
import {createMcpSyncSource,type ManagedMcpToolInvoker} from '../src/business-mcp-sync-source.ts'
import {createManagedMcpConnectionHandler,type InstallFn} from '../src/managed-mcp-connections.ts'

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url))
const mapping=(itemsPath:string,args:Record<string,string|number|boolean>={})=>readBusinessSourceMappingDefinition({
 format:'teloa.business-source-mapping/v1',id:'soc-sync',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',
 source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:args,itemsPath},
 mapping:[{path:'$.id',field:'id'}],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false,
})
const code=(value:string)=>({code:value})

const tools=(connected:boolean,readOnly:boolean|((server:string,tool:string)=>boolean))=>({connected:()=>connected,readOnly:typeof readOnly==='function'?readOnly:()=>readOnly})

test('连接门先于只读门：未连接即 source-unavailable 带 sourceState:disconnected；已连接非只读才 forbidden「只允许只读工具」；两者皆真才调工具',async()=>{
 let calls=0
 const invoke:ManagedMcpToolInvoker=async()=>{calls++;return {items:[]}}
 await assert.rejects(createMcpSyncSource(invoke,tools(false,true))(mapping('$.items')),(error:{code:string;message:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.details?.sourceState==='disconnected'&&error.message.includes('连接未建立'))
 // 未连接时 readOnly 也必然为假：此时仍报「没接上」而不是 forbidden，钉住先判连接的顺序。
 await assert.rejects(createMcpSyncSource(invoke,tools(false,false))(mapping('$.items')),(error:{code:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.details?.sourceState==='disconnected')
 await assert.rejects(createMcpSyncSource(invoke,tools(true,false))(mapping('$.items')),(error:{code:string;message:string;details?:Record<string,unknown>})=>error.code==='teloa/forbidden'&&error.message.includes('只允许只读工具')&&JSON.stringify(error.details)==='{"toolGate":true}','只读门的 forbidden 带 toolGate，预览只认这一种转 invalid-input')
 assert.equal(calls,0)
 const port=await createMcpSyncSource(invoke,tools(true,true))(mapping('$.items'))
 await port.fetch({scope:'SOC',pageSize:50})
 assert.equal(calls,1)
})

test('按 itemsPath 取出数组、参数原样加游标透传；取不到数组、工具抛错都是 source-unavailable 且不透传原错误',async()=>{
 const seen:unknown[]=[]
 let reply:unknown={data:{items:[{id:'a'},{id:'b'}]}}
 const invoke:ManagedMcpToolInvoker=async input=>{seen.push(input);if(reply instanceof Error)throw reply;return reply}
 const resolver=createMcpSyncSource(invoke,tools(true,(server,tool)=>server==='soc'&&tool==='list_alerts'))
 const port=await resolver(readBusinessSourceMappingDefinition({...mapping('$.data.items',{status:'open'}),incrementalCursor:{path:'$.id',kind:'sequence'}}))
 assert.equal(port.key,'soc/list_alerts')
 const page=await port.fetch({scope:'SOC',pageSize:50})
 assert.deepEqual(page.items,[{id:'a'},{id:'b'}])
 assert.ok(!Number.isNaN(Date.parse(page.capturedAt)))
 assert.equal('nextCursor' in page,false)
 await port.fetch({scope:'SOC',pageSize:50,cursor:'2026-09-25T00:00:00.000Z'})
 assert.deepEqual(seen.map(item=>(item as {arguments:unknown}).arguments),[{status:'open'},{status:'open',cursor:'2026-09-25T00:00:00.000Z'}])
 reply={data:{items:{id:'a'}}}
 await assert.rejects(port.fetch({scope:'SOC',pageSize:50}),code('teloa/source-unavailable'))
 reply={data:{items:[{id:'a'},{id:'b'},{id:'c'}]}}
 await assert.rejects(port.fetch({scope:'SOC',pageSize:2}),code('teloa/source-unavailable'))
 reply=new Error('secret-token-123 leaked')
 await assert.rejects(port.fetch({scope:'SOC',pageSize:50}),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&!error.message.includes('secret-token-123'))
 await assert.rejects(resolver(readBusinessSourceMappingDefinition({...mapping('$.items'),source:{kind:'role-result'}})),code('teloa/source-unavailable'))
})

const paged=(pagination:{cursorArgument:string;nextCursorPath:string},incremental=false)=>readBusinessSourceMappingDefinition({
 ...mapping('$.items',{status:'open'}),source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open'},itemsPath:'$.items',pagination},
 ...(incremental?{incrementalCursor:{path:'$.id',kind:'sequence'}}:{}),
})
const badCursor=(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message==='受管 MCP 工具结果里的下一页游标不合法；未写入。'

test('声明式分页：续页参数按 cursorArgument 透传、按 nextCursorPath 取下一页；整数转字符串，null 结束；水位每页都带',async()=>{
 const seen:Array<Record<string,unknown>>=[]
 const pages:Record<string,unknown>={first:{items:[{id:'a'}],meta:{next:'p2'}},p2:{items:[{id:'b'}],meta:{next:2}},'2':{items:[{id:'c'}],meta:{next:null}}}
 const invoke:ManagedMcpToolInvoker=async input=>{seen.push(input.arguments);return pages[String(input.arguments.page??'first')]}
 const port=await createMcpSyncSource(invoke,tools(true,true))(paged({cursorArgument:'page',nextCursorPath:'$.meta.next'}))
 const first=await port.fetch({scope:'SOC',pageSize:50})
 assert.equal(first.nextCursor,'p2')
 const second=await port.fetch({scope:'SOC',pageSize:50,pageToken:'p2'})
 assert.equal(second.nextCursor,'2','安全整数游标转字符串')
 const third=await port.fetch({scope:'SOC',pageSize:50,pageToken:'2'})
 assert.equal('nextCursor' in third,false,'null 即最后一页')
 assert.deepEqual(seen,[{status:'open'},{status:'open',page:'p2'},{status:'open',page:'2'}])
 // 带水位：每一页都带 cursor（水位），续页另带 page。
 seen.length=0
 const incremental=await createMcpSyncSource(invoke,tools(true,true))(paged({cursorArgument:'page',nextCursorPath:'$.meta.next'},true))
 await incremental.fetch({scope:'SOC',pageSize:50,cursor:'7'})
 await incremental.fetch({scope:'SOC',pageSize:50,cursor:'7',pageToken:'p2'})
 assert.deepEqual(seen,[{status:'open',cursor:'7'},{status:'open',cursor:'7',page:'p2'}])
 // 游标缺失、空串同样表示结束。
 for(const meta of [{},{next:''}]){
  const single=await createMcpSyncSource(async()=>({items:[],meta}),tools(true,true))(paged({cursorArgument:'page',nextCursorPath:'$.meta.next'}))
  assert.equal('nextCursor' in await single.fetch({scope:'SOC',pageSize:50}),false)
 }
})

test('声明式分页：下一页游标是对象、小数、超 1024 字、带控制字符或首尾空白都是 source-unavailable「下一页游标不合法」',async()=>{
 for(const next of [{page:2},[1],1.5,true,Number.MAX_SAFE_INTEGER+2,'x'.repeat(1025),'a\u0000b','a\nb',' p2','   ']){
  const port=await createMcpSyncSource(async()=>({items:[{id:'a'}],next}),tools(true,true))(paged({cursorArgument:'page',nextCursorPath:'$.next'}))
  await assert.rejects(port.fetch({scope:'SOC',pageSize:50}),badCursor,JSON.stringify(next))
 }
 const ok=await createMcpSyncSource(async()=>({items:[],next:'x'.repeat(1024)}),tools(true,true))(paged({cursorArgument:'page',nextCursorPath:'$.next'}))
 assert.equal((await ok.fetch({scope:'SOC',pageSize:50})).nextCursor?.length,1024,'恰好 1024 字合法')
})

test('未声明 pagination：与一期相同只取一页，结果里的游标字段一概不看',async()=>{
 const seen:Array<Record<string,unknown>>=[]
 const port=await createMcpSyncSource(async input=>{seen.push(input.arguments);return {items:[{id:'a'}],next:{bad:true},nextCursor:'p2'}},tools(true,true))(readBusinessSourceMappingDefinition({...mapping('$.items',{status:'open'}),incrementalCursor:{path:'$.id',kind:'sequence'}}))
 const page=await port.fetch({scope:'SOC',pageSize:50,cursor:'w1'})
 assert.equal('nextCursor' in page,false)
 assert.deepEqual(seen,[{status:'open',cursor:'w1'}])
})

test('声明式分页的上限：单页字节、整条分页链累计字节与耗时，超出即 source-unavailable 且点明是哪一项',async()=>{
 const pagination={cursorArgument:'page',nextCursorPath:'$.next'}
 const big=await createMcpSyncSource(async()=>({items:[{id:'a',body:'x'.repeat(200)}],next:'p2'}),tools(true,true),{maxPageBytes:100})(paged(pagination))
 await assert.rejects(big.fetch({scope:'SOC',pageSize:50}),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message.includes('单页')&&error.message.endsWith('未写入。'))
 const chain=await createMcpSyncSource(async()=>({items:[{id:'a',body:'x'.repeat(60)}],next:'p2'}),tools(true,true),{maxChainBytes:250})(paged(pagination))
 await chain.fetch({scope:'SOC',pageSize:50})
 await chain.fetch({scope:'SOC',pageSize:50,pageToken:'p2'})
 await assert.rejects(chain.fetch({scope:'SOC',pageSize:50,pageToken:'p3'}),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message.includes('累计')&&error.message.endsWith('未写入。'))
 // 新的一条分页链（不带续页标记的首页）重新计量。
 await chain.fetch({scope:'SOC',pageSize:50})
 let now=0
 const slow=await createMcpSyncSource(async()=>{now+=60;return {items:[{id:'a'}],next:'p2'}},tools(true,true),{maxChainMs:100,now:()=>now})(paged(pagination))
 await slow.fetch({scope:'SOC',pageSize:50})
 await slow.fetch({scope:'SOC',pageSize:50,pageToken:'p2'})
 await assert.rejects(slow.fetch({scope:'SOC',pageSize:50,pageToken:'p3'}),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message.includes('耗时')&&error.message.endsWith('未写入。'))
})

test('未声明 incrementalCursor：同步器给出的残留水位不透传（续页参数名为 cursor 时第 1 页不带游标）',async()=>{
 const seen:Array<Record<string,unknown>>=[]
 const port=await createMcpSyncSource(async input=>{seen.push(input.arguments);return {items:[{id:'a'}],next:input.arguments.cursor===undefined?'p2':null}},tools(true,true))(paged({cursorArgument:'cursor',nextCursorPath:'$.next'}))
 const first=await port.fetch({scope:'SOC',pageSize:50,cursor:'2026-09-25T00:00:00.000Z'})
 await port.fetch({scope:'SOC',pageSize:50,cursor:'2026-09-25T00:00:00.000Z',pageToken:first.nextCursor!})
 assert.deepEqual(seen,[{status:'open'},{status:'open',cursor:'p2'}])
 const unpaged:Array<Record<string,unknown>>=[]
 await (await createMcpSyncSource(async input=>{unpaged.push(input.arguments);return {items:[]}},tools(true,true))(mapping('$.items',{status:'open'}))).fetch({scope:'SOC',pageSize:50,cursor:'stale'})
 assert.deepEqual(unpaged,[{status:'open'}],'未声明分页也一样：没有 incrementalCursor 就没有水位')
})

const stdioEntry=():MarketCatalogConnectorEntry=>({
 format:'teloa.market-catalog-entry/v1',id:'test.mcp-stdio',kind:'connector',delivery:'managed',version:'1.0.0',
 taxonomy:{functions:['automation'],industries:['general']},upstream:null,
 connector:{
  serverName:'test_stdio',title:{'zh-CN':'测试 stdio','en':'Test stdio'},summary:{'zh-CN':'测试。','en':'Test.'},auth:{kind:'none'},
  recipe:{transport:'stdio',package:'@teloa/mcp-reference',version:'1.0.0',integrity:'sha512-'+'A'.repeat(86)+'==',bin:'lib/main.js',args:[]},
  tools:[
   {name:'list_references',description:{'zh-CN':'列出参考资料','en':'List references'},readOnly:true},
   {name:'read_reference',description:{'zh-CN':'读取参考资料','en':'Read reference'},readOnly:false},
  ],
  upstreamUrl:'https://example.com',
 },
 modifications:[],license:{spdx:'MIT',files:['LICENSE']},
 compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},
 review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
})

test('callTool 真实 stdio 连接：只读工具直调取回 JSON；未连接、非只读、断开后均拒绝',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-mcp-sync-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt)
 await ctx.plugin(ToolRuntime)
 const fakeInstall:InstallFn=async()=>join(projectRoot,'packages/mcp-reference/lib/main.js')
 const executed:string[]=[]
 ctx.on('tools/pre-execute',async(exec,next)=>{executed.push(exec.name);return next()})
 const {handler,callTool,isReadOnlyTool,isConnected}=createManagedMcpConnectionHandler(ctx,root,()=>stdioEntry(),fakeInstall)
 await assert.rejects(callTool('test_stdio','list_references',{},AbortSignal.timeout(5000)),(error:{code:string;message:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.message.includes('连接未建立')&&error.details?.sourceState==='disconnected')
 const added=await handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}
 await handler('mcp-connections/connect',{id:added.id})
 assert.equal(isReadOnlyTool('test_stdio','list_references'),true)
 assert.equal(isReadOnlyTool('test_stdio','read_reference'),false)
 assert.equal(isReadOnlyTool('other','list_references'),false)
 assert.equal(isConnected('test_stdio'),true)
 assert.equal(isConnected('other'),false)
 const value=await callTool('test_stdio','list_references',{},AbortSignal.timeout(10000)) as {schema:string;references:unknown[]}
 assert.equal(value.schema,'teloa.reference-list/v1')
 assert.ok(Array.isArray(value.references)&&value.references.length>0)
 assert.deepEqual(executed,[],'直调不经 tools/pre-execute')
 await assert.rejects(callTool('test_stdio','read_reference',{id:'workbench'},AbortSignal.timeout(5000)),code('teloa/forbidden'))
 const port=await createMcpSyncSource(input=>callTool(input.serverName,input.tool,input.arguments,input.signal??AbortSignal.timeout(10000)),{connected:isConnected,readOnly:isReadOnlyTool})({...mapping('$.references'),source:{kind:'mcp-tool',serverName:'test_stdio',tool:'list_references',arguments:{},itemsPath:'$.references'}})
 assert.ok((await port.fetch({scope:'SOC',pageSize:100})).items.length>0)
 await handler('mcp-connections/disconnect',{id:added.id})
 assert.equal(isReadOnlyTool('test_stdio','list_references'),false)
 assert.equal(isConnected('test_stdio'),false,'断开后连接门关闭')
 // 两道门判完、真正调用前连接断开：同样带「没接上」标记，预览据此不说成「调用失败」。
 await assert.rejects(callTool('test_stdio','list_references',{},AbortSignal.timeout(5000)),{code:'teloa/source-unavailable',details:{sourceState:'disconnected'}})
})

test('callTool：工具回包的文本段不是 JSON、工具报错都是 source-unavailable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-mcp-sync-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const entry:MarketCatalogConnectorEntry={...stdioEntry(),id:'test.mcp-http',connector:{...stdioEntry().connector,serverName:'fake_http',recipe:{transport:'streamable-http',url:'https://example.com/mcp'},tools:[{name:'list',description:{'zh-CN':'列出','en':'List'},readOnly:true}]}}
 let reply:unknown={content:[{type:'text',text:'not json'}]},gone=false
 const audit:string[]=[]
 const ctx={
  plugin:()=>Object.assign(Promise.resolve(),{dispose:async()=>{}}),
  tools:{schemas:()=>[{name:'mcp__fake_http__list'}],get:(name:string)=>name==='mcp__fake_http__list'&&!gone?{execute:async()=>{if(reply instanceof Error)throw reply;return reply}}:undefined},
  logger:{warn:()=>{},info:(format:string,...args:unknown[])=>audit.push([format,...args].join(' | '))},
 } as unknown as Context
 const {handler,callTool,isConnected,isReadOnlyTool}=createManagedMcpConnectionHandler(ctx,root,()=>entry)
 const added=await handler('mcp-connections/add',{catalogId:'test.mcp-http'}) as {id:string}
 await handler('mcp-connections/connect',{id:added.id})
 await assert.rejects(callTool('fake_http','list',{},AbortSignal.timeout(5000)),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message.includes('不是 JSON'))
 reply={content:[{type:'image',data:'x'},{type:'text',text:'{"items":'},{type:'text',text:'[1]}'}]}
 assert.deepEqual(await callTool('fake_http','list',{},AbortSignal.timeout(5000)),{items:[1]})
 reply=new Error('upstream secret')
 await assert.rejects(callTool('fake_http','list',{},AbortSignal.timeout(5000)),(error:{code:string;message:string;details?:unknown})=>error.code==='teloa/source-unavailable'&&!error.message.includes('secret')&&error.details===undefined,'工具报错是调用失败，不带「没接上」标记')
 // 每次调用记一条审计：server、tool、结果状态；不记参数值与结果内容。
 reply={content:[{type:'text',text:'{"items":["row-value-9"]}'}]}
 await callTool('fake_http','list',{token:'arg-value-7'},AbortSignal.timeout(5000))
 assert.equal(audit.length,4)
 assert.deepEqual(audit.map(line=>line.split(' | ').slice(1)),[['fake_http','list','failed'],['fake_http','list','ok'],['fake_http','list','failed'],['fake_http','list','ok']])
 assert.ok(audit.every(line=>!line.includes('arg-value-7')&&!line.includes('row-value-9')&&!line.includes('secret')))
 // structuredContent（MCP 官方结构化结果，DSH dsh-mcp-client 原样透传）是对象时优先用它，不再解析文本段。
 reply={content:[{type:'text',text:'{"items":["from-text"]}'}],structuredContent:{items:['from-structured']}}
 assert.deepEqual(await callTool('fake_http','list',{},AbortSignal.timeout(5000)),{items:['from-structured']})
 reply={content:[{type:'text',text:'not json'}],structuredContent:{items:[]}}
 assert.deepEqual(await callTool('fake_http','list',{},AbortSignal.timeout(5000)),{items:[]},'有对象型 structuredContent 时文本段不是 JSON 也不影响')
 for(const structuredContent of [['from-array'],'text',42,null]){
  reply={content:[{type:'text',text:'{"items":["from-text"]}'}],structuredContent}
  assert.deepEqual(await callTool('fake_http','list',{},AbortSignal.timeout(5000)),{items:['from-text']},'structuredContent 非对象即回落文本段：'+JSON.stringify(structuredContent))
 }
 /**
  * 经过同步源（与 index.ts 生产装配同一写法：invoke 即 callTool，两道门即 isConnected / isReadOnlyTool）：
  * 门判完、fetch 时连接断开，fetch 抛出的错误仍带「没接上」标记——预览据此回 source-disconnected（界面「受管连接 X 还没建立」），
  * 而不是 pull-failed（「来源已接上……」）；工具本身报错仍不带标记、原错误不透传。
  */
 const syncSource=createMcpSyncSource(input=>callTool(input.serverName,input.tool,input.arguments,input.signal??AbortSignal.timeout(60_000)),{connected:isConnected,readOnly:isReadOnlyTool})
 const port=await syncSource({...mapping('$.items'),source:{kind:'mcp-tool',serverName:'fake_http',tool:'list',arguments:{},itemsPath:'$.items'}})
 reply=new Error('upstream secret')
 await assert.rejects(port.fetch({scope:'SOC',pageSize:50}),(error:{code:string;message:string;details?:unknown})=>error.code==='teloa/source-unavailable'&&!error.message.includes('secret')&&error.details===undefined,'经同步源的调用失败不带「没接上」标记')
 // 连接登记还在、工具定义已撤（门判完后断开的窗口）：直调与经同步源都带「没接上」标记。
 gone=true
 await assert.rejects(callTool('fake_http','list',{},AbortSignal.timeout(5000)),(error:{code:string;message:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.message.includes('已断开')&&error.details?.sourceState==='disconnected')
 await assert.rejects(port.fetch({scope:'SOC',pageSize:50}),(error:{code:string;message:string;details?:unknown})=>error.code==='teloa/source-unavailable'&&error.message==='受管连接 fake_http 连接未建立或已断开。'&&JSON.stringify(error.details)==='{"sourceState":"disconnected"}','经同步源仍保留「没接上」标记')
})

test('卡死的工具：超过时限即 source-unavailable 放手（工具不理中止信号也一样），调用方中止照常透传',async()=>{
 const hang:ManagedMcpToolInvoker=()=>new Promise(()=>{})
 const port=await createMcpSyncSource(hang,tools(true,true),{timeoutMs:50})(mapping('$.items'))
 const started=Date.now()
 await assert.rejects(port.fetch({scope:'SOC',pageSize:50,signal:new AbortController().signal}),(error:{code:string;message:string})=>error.code==='teloa/source-unavailable'&&error.message.includes('超时'))
 assert.ok(Date.now()-started<2000)
 const controller=new AbortController()
 const pending=port.fetch({scope:'SOC',pageSize:50,signal:controller.signal})
 controller.abort()
 await assert.rejects(pending,(error:{name?:string})=>error.name==='AbortError')
})
