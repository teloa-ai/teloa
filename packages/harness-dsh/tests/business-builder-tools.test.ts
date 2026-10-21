import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {BusinessConfigurationDraftService,initializeBusinessDefinitions,initializeBusinessScopes,initializeBusinessSpaces,initializeBusinessConfigurations} from '@teloa/backend'
import type {BusinessBuilderToolsPorts} from '../src/business-builder-tools.ts'
import * as module from '../src/business-builder-tools.ts'
let pool:ConstructorParameters<typeof BusinessConfigurationDraftService>[0],container:StartedPostgreSqlContainer
before(async()=>{process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializeBusinessDefinitions(pool);await initializeBusinessConfigurations(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
async function fixture(overrides:Partial<BusinessBuilderToolsPorts>={},origin?:'subagent',pendingFirst=false){
 assert.equal(typeof module.registerBusinessBuilderTools,'function')
 const actor={ownerId:'builder:'+randomUUID(),scopeIds:[] as string[]},service=new BusinessConfigurationDraftService(pool,identity),draft=await service.begin(actor,{requestId:randomUUID(),title:'客户跟进'})
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('builder-'+randomUUID()),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:{id:'attachment'}} as never]}),{surfaceOp:'append'})};if(pendingFirst)agent.session.append('turn/start',{turn:1});else turn()
 const binding={requestId:randomUUID(),kind:'builder' as const,title:'客户跟进',draftId:draft.id,sessionId:agent.session.id,createdAt:identity.now(),updatedAt:identity.now()}
 const requests:unknown[]=[],ports:BusinessBuilderToolsPorts={owner:actor.ownerId,conversation:async sessionId=>({ownerId:actor.ownerId,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>binding,draft:async draftId=>service.get(actor,{draftId}),revise:async input=>{requests.push(input);return service.revise(actor,input)},reviseReceipt:input=>service.reviseReceipt(actor,input),upgradeFormat:input=>service.upgradeFormat(actor,input),...overrides}
 module.registerBusinessBuilderTools(ctx,ports)
 let approval:(input:unknown)=>Promise<string>=async()=> 'allowed-once';const approvals:unknown[]=[]
 ctx.provide('approval',{request:async(input:unknown)=>{approvals.push((input as {reason?:string}).reason);return approval(input)}})
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,actor,service,draft,binding,ports,requests,approvals,turn,call,approve:(fn:typeof approval)=>{approval=fn}}
}
const read='teloa_business_builder_read',revise='teloa_business_builder_revise'
test('固定原生 schema 提供有界 patchJson；read 给出当前身份下可保存的完整合法例，v1/v2不猜字段',async t=>{
 for(const rich of [false,true]){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  if(rich)await f.service.upgradeFormat(f.actor,{draftId:f.draft.id,expectedRevision:1,requestId:randomUUID()})
  const schema=f.ctx.tools.schemas(f.agent).find(item=>item.name===revise)
  assert.ok(schema)
  const properties=Reflect.get(schema.parameters,'properties');assert.ok(properties&&typeof properties==='object')
  const patchJsonSchema=Reflect.get(properties,'patchJson');assert.ok(patchJsonSchema&&typeof patchJsonSchema==='object')
  assert.equal(Reflect.get(patchJsonSchema,'type'),'string')
  const result=await f.call(read);assert.equal(result.isError,false)
  const current=JSON.parse(result.content.map(item=>item.type==='text'?item.text:'').join(''))
  assert.equal(current.capabilities.patchProtocol.exampleOnly,true)
  const args={draftId:f.draft.id,expectedRevision:current.revision,patchJson:current.capabilities.patchProtocol.exampleJson}
  assert.equal(typeof args.patchJson,'string')
  const patch=JSON.parse(args.patchJson)
  assert.equal(patch.upsertDefinitions[0].definition.domain,f.draft.scope)
  assert.equal(patch.upsertDefinitions[0].definition.sourceId,f.draft.candidate.sources[0]!.sourceId)
  assert.equal(patch.upsertDefinitions[0].definition.format,rich?'teloa.business-object-type/v2':'teloa.business-object-type/v1')
  const saved=await f.call(revise,args);assert.equal(saved.isError,false,JSON.stringify(saved))
  const canonical=await f.service.get(f.actor,{draftId:f.draft.id})
  assert.equal(canonical.revision,current.revision+1);assert.equal(canonical.status,'draft');assert.equal(canonical.baseVersion,0)
  assert.equal(canonical.candidate.pages.length,2);assert.equal(canonical.candidate.definitions.length,4)
  assert.equal(f.approvals.length,1)
  assert.equal((await f.call(revise,args)).isError,false);assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,canonical.revision,'重放沿原请求回执，不增加版本')
 }
})
test('合法23/24页草案目录始终可读，容量受限时只提供合法现有页修改例并保留全部原页和顺序',async t=>{
 for(const count of [23,24]){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:f.draft.scope,title:'客户',unit:'位',lead:'原有客户资料',sourceId:f.draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}
  const pages=Array.from({length:count},(_,index)=>({id:'page-'+index,title:'原页面'+index,kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}))
  const before=await f.service.revise(f.actor,{draftId:f.draft.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:pages,homePageId:pages[0]!.id,pageOrder:pages.map(page=>page.id)}})
  const result=await f.call(read);assert.equal(result.isError,false,JSON.stringify(result))
  const directory=JSON.parse(result.content.map(item=>item.type==='text'?item.text:'').join(''))
  assert.equal(directory.draftId,f.draft.id);assert.equal(directory.revision,2);assert.equal(directory.pages.length,count)
  assert.equal(directory.capabilities.patchProtocol.exampleMode,'modify-existing')
  assert.equal(directory.capabilities.patchProtocol.capacity.pagesRemaining,24-count)
  const patch=JSON.parse(directory.capabilities.patchProtocol.exampleJson)
  assert.deepEqual(patch.upsertPages,[before.candidate.pages[0]]);assert.equal(Object.hasOwn(patch,'pageOrder'),false)
  assert.equal(f.approvals.length,0);assert.deepEqual((await f.service.get(f.actor,{draftId:f.draft.id})).candidate,before.candidate,'读取示例不能修改草案')
  patch.upsertPages[0].title='调整原页面名称'
  assert.equal((await f.call(revise,{draftId:f.draft.id,expectedRevision:2,patchJson:JSON.stringify(patch)})).isError,false)
  const after=await f.service.get(f.actor,{draftId:f.draft.id})
  assert.equal(after.candidate.pages.length,count);assert.deepEqual(after.candidate.pages.map(page=>page.id),before.candidate.pages.map(page=>page.id));assert.deepEqual(after.candidate.pages.slice(1),before.candidate.pages.slice(1));assert.deepEqual(after.candidate.definitions,before.candidate.definitions)
 }
})
test('定义容量边界的目录准确可读：剩余4个时完整例可保存，剩余不足时合法标题例保留全部定义',async t=>{
 for(const count of [252,253,256]){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const definitions=Array.from({length:count},(_,index)=>({kind:'widget',definition:{format:'teloa.business-widget/v1',id:'original-'+index,version:'1.0.0',domain:f.draft.scope,title:'原组件'+index,kind:'metric',query:'select 1 as n',metric:{valueColumn:'n'}}}))
  const seeded=await f.service.revise(f.actor,{draftId:f.draft.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:definitions}})
  const result=await f.call(read);assert.equal(result.isError,false,JSON.stringify(result))
  const directory=JSON.parse(result.content.map(item=>item.type==='text'?item.text:'').join('')),protocol=directory.capabilities.patchProtocol
  assert.equal(protocol.capacity.definitionsRemaining,256-count);assert.equal(directory.definitions.length,32)
  assert.equal(protocol.exampleMode,count===252?'add-complete':'modify-existing')
  const patch=JSON.parse(protocol.exampleJson)
  if(count!==252){assert.deepEqual(patch,{title:seeded.candidate.title});patch.title='调整原业务名称'}
  assert.equal((await f.call(revise,{draftId:f.draft.id,expectedRevision:2,patchJson:JSON.stringify(patch)})).isError,false)
  const saved=await f.service.get(f.actor,{draftId:f.draft.id})
  assert.deepEqual(saved.candidate.definitions.slice(0,count),seeded.candidate.definitions)
  assert.equal(saved.candidate.definitions.length,count===252?256:count)
 }
})
test('patchJson 与旧 patch 恰一：包装数组、字符串布尔、错误字段与非法/超限JSON均在审批前拒绝，零写入',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const base={draftId:f.draft.id,expectedRevision:1}
 for(const extra of [{},{patchJson:'{'},{patchJson:'null'},{patchJson:'[]'},{patchJson:5},{patchJson:'{"title":"客户"}',patch:{title:'客户'}},{patchJson:JSON.stringify({upsertDefinitions:{item:[]}})},{patchJson:JSON.stringify({upsertPages:{item:[]}})},{patchJson:JSON.stringify({scope:'other'})},{patchJson:'{"title":"'+ '汉'.repeat(700000)+'"}'}]){
  assert.equal((await f.call(revise,{...base,...extra})).isError,true)
 }
 const current=JSON.parse((await f.call(read)).content.map(item=>item.type==='text'?item.text:'').join(''))
 for(const change of ['boolean','label','version','lead'] as const){
  const patch=JSON.parse(current.capabilities.patchProtocol.exampleJson),object=patch.upsertDefinitions[0].definition
  if(change==='boolean')object.fields[0].required='true'
  if(change==='label'){object.fields[0].title=object.fields[0].label;delete object.fields[0].label}
  if(change==='version')object.version='1'
  if(change==='lead'){object['lead /']={sourceId:object.sourceId,fields:object.fields};delete object.lead;delete object.sourceId;delete object.fields}
  assert.equal((await f.call(revise,{...base,patchJson:JSON.stringify(patch)})).isError,true,change)
 }
 const wrapped=await f.call(revise,{...base,patch:{upsertDefinitions:{item:[{kind:'object-type'}]}}})
 assert.equal(wrapped.isError,true);assert.match(JSON.stringify(wrapped),/必须是 JSON 数组/);assert.doesNotMatch(JSON.stringify(wrapped),/超过上限/,'类型错误不能诱导模型误认为不能新增定义')
 const oversize=await f.call(revise,{...base,patchJson:'{"title":"'+ '汉'.repeat(700000)+'"}'})
 assert.equal(oversize.isError,true);assert.match(JSON.stringify(oversize),/UTF-8 大小上限/)
 assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0);assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,1)
 assert.equal((await f.call(revise,{...base,patchJson:'{"title":"合法中文草案"}'})).isError,false,'合法UTF8 JSON不能被当作未知字段拒绝')
})
test('patchJson 沿同原指令回执核对失回包，审批期间换指令仍零落盘',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());let lost=true
 f.ports.revise=async input=>{const saved=await f.service.revise(f.actor,input);if(lost){lost=false;throw Error('lost receipt')}return saved}
 const args={draftId:f.draft.id,expectedRevision:1,patchJson:'{"title":"中文草案"}'}
 assert.equal((await f.call(revise,args)).isError,true)
 assert.equal((await f.call(revise,{...args,patchJson:' { "title" : "中文草案" } '})).isError,false,'相同JSON语义只恢复原回执')
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,2)
 assert.equal((await f.call(revise,{...args,patchJson:'{"title":"不同草案"}'})).isError,true)
 f.approve(async()=>{f.turn();return 'allowed-once'})
 assert.equal((await f.call(revise,{...args,expectedRevision:2,patchJson:'{"title":"不能保存"}'})).isError,true)
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,2)
})
test('真实首轮pending消息尚未落盘时仍注入绑定草案，消息提交前不能调用保存工具',async t=>{
 const f=await fixture({},undefined,true);t.after(()=>f.ctx.fiber.dispose())
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'搭建客户回访，客户名、回访日期、负责人、进展，首页统计数量。'}]}),input={agent:f.agent,messages:[message],turn:1,step:1,signal:new AbortController().signal}
 const before=f.agent.session.snapshotEvents().length,decision=await f.ctx.waterfall('agent/pre-step',input,async()=>({kind:'enter' as const,messages:[message]})) as {messages:import('@deepseek-ai/dsh-llm').UserMessage[]}
 assert.equal(decision.messages.length,2,'DSH在pre-step之后才持久追加用户消息，指引不能因指令尚未落盘而消失')
 assert.equal(decision.messages[1]?.source.kind,'plugin:teloa.business-builder')
 assert.ok(JSON.stringify(decision.messages[1]).includes(f.draft.id));assert.equal(f.agent.session.snapshotEvents().length,before,'上下文读取不伪造本人指令或修改会话')
 assert.equal((await f.call(revise,{draftId:f.draft.id,expectedRevision:1,patch:{title:'客户回访'}})).isError,true)
 assert.equal(f.requests.length,0)
 f.agent.session.append('user/message',message,{surfaceOp:'append'})
 assert.equal((await f.call(read)).isError,false)
 assert.equal((await f.call(revise,{draftId:f.draft.id,expectedRevision:1,patch:{title:'客户回访'}})).isError,false)
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).candidate.title,'客户回访')
})
test('真实原生 ask 拒绝零修改、批准整组一次，跨服务重建重放同身份并拒绝异 patch',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const args={draftId:f.draft.id,expectedRevision:1,patch:{title:'客户档案'}}
 f.approve(async()=> 'rejected');assert.equal((await f.call(revise,args)).isError,true);assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,1);assert.equal(f.requests.length,0)
 f.approve(async()=> 'allowed-once');assert.equal((await f.call(revise,args)).isError,false);assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,2)
 f.ports.revise=async input=>new BusinessConfigurationDraftService(pool,identity).revise(f.actor,input)
 assert.equal((await f.call(revise,args)).isError,false)
 assert.equal((await f.call(revise,{...args,patch:{title:'异内容'}})).isError,true)
 assert.equal((await f.call(revise,{...args,expectedRevision:2,patch:{title:'下一版'}})).isError,false)
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,3)
 assert.match(JSON.stringify(f.approvals),/客户跟进/)
})
test('审批中换轮、替换消息、换绑草案或撤权，执行再次核对拒绝写入',async t=>{
 for(const change of ['turn','replace','binding','role','task','owner']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  f.approve(async()=>{if(change==='turn')f.turn();if(change==='replace')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never);if(change==='binding')f.binding.draftId=randomUUID();if(change==='role')f.ports.isRoleConversation=async()=>true;if(change==='task')f.ports.readTaskPolicy=async()=>({allowedTools:[]});if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'other',sessionId,status:'ready'});return 'allowed-once'})
  assert.equal((await f.call(revise,{draftId:f.draft.id,expectedRevision:1,patch:{title:'不应保存'}})).isError,true,change);assert.equal(f.requests.length,0,change)
 }
})
test('普通、未完整绑定、他人、role、task、TaskRun 和 subagent 均不能使用草案工具',async t=>{
 const cases:Partial<BusinessBuilderToolsPorts>[]=[{binding:async()=>undefined},{binding:async()=>({kind:'builder',requestId:randomUUID(),title:'未绑',createdAt:identity.now(),updatedAt:identity.now()})},{isRoleConversation:async()=>true},{isTaskConversation:async()=>true},{readTaskPolicy:async()=>({allowedTools:[]})},{conversation:async sessionId=>({sessionId,ownerId:'other',status:'ready'})}]
 for(const [index,override] of cases.entries()){
  const f=await fixture(override);t.after(()=>f.ctx.fiber.dispose());const result=await f.call(read)
  assert.equal(result.isError,true);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
  if(index===0){assert.match(JSON.stringify(result),/业务.*新建业务/);assert.doesNotMatch(JSON.stringify(result),/恢复原搭建会话/)}
  if(index===1)assert.match(JSON.stringify(result),/恢复原搭建会话/)
 }
 const f=await fixture({},'subagent');t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(read)).isError,true)
})
test('目录每页32叶子且不含正文，互斥读取一条定义或页面，拒绝伪造owner与非法cursor',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const definitions=Array.from({length:40},(_,n)=>({kind:'widget',definition:{format:'teloa.business-widget/v1',id:'n'+n,version:'1.0.0',domain:f.draft.scope,title:'数量'+n,kind:'metric',query:'select 1 as n',metric:{valueColumn:'n'}}}))
 await f.service.revise(f.actor,{draftId:f.draft.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:definitions}})
 const first=await f.call(read);assert.equal(first.isError,false);const body=JSON.parse(first.content.map(b=>b.type==='text'?b.text:'').join(''));assert.equal(body.definitions.length,32);assert.equal(body.nextCursor,32);assert.equal(body.scope,f.draft.scope);assert.deepEqual(body.sources,f.draft.candidate.sources);assert.deepEqual(body.capabilities.fieldTypes,['text','number','enum','datetime','reference','duration','boolean']);const text=JSON.stringify(first);assert.doesNotMatch(text,/select 1 as n/)
 assert.equal((await f.call(read,{cursor:32})).isError,false)
 assert.match(JSON.stringify(await f.call(read,{definition:{kind:'widget',localId:'n39'}})),/select 1 as n/)
 for(const args of [{cursor:-1},{cursor:1.5},{cursor:Number.MAX_SAFE_INTEGER+1},{cursor:0,pageId:'x'},{definition:{kind:'widget',localId:'n1'},pageId:'x'},{owner:'other'},{definition:{kind:'widget',localId:'n1',owner:'other'}}])assert.equal((await f.call(read,args)).isError,true)
 const foreign=await f.service.begin({...f.actor,ownerId:'other:'+randomUUID()},{requestId:randomUUID(),title:'他人'});assert.equal((await f.call(revise,{draftId:foreign.id,expectedRevision:1,patch:{title:'覆盖'}})).isError,true)
})
test('调用成功失回包后只读可核对新版，相同原请求不增加 revision，保留上游 deny/ask',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());let lost=true
 f.ports.revise=async input=>{const result=await f.service.revise(f.actor,input);if(lost){lost=false;throw Error('lost response')}return result}
 const args={draftId:f.draft.id,expectedRevision:1,patch:{title:'已保存'}};assert.equal((await f.call(revise,args)).isError,true)
 assert.match(JSON.stringify(await f.call(read)),/已保存/);assert.equal((await f.call(revise,args)).isError,false);assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,2)
 const off=f.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'原生规则拒绝'}));assert.equal((await f.call(read)).isError,true);off()
 f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'既有确认'}));assert.equal((await f.call(revise,{...args,expectedRevision:2})).isError,false);assert.match(JSON.stringify(f.approvals.at(-1)),/既有确认/)
})

test('单页返回本版配置；超128KiB叶子和256KiB总回包明确失败，不截断JSON',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:f.draft.scope,title:'客户',unit:'位',lead:'跟进',sourceId:f.draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}
 const page={id:'customers',title:'客户名单',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}
 const saved=await f.service.revise(f.actor,{draftId:f.draft.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:page.id}})
 const result=await f.call(read,{pageId:page.id});assert.equal(result.isError,false);const body=JSON.parse(result.content.map(b=>b.type==='text'?b.text:'').join(''));assert.deepEqual(body.page,page);assert.equal(body.revision,2)
 const candidate=saved.candidate;if(candidate.format!=='teloa.business-configuration/v1')throw Error('此用例应保持 v1 草案')
 f.ports.draft=async()=>({...saved,candidate:{...candidate,definitions:[{kind:'object-type',definition:{...candidate.definitions[0]!.definition,title:'超'.repeat(45000)}}]}})
 const leaf=await f.call(read,{definition:{kind:'object-type',localId:'customer'}});assert.equal(leaf.isError,true);assert.match(JSON.stringify(leaf),/大小上限/)
 f.ports.draft=async()=>({...saved,candidate:{...candidate,title:'超'.repeat(90000)}})
 assert.equal((await f.call(read)).isError,true)
})
test('仅完整builder注入精简指引、不注入全草案，不相关工具保留next',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'设计客户业务'}]})],input={agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal}
 let calls=0
 const next=async()=>{calls++;return {kind:'enter' as const,messages}}
 const decision=await f.ctx.waterfall('agent/pre-step',input,next) as {messages:import('@deepseek-ai/dsh-llm').UserMessage[]}
 assert.equal(calls,1);assert.equal(decision.messages.length,2);const notice=JSON.stringify(decision.messages[1]);assert.match(notice,/teloa_business_builder_revise/);assert.ok(notice.length<2048)
 f.ports.binding=async()=>undefined;const ordinary=await f.ctx.waterfall('agent/pre-step',input,next) as {messages:import('@deepseek-ai/dsh-llm').UserMessage[]};assert.deepEqual(ordinary.messages,messages)
 const {defineTool}=await import('@deepseek-ai/dsh-tools');f.ctx.tools.register(defineTool({name:'unrelated_tool',description:'test',parameters:{},output:{schema:{type:'string'},render:()=>[{type:'text',text:'ok'}]},execute:async()=> 'ok'}))
 assert.equal((await f.call('unrelated_tool')).isError,false)
})

test('真实文件会话与PG绑定接原生Tools：ready未bind仍禁用，完成原绑定后一次审批整组落库',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {ConversationService,FileConversationRepository,BusinessConversationBindingService,initializeBusinessConversationBindings}=await import('@teloa/backend')
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const root=await mkdtemp(join(tmpdir(),'teloa-task3-tools-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await initializeBusinessConversationBindings(pool)
 const conversations=new ConversationService(new FileConversationRepository(join(root,'conversations.json')),{create:async()=>f.agent.session.id,inspect:async id=>{assert.equal(id,f.agent.session.id)}},identity)
 const bindings=new BusinessConversationBindingService(pool,identity,{drafts:f.service,conversations,contexts:{context:async()=>{throw Error('builder 不得读日常 context')}}})
 const request={requestId:randomUUID(),kind:'builder',title:'真实业务'},reserved=await bindings.reserve(f.actor,request)
 await conversations.create(f.actor.ownerId,{requestId:request.requestId,title:request.title})
 f.ports.conversation=sessionId=>conversations.bySession(f.actor.ownerId,sessionId);f.ports.binding=sessionId=>bindings.bySession(f.actor,{sessionId})
 assert.equal(await bindings.isBuilder(f.actor.ownerId,f.agent.session.id),true);assert.equal((await f.call(read)).isError,true)
 await bindings.bind(f.actor,{requestId:request.requestId,sessionId:f.agent.session.id})
 assert.equal((await f.call(read)).isError,false)
 const result=await f.call(revise,{draftId:reserved.draftId,expectedRevision:1,patch:{title:'原生审批已保存'}});assert.equal(result.isError,false);assert.equal(f.approvals.length,1)
 assert.equal((await f.service.get(f.actor,{draftId:reserved.draftId})).revision,2)
})

test('原生上游 cancel 原样终止整组修订，不弹审批、不调用服务且草案版本不变',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 f.ctx.on('tools/pre-execute',async()=>({kind:'cancel'}))
 const result=await f.call(revise,{draftId:f.draft.id,expectedRevision:1,patch:{title:'取消的修改'}})
 assert.equal(result.isError,true)
 assert.equal(result.error?.info?.code,'ABORTED_BEFORE_DISPATCH')
 assert.equal(f.approvals.length,0)
 assert.equal(f.requests.length,0)
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).revision,1)
})

test('完整方案工具沿原生ask与原会话保存静态候选；拒绝不写，重试固定请求身份',async t=>{
 const writes:any[]=[],directory={plan:null,employees:[],rules:'静态候选'}
 const f=await fixture({setupPlan:{read:async()=>directory,revise:async input=>{writes.push(input);return {draftId:input.draftId,revision:1}}}});t.after(()=>f.ctx.fiber.dispose())
 const current=JSON.parse((await f.call(read)).content.map(item=>item.type==='text'?item.text:'').join(''));assert.deepEqual(current.setupPlan,directory)
 const args={draftId:f.draft.id,expectedRevision:0,patchJson:JSON.stringify({package:{manifestPath:'teloa.json',files:[{path:'teloa.json',text:'静态包正文'}]},roleEdits:[]})},name='teloa_business_builder_plan_revise'
 f.approve(async()=> 'rejected');assert.equal((await f.call(name,args)).isError,true);assert.equal(writes.length,0)
 f.approve(async()=> 'allowed-once');assert.equal((await f.call(name,args)).isError,false);assert.equal((await f.call(name,args)).isError,false)
 assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);assert.equal(writes[0].draftId,f.draft.id)
 assert.equal((await f.call(name,{...args,draftId:randomUUID()})).isError,true);assert.equal(writes.length,2)
 assert.equal((await f.service.get(f.actor,{draftId:f.draft.id})).status,'draft')
})
