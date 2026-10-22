import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'

test('静态模板原稿可以在原会话预览，预览不会创建员工或发布分享',async()=>{
 const draft={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',requestId:'22222222-2222-4222-8222-222222222222',entity:'share' as const,body:'{}',bodyHash:'a'.repeat(64),title:'产品交付团队',status:'draft' as const,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'}
 const preview={schema:'teloa.page-create-draft-preview/v1' as const,draft,fields:[],fieldsTruncated:false,consequences:[{kind:'impact' as const,id:'static-template-only',required:true}],next:{endpoint:'template-shares/preview',consentKeys:[]},computedAt:draft.updatedAt}
 const unrelated=async()=>{throw Error('unrelated write handler')}
 const app=createCapabilityDraftApplication({owner:draft.ownerId,scopeIds:async()=>[],services:async()=>({drafts:{read:async()=>draft,apply:unrelated},preview:{preview:async()=>preview}}),marketContentHandler:unrelated,skillInstallationsHandler:unrelated,skillAvailabilityHandler:unrelated,businessSpaceHandler:unrelated,industryLoadsHandler:unrelated,industryMcpConnectionHandler:unrelated,industryDataSourceHandler:unrelated,marketPluginInstallationHandler:unrelated})
 assert.deepEqual(await app.preview({draftId:draft.id}),preview)
})
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {pageCreateFieldRows,type PageCreateDraft} from '@teloa/contract'
import {registerCapabilityDraftTools,registerCustomMcpTools,createCapabilityDraftApplication,capabilityDraftRequestId,customMcpToolNames,capabilityDraftToolNames,type CapabilityDraftApplicationPorts} from '../src/capability-draft-tools.ts'
import {registerMarketSessionTools,marketSessionToolNames} from '../src/market-session-tools.ts'
import {createMarketContentHandler} from '../src/market-content.ts'
import {createSkillInstallationsHandler} from '../src/skill-installations.ts'
import {customMcpDefinitionHash,readCustomMcpDefinition} from '../src/custom-mcp-definition.ts'

const owner='local:teloa-owner',draftId='11111111-1111-4111-8111-111111111111',contentId='22222222-2222-4222-8222-222222222222',installationId='33333333-3333-4333-8333-333333333333',bodyHash='a'.repeat(64)
const skill={id:'content-review',title:'内容核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: content-review\ndescription: Review supplied drafts.\n---\nCheck facts.\n').toString('base64')}]}
const draft:PageCreateDraft={id:draftId,ownerId:owner,requestId:draftId,entity:'skill',body:JSON.stringify(skill),bodyHash,title:'内容核对',status:'draft',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z'}

test('技能预览逐字回读UTF-8文本，固定草案与二进制字段保持原样',async()=>{
 const markdown='---\nname: content-review\ndescription: 事实核对\n---\n'+('中文、繁體、emoji 🐿️；事实/待办/待确认。\r\n'.repeat(40))
 const body={...skill,files:[{path:'SKILL.md',base64:Buffer.from(markdown,'utf8').toString('base64')},{path:'references/note.txt',base64:Buffer.from('\uFEFF保留末尾空白\t\n').toString('base64')},{path:'assets/image.bin',base64:Buffer.from('valid UTF8 binary').toString('base64')},{path:'references/nul.txt',base64:Buffer.from('x\0y').toString('base64')},{path:'references/invalid.txt',base64:Buffer.from([255,254]).toString('base64')}]}
 const saved={...draft,body:JSON.stringify(body)},original={schema:'teloa.page-create-draft-preview/v1' as const,draft:saved,fields:pageCreateFieldRows(body),fieldsTruncated:false,consequences:[],next:{endpoint:'market-content/import-atomic',consentKeys:[]},computedAt:draft.updatedAt}
 const unavailable=async()=>{throw Error('read-only preview must not write or read other resources')}
 const app=createCapabilityDraftApplication({owner,scopeIds:async()=>[],services:async()=>({drafts:{read:async()=>saved,apply:unavailable},preview:{preview:async()=>original}}),marketContentHandler:unavailable,skillInstallationsHandler:unavailable,skillAvailabilityHandler:unavailable,businessSpaceHandler:unavailable,industryLoadsHandler:unavailable,industryMcpConnectionHandler:unavailable,industryDataSourceHandler:unavailable,marketPluginInstallationHandler:unavailable})
 const preview=await app.preview({draftId})
 assert.equal(preview.draft,saved);assert.equal(preview.schema,original.schema)
 const markdownField=preview.fields.find(field=>field.path==='files[0].content')
 assert.ok(markdownField,'技能预览应直接返回Markdown原文')
 assert.equal(JSON.parse(markdownField.value),markdown)
 assert.equal(JSON.parse(preview.fields.find(field=>field.path==='files[1].content')!.value),'\uFEFF保留末尾空白\t\n')
 for(const index of [2,3,4])assert.deepEqual(preview.fields.find(field=>field.path===`files[${index}].base64`),original.fields.find(field=>field.path===`files[${index}].base64`))
 assert.equal(preview.fields.length,original.fields.length)
 assert.equal(original.fields.some(field=>field.path.endsWith('.content')),false,'不改写原预览或固定正文')
})

test('可读技能预览不接受超限正文或跨实体技能结构',async()=>{
 let saved={...draft,body:JSON.stringify({...skill,files:[{path:'SKILL.md',base64:Buffer.from('---\nname: content-review\ndescription: d\n---\n'+'中'.repeat(40000)).toString('base64')}]})}
 const unavailable=async()=>{throw Error('unrelated handler')}
 const app=createCapabilityDraftApplication({owner,scopeIds:async()=>[],services:async()=>({drafts:{read:async()=>saved,apply:unavailable},preview:{preview:async()=>({schema:'teloa.page-create-draft-preview/v1',draft:saved,fields:pageCreateFieldRows(JSON.parse(saved.body)),fieldsTruncated:false,consequences:[],next:{endpoint:'market-content/import-atomic',consentKeys:[]},computedAt:draft.updatedAt})}}),marketContentHandler:unavailable,skillInstallationsHandler:unavailable,skillAvailabilityHandler:unavailable,businessSpaceHandler:unavailable,industryLoadsHandler:unavailable,industryMcpConnectionHandler:unavailable,industryDataSourceHandler:unavailable,marketPluginInstallationHandler:unavailable})
 await assert.rejects(()=>app.preview({draftId}),{code:'teloa/invalid-input'})
 saved={...draft,entity:'role',body:JSON.stringify(skill)}
 await assert.rejects(()=>app.preview({draftId}),{code:'teloa/invalid-input'})
})

async function runtime(ports:Record<string,unknown>={},subagent=false,beforeTools?:(ctx:Context)=>void){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('capability-draft-session'),...(subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'owned-request'},content:[{type:'text',text:'帮我创建技能并配置本人 MCP'}]}),{surfaceOp:'append'})
 const calls:{endpoint:string;payload:unknown}[]=[]
 const base={owner,conversation:async(sessionId:string)=>({ownerId:owner,sessionId,status:'ready' as const}),readTaskPolicy:async()=>null,...ports}
 beforeTools?.(ctx)
 registerCapabilityDraftTools(ctx,{...base,preview:async()=>({schema:'teloa.page-create-draft-preview/v1',draft,fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'skill-installations/install',consentKeys:[]},computedAt:draft.updatedAt}),apply:async input=>{calls.push({endpoint:'apply',payload:input});return {schema:'teloa.capability-draft-result/v1',draft:{...draft,status:'applied',appliedRef:'skill:'+installationId},appliedRef:'skill:'+installationId,readiness:'installed',next:'可加载。'}}})
 registerCustomMcpTools(ctx,{...base,handler:async(endpoint,payload)=>{calls.push({endpoint,payload});return {id:installationId,catalogId:'custom.test',serverName:'test',status:'saved',createdAt:draft.createdAt,updatedAt:draft.updatedAt}}})
 return {ctx,agent,calls,call:(name:string,args:unknown,callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})}
}

test('预览与应用只接受草案身份，保留原生允许/询问/拒绝判断',async t=>{
 const e=await runtime();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 assert.equal((await e.call('teloa_create_preview',{draftId})).isError,false)
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash})).isError,false)
 assert.equal(approvals,0)
 const stop=e.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='teloa_create_apply'?{kind:'ask',reason:'原生具体审批'}:next())
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash},'second')).isError,false);assert.equal(approvals,1);stop()
 e.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='teloa_create_apply'?{kind:'deny',reason:'拒绝修改'}:next())
 const before=e.calls.length
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash},'third')).isError,true);assert.equal(e.calls.length,before)
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash,endpoint:'anything'})).isError,true)
})

test('NL-03 应用工具把本人「暂不启用」原样交给应用端口，非法值拒绝',async t=>{
 const e=await runtime();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash,initialAvailability:'disabled'})).isError,false)
 assert.deepEqual(e.calls.at(-1),{endpoint:'apply',payload:{draftId,expectedBodyHash:bodyHash,initialAvailability:'disabled'}})
 const before=e.calls.length
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash,initialAvailability:'paused'},'bad')).isError,true);assert.equal(e.calls.length,before)
})

test('非本人会话、子代理和任务会话不能创建或配置能力',async t=>{
 for(const value of [{ports:{conversation:async(sessionId:string)=>({ownerId:'other',sessionId,status:'ready'})}},{subagent:true},{ports:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task-run'})}}]){
  const e=await runtime(value.ports??{},value.subagent??false);t.after(()=>e.ctx.fiber.dispose())
  for(const [name,args] of [['teloa_create_preview',{draftId}],['teloa_create_apply',{draftId,expectedBodyHash:bodyHash}],['teloa_mcp_list',{}]] as const)assert.equal((await e.call(name,args)).isError,true)
  assert.equal(e.calls.length,0)
 }
})

test('MCP工具固定路由，保存同调用重试身份稳定，多调用不碰撞且不收凭据',async t=>{
 const e=await runtime();t.after(()=>e.ctx.fiber.dispose())
 const definition=readCustomMcpDefinition({schema:'teloa.mcp-server/v1',serverName:'test',title:'测试服务',transport:'streamable-http',url:'https://example.com/mcp'}),expectedDefinitionHash=customMcpDefinitionHash(definition)
 for(const callId of ['one','two','one'])assert.equal((await e.call('teloa_mcp_save',{definition,expectedDefinitionHash},callId)).isError,false)
 const payloads=e.calls.map(call=>call.payload as {requestId:string})
 assert.equal(e.calls[0]?.endpoint,'mcp-connections/save-custom');assert.notEqual(payloads[0]?.requestId,payloads[1]?.requestId);assert.equal(payloads[0]?.requestId,payloads[2]?.requestId)
 const before=e.calls.length
 assert.equal((await e.call('teloa_mcp_save',{definition:{...definition,credentials:{API_KEY:'secret'}},expectedDefinitionHash})).isError,true)
 assert.equal((await e.call('teloa_mcp_save',{definition,expectedDefinitionHash:'b'.repeat(64)})).isError,true)
 assert.equal(e.calls.length,before)
 for(const [name,args,endpoint] of [['teloa_mcp_connection_connect',{id:installationId},'mcp-connections/connect'],['teloa_mcp_list',{},'mcp-connections/list'],['teloa_mcp_get',{id:installationId},'mcp-connections/get-custom'],['teloa_mcp_disconnect',{id:installationId},'mcp-connections/disconnect'],['teloa_mcp_update',{id:installationId,definition,expectedDefinitionHash},'mcp-connections/update-custom']] as const){assert.equal((await e.call(name,args)).isError,false);assert.equal(e.calls.at(-1)?.endpoint,endpoint)}
})

test('既有目录与自定义 MCP 工具在同一 Context 注册，保持各自连接参数',async t=>{
 const unused=async()=>{throw Error('注册不得调用服务')}
 const e=await runtime({},false,ctx=>registerMarketSessionTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,catalog:unused,github:unused,content:unused,skills:unused,mcp:unused,connectorEntry:()=>undefined,skillSecrets:()=>[],skillSecretMeta:()=>({}),skillSecretGroupMembers:()=>[],industryLoads:unused,industryPrepare:unused,currentSpace:unused,bundledExtensions:unused,localModels:{pullFacts:unused,startPull:unused}}));t.after(()=>e.ctx.fiber.dispose())
 const expected=[...marketSessionToolNames,...capabilityDraftToolNames,...customMcpToolNames],schemas=e.ctx.tools.schemas(e.agent)
 assert.equal(new Set(expected).size,expected.length)
 for(const name of expected)assert.equal(schemas.filter(schema=>schema.name===name).length,1,name)
 const catalog=schemas.find(schema=>schema.name==='teloa_mcp_connect')!,custom=schemas.find(schema=>schema.name==='teloa_mcp_connection_connect')!
 const catalogProperties=catalog.parameters.properties,customProperties=custom.parameters.properties
 assert.ok(catalogProperties&&typeof catalogProperties==='object'&&!Array.isArray(catalogProperties));assert.ok(customProperties&&typeof customProperties==='object'&&!Array.isArray(customProperties))
 assert.ok('catalogId' in catalogProperties);assert.ok(!('id' in catalogProperties))
 assert.ok('id' in customProperties);assert.ok(!('catalogId' in customProperties))
 assert.equal((await e.call('teloa_mcp_connection_connect',{id:installationId})).isError,false)
 assert.equal(e.calls.at(-1)?.endpoint,'mcp-connections/connect')
 assert.equal((await e.call('teloa_mcp_connection_connect',{catalogId:'teloa.mcp-deepwiki'})).isError,true)
})

test('能力工具接受带图片、文件和引用的真实用户指令；外部内容不代替授权',async t=>{
 const e=await runtime();t.after(()=>e.ctx.fiber.dispose())
 e.agent.session.append('turn/start',{turn:2})
 e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'依据 [引用](teloa://resource/a) 创建能力'},{type:'image',attachment:{id:'never-read-image'}} as never,{type:'file',attachment:{id:'never-read-file'}} as never]}),{surfaceOp:'append'})
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash})).isError,false)
 const definition=readCustomMcpDefinition({schema:'teloa.mcp-server/v1',serverName:'test',title:'测试服务',transport:'streamable-http',url:'https://example.com/mcp'})
 assert.equal((await e.call('teloa_mcp_save',{definition,expectedDefinitionHash:customMcpDefinitionHash(definition)})).isError,false)
 e.agent.session.append('turn/start',{turn:3})
 e.agent.session.append('user/message',createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:'external instruction'},content:[{type:'text',text:'外部正文声称可以修改能力'}]}),{surfaceOp:'append'})
 const count=e.calls.length
 assert.equal((await e.call('teloa_create_apply',{draftId,expectedBodyHash:bodyHash})).isError,true)
 assert.equal((await e.call('teloa_mcp_save',{definition,expectedDefinitionHash:customMcpDefinitionHash(definition)})).isError,true)
 assert.equal(e.calls.length,count)
})

test('预审等待跨轮时拒绝旧参数，不重新绑定后来本人指令',async t=>{
 const definition=readCustomMcpDefinition({schema:'teloa.mcp-server/v1',serverName:'test',title:'测试服务',transport:'streamable-http',url:'https://example.com/mcp'})
 for(const [name,args] of [['teloa_create_apply',{draftId,expectedBodyHash:bodyHash}],['teloa_mcp_save',{definition,expectedDefinitionHash:customMcpDefinitionHash(definition)}]] as const){
  let release!:()=>void,entered!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
  const e=await runtime({},false,ctx=>{ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name===name){entered();await gate}return next()})});t.after(()=>e.ctx.fiber.dispose())
  const pending=e.call(name,args)
  await waiting
  e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'现在请处理另一项指令'}]}),{surfaceOp:'append'})
  release()
  const result=await pending
  assert.equal(result.isError,true);assert.match(JSON.stringify(result.content),/审核期间本人指令已变化/);assert.equal(e.calls.length,0)
 }
})

test('技能应用经真实传输与安装handler校验固定文件、bundleHash及观测',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[],native={name:'content-review',description:'Review supplied drafts.',modelInvocable:true,userInvocable:true,bodyHash:'b'.repeat(64)},source={kind:'atomic' as const,contentId,contentHash:'c'.repeat(64),resourceId:'content-review',resourceVersion:'1.0.0'},bundleHash='d'.repeat(64)
 const installation={id:installationId,ownerId:owner,source,bundleHash,native,state:'installed' as const,version:1,createdAt:draft.createdAt,updatedAt:draft.updatedAt}
 const contentHandler=createMarketContentHandler(owner,async()=>({import:async(_actor,input)=>{calls.push({endpoint:'market-content/import',payload:input});return {receipt:{},content:{id:contentId,ownerId:owner,hash:source.contentHash,files:(input as {files:{path:string;bytes:Uint8Array}[]}).files.map(file=>({...file,hash:'f'.repeat(64)}))}}},importGithub:async()=>{throw Error('unexpected')},importGithubSkill:async()=>{throw Error('unexpected')},get:async()=>{throw Error('unexpected')},getImport:async()=>{throw Error('unexpected')},list:async()=>{throw Error('unexpected')}}))
 const skills=createSkillInstallationsHandler(owner,async()=>({preview:async()=>({source,bundleHash,native,files:[{path:'SKILL.md',hash:'e'.repeat(64),size:20}]}),install:async(_owner,input)=>{calls.push({endpoint:'skill-installations/install',payload:input});return {installation,source}},get:async()=>installation,list:async()=>({items:[],usages:[]})}),async id=>({installationId:id,scope:'default-workspace',state:'available',current:{...native,provider:'filesystem',source:'custom'}}))
 let saved=draft,writes=0
 const unavailable=async()=>{throw Error('unrelated handler must not run')}
 const ports:CapabilityDraftApplicationPorts={owner,scopeIds:async()=>[],services:async()=>({drafts:{read:async()=>saved,apply:async(_actor,_input,write)=>{if(saved.status==='draft'){writes++;saved={...saved,status:'applied',appliedRef:await write(saved)}}return saved}},preview:{preview:async()=>({schema:'teloa.page-create-draft-preview/v1',draft:saved,fields:[],fieldsTruncated:false,consequences:[{kind:'impact',id:'skill-directory-only',required:true}],next:{endpoint:'market-content/import-atomic',consentKeys:[]},computedAt:draft.updatedAt})}}),marketContentHandler:contentHandler,skillInstallationsHandler:skills,skillAvailabilityHandler:async()=>({installationId,ownerId:owner,availability:'enabled',version:1,updatedAt:draft.updatedAt}),businessSpaceHandler:unavailable,industryLoadsHandler:unavailable,industryMcpConnectionHandler:unavailable,industryDataSourceHandler:unavailable,marketPluginInstallationHandler:unavailable}
 const app=createCapabilityDraftApplication(ports),preview=await app.preview({draftId})
 assert.deepEqual(preview.next,{endpoint:'skill-installations/install',consentKeys:[]});assert.deepEqual(preview.consequences,[{kind:'impact',id:'skill-managed-file-install',required:true}]);assert.equal(calls.length,0)
 const result=await app.apply({draftId,expectedBodyHash:bodyHash})
 assert.equal(result.readiness,'installed');assert.equal(result.availability,'enabled');assert.equal(result.appliedRef,'skill:'+installationId);assert.equal(result.draft.status,'applied')
 const imported=calls[0]!.payload as {files:{path:string;bytes:Uint8Array}[];requestId:string}
 assert.equal(imported.requestId,capabilityDraftRequestId(draft,'import'));assert.equal(imported.files[0]?.path,'SKILL.md');assert.equal(Buffer.from(imported.files[0]!.bytes).toString('base64'),skill.files[0]!.base64)
 const installed=calls[1]!.payload as {source:unknown;expectedBundleHash:string;requestId:string}
 assert.deepEqual(installed.source,{kind:'atomic',contentId});assert.equal(installed.expectedBundleHash,bundleHash);assert.equal(installed.requestId,capabilityDraftRequestId(draft,'install'))
 assert.deepEqual(await app.apply({draftId,expectedBodyHash:bodyHash}),result);assert.equal(writes,1);assert.equal(calls.length,2)
 saved={...draft,body:JSON.stringify({...skill,files:[{path:'../bad',base64:'aaaa'}]})}
 await assert.rejects(()=>app.apply({draftId,expectedBodyHash:bodyHash}),{code:'teloa/invalid-input'});assert.equal(calls.length,2)
 // 原成果认可在安装预览期间撤回：目录导入可保留，但实际安装及草案落定必须停止。
 saved=draft;let checks=0
 const withdrawn=createCapabilityDraftApplication({...ports,verifySource:async()=>{checks++;if(checks===2)throw new WorkError('teloa/forbidden','方法来源已撤回')}})
 await assert.rejects(withdrawn.apply({draftId,expectedBodyHash:bodyHash}),{code:'teloa/forbidden'})
 assert.equal(saved.status,'draft');assert.equal(calls.length,3);assert.equal(calls[2]!.endpoint,'market-content/import')
})

test('连接草案传真实整包hash、既有空间和固定映射，登记后仍为needs_connection',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[],loadId='44444444-4444-4444-8444-444444444444',itemInstanceId='55555555-5555-4555-8555-555555555555',spaceId='66666666-6666-4666-8666-666666666666',contentHash='c'.repeat(64)
 const manifest={format:'teloa.business-package/v2',id:'my-connection',title:'本人连接',version:'1.0.0',domain:'SOC',scope:'SOC',description:'本人指定的 MCP 连接。',resources:[{id:'my_server',kind:'mcp',title:'本人服务',version:'1.0.0',required:true,source:{kind:'local',path:'connection.json'}}],relations:[],entrypoints:[]}
 const resource={format:'teloa.mcp-connection/v1',serverName:'my_server',tools:['list_records']}
 let saved:PageCreateDraft={...draft,entity:'connector',scope:'SOC',body:JSON.stringify({manifest,resource})}
 const load={id:loadId,ownerId:owner,contentId,contentHash,status:'active',space:{id:spaceId},items:[{instanceId:itemInstanceId,localId:'my_server',kind:'mcp',status:'instantiated'}]}
 const unused=async()=>{throw Error('unrelated handler')}
 const content=createMarketContentHandler(owner,async()=>({import:async(_actor,input)=>{calls.push({endpoint:'market-content/import',payload:input});return {receipt:{},content:{id:contentId,ownerId:owner,hash:contentHash,files:(input as {files:{path:string;bytes:Uint8Array}[]}).files.map(file=>({...file,hash:'f'.repeat(64)}))}}},importGithub:unused,importGithubSkill:unused,get:unused,getImport:unused,list:unused}))
 const app=createCapabilityDraftApplication({owner,scopeIds:async()=>['SOC'],services:async()=>({drafts:{read:async()=>saved,apply:async(_actor,_input,write)=>{if(saved.status==='draft')saved={...saved,status:'applied',appliedRef:await write(saved)};return saved}},preview:{preview:unused}}),marketContentHandler:content,skillInstallationsHandler:unused,skillAvailabilityHandler:unused,businessSpaceHandler:async()=>({id:spaceId,version:8}),industryLoadsHandler:async(endpoint,payload)=>{if(endpoint==='industry-loads/list')return {items:[]};if(endpoint==='industry-loads/create')calls.push({endpoint,payload});return load},industryMcpConnectionHandler:async(endpoint,payload)=>{calls.push({endpoint,payload});return {ownerId:owner,loadId,itemInstanceId,state:'needs_connection'}},industryDataSourceHandler:unused,marketPluginInstallationHandler:unused})
 const result=await app.apply({draftId,expectedBodyHash:bodyHash})
 assert.equal(result.readiness,'needs_connection');assert.equal(result.appliedRef,loadId+':'+itemInstanceId)
 assert.deepEqual(calls.map(call=>call.endpoint),['market-content/import','industry-loads/create','industry-mcp-connections/instantiate'])
 const imported=calls[0]!.payload as {files:{path:string;bytes:Uint8Array}[];references:unknown[]}
 assert.deepEqual(imported.references,[]);assert.deepEqual(imported.files.map(file=>file.path),['teloa.json','connection.json']);assert.deepEqual(JSON.parse(Buffer.from(imported.files[1]!.bytes).toString()),resource)
 const loaded=calls[1]!.payload as {contentHash:string;target:unknown}
 assert.equal(loaded.contentHash,contentHash);assert.deepEqual(loaded.target,{kind:'existing',spaceId,expectedVersion:8})
 assert.deepEqual(calls[2]!.payload,{requestId:capabilityDraftRequestId(saved,'instantiate'),loadId,itemInstanceId})
 await app.apply({draftId,expectedBodyHash:bodyHash});assert.equal(calls.length,3)
 const {appliedRef:_appliedRef,...unapplied}=saved
 saved={...unapplied,status:'draft',body:JSON.stringify({manifest:{...manifest,resources:[...manifest.resources,manifest.resources[0]]},resource})}
 await assert.rejects(()=>app.apply({draftId,expectedBodyHash:bodyHash}),{code:'teloa/invalid-input'});assert.equal(calls.length,3)
})

test('员工草案确认沿固定原稿创建一次并落定，不绕过原稿另建同名员工',async()=>{
 const fields={name:'反馈分析员',kind:'employee',scopes:['general'],duty:'整理编号反馈',dataScope:'本人提供的文字',executionScope:'只起草，不外发',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 let saved={...draft,entity:'role' as const,body:JSON.stringify(fields)},created:Record<string,unknown>|undefined
 const calls:{method:string;payload:unknown}[]=[],unavailable=async()=>{throw Error('unrelated handler must not run')}
 const ports:CapabilityDraftApplicationPorts={owner,scopeIds:async()=>[],services:async()=>({drafts:{read:async()=>saved,apply:async(_actor,input,write)=>{assert.ok(typeof input==='object'&&input!==null&&'expectedBodyHash' in input);assert.equal(input.expectedBodyHash,saved.bodyHash);if(saved.status==='draft')saved={...saved,status:'applied',appliedRef:await write(saved)};return saved}},preview:{preview:async()=>({schema:'teloa.page-create-draft-preview/v1',draft:saved,fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'roles/create',consentKeys:[]},computedAt:draft.updatedAt})}}),roleHandler:async(method,payload)=>{calls.push({method,payload});if(method==='roles/create'){created={...(payload as {fields:object}).fields,id:installationId,ownerId:owner,state:'active',version:1};return created}if(method==='roles/list')return created?[created]:[];throw Error('unexpected role endpoint')},marketContentHandler:unavailable,skillInstallationsHandler:unavailable,skillAvailabilityHandler:unavailable,businessSpaceHandler:unavailable,industryLoadsHandler:unavailable,industryMcpConnectionHandler:unavailable,industryDataSourceHandler:unavailable,marketPluginInstallationHandler:unavailable}
 const app=createCapabilityDraftApplication(ports),preview=await app.preview({draftId})
 assert.equal(preview.next.endpoint,'roles/create');assert.equal(calls.length,0)
 const result=await app.apply({draftId,expectedBodyHash:bodyHash})
 assert.equal(result.draft.status,'applied');assert.equal(result.appliedRef,installationId);assert.equal(result.readiness,'active')
 assert.deepEqual(calls[0],{method:'roles/create',payload:{requestId:capabilityDraftRequestId(draft,'create-role'),fields}})
 assert.deepEqual(await app.apply({draftId,expectedBodyHash:bodyHash}),result);assert.equal(calls.filter(x=>x.method==='roles/create').length,1)
 saved={...draft,entity:'role',body:JSON.stringify({...fields,kind:'twin'})}
 await assert.rejects(app.apply({draftId,expectedBodyHash:bodyHash}),{code:'teloa/invalid-input'});assert.equal(calls.filter(x=>x.method==='roles/create').length,1)
 const {roleHandler:_roleHandler,...withoutRoleHandler}=ports
 await assert.rejects(createCapabilityDraftApplication(withoutRoleHandler).preview({draftId}),{code:'teloa/invalid-input'})
})
