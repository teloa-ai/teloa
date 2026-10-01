import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,readBusinessRecordGet,readBusinessObjectTypeDefinitionV2,type BusinessObjectSnapshot,type BusinessRecordBatch,type BusinessRecordBatchResult,type BusinessObjectTypeDefinition} from '@teloa/contract'
import type {BusinessDefinitionBundle,BusinessRecordService} from '@teloa/backend'
import type {BusinessRecordToolsPorts} from '../src/business-record-tools.ts'
type BusinessRecordBatchSource=NonNullable<Parameters<BusinessRecordService['batch']>[2]>
type BusinessRecordRecentBatch=Awaited<ReturnType<BusinessRecordService['recentBatches']>>['items'][number]
const module=await import('../src/business-record-tools.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-record-tools.ts');throw error})
const read='teloa_business_records_read',write='teloa_business_records_write',stamp='2026-09-29T00:00:00.000Z',hash='a'.repeat(64)
const operation={operation:'create',type:'customer',title:'客户甲',summary:'首次登记',fields:[{name:'name',value:'甲'},{name:'stage',value:'待联系'}]} as const
const body=(result:{content:readonly {type:string;text?:string}[]})=>JSON.parse(result.content.map(b=>b.type==='text'?b.text:'').join(''))
test('原生日常记录工具读取真实 v2 字段并保存精确规范串，非法币种和多选顺序在审批前拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const definition=readBusinessObjectTypeDefinitionV2({...f.definition,format:'teloa.business-object-type/v2',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'原金额',type:'money',required:false,currencies:['CNY']},{format:'teloa.business-rich-field/v2',name:'tags',label:'方向',from:'原方向',type:'multi-enum',required:true,values:['云安全','合规']}]})
 f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition}]}]
 const readResult=await f.call(read,{mode:'type',type:'customer'});assert.equal(readResult.isError,false);assert.deepEqual(body(readResult).definition,definition)
 const amount='{"currency":"CNY","decimal":"9007199254740993.01"}',fields=[{name:'amount',value:amount},{name:'tags',value:'["云安全","合规"]'}]
 for(const changed of [[{name:'amount',value:'{"currency":"USD","decimal":"1"}'},fields[1]],[fields[0],{name:'tags',value:'["合规","云安全"]'}]])assert.equal((await f.call(write,{operations:[{...operation,fields:changed}]})).isError,true)
 assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
 assert.equal((await f.call(write,{operations:[{...operation,fields}]})).isError,false);assert.equal(f.requests.length,1);assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,fields)
})
async function fixture(overrides:Partial<BusinessRecordToolsPorts>={},origin?:'subagent'){
 assert.equal(typeof module.registerBusinessRecordTools,'function')
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('records-'+randomUUID()),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:{id:'unread-image'}} as never,{type:'file',attachment:{id:'unread-file'}} as never,{type:'text',text:'按附件更新记录'}]}),{surfaceOp:'append'})};turn()
 const definition:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',id:'customer',domain:'sales',version:'1.0.0',title:'客户',sourceId:'local',unit:'位',lead:'客户登记',fields:[{name:'name',label:'姓名',from:'姓名',type:'text',required:true},{name:'stage',label:'阶段',from:'阶段',type:'enum',required:false,values:['待联系','已联系']},{name:'note',label:'备注',from:'备注',type:'text',required:false}]}
 const bundle:BusinessDefinitionBundle={origin:{kind:'local-configuration',configurationVersion:1,configurationHash:hash},scope:'sales',domain:'sales',objectTypes:[{definition,source:{loadId:'local',scope:'sales',localId:'customer',version:'1.0.0',contentHash:hash,fileHash:hash,definitionHash:hash,origin:'local'}}],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map([['local',{connected:true}]])}
 const existing:BusinessObjectSnapshot={scope:'sales',type:'customer',id:'one',version:1,snapshotHash:hash,title:'旧客户',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'完整记录',fields:[{label:'姓名',value:'旧姓名'},{label:'阶段',value:'待联系'},{label:'备注',value:'必须保留'}]}
 const saved=new Map<string,{input:BusinessRecordBatch;source:BusinessRecordBatchSource|undefined;result:BusinessRecordBatchResult}>(),requests:Array<{actor:{ownerId:string;scopeIds:string[]};input:BusinessRecordBatch;source:BusinessRecordBatchSource|undefined}>=[],reads:string[]=[]
 const ports:BusinessRecordToolsPorts={owner:'self',conversation:async sessionId=>({ownerId:'self',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:true}),scopes:async()=>[{scope:'sales',title:'销售'}],definitions:async()=>[bundle],records:{list:async(actor,input)=>{reads.push('list');assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']});return {schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:[existing]}},get:async(actor,input)=>{reads.push('get');assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']});return structuredClone(existing)},batchReceipt:async(actor,input)=>{reads.push('receipt');return saved.get((input as {requestId:string}).requestId)?.result},recentBatches:async(actor,input)=>{reads.push('recent');assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']});assert.equal(input.sessionId,agent.session.id);return {items:[...saved.entries()].map(([requestId,row]):BusinessRecordRecentBatch=>({requestId,scope:'sales',source:row.source!,createdAt:stamp,operations:row.result.items.map((item,i)=>({requestId:randomUUID(),operation:row.input.operations[i]!.operation,reference:{scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}}))}))}},batch:async(actor,input,source)=>{const value=input as BusinessRecordBatch;requests.push({actor,input:value,source});const prior=saved.get(value.requestId);if(prior){if(JSON.stringify(prior.input)!==JSON.stringify(value)||JSON.stringify(prior.source)!==JSON.stringify(source))throw new WorkError('teloa/conflict','同请求内容不同');return prior.result}const result={requestId:value.requestId,scope:value.scope,items:value.operations.map((op,i)=>({...existing,type:op.type,id:op.operation==='create'?'new-'+i:op.id,version:op.operation==='create'?1:op.expectedVersion+1,title:'title'in op&&op.title!==undefined?op.title:existing.title,fields:[] as BusinessObjectSnapshot['fields'],...(op.operation==='archive'?{deletedAt:stamp}:{})}))};saved.set(value.requestId,{input:value,source,result});return result}},...overrides}
 module.registerBusinessRecordTools(ctx,ports)
 let approve:()=>Promise<string>=async()=> 'allowed-once';const approvals:string[]=[]
 ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const call=(name:string,args:Record<string,unknown>={},signal:AbortSignal=AbortSignal.timeout(3000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal})
 return {ctx,agent,ports,bundle,definition,existing,requests,reads,saved,approvals,call,turn,approve:(f:typeof approve)=>approve=f}
}

test('真实原生工具：目录只读；拒绝零写；附件本人指令批准一次原子批次并固定同轮request',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const directory=await f.call(read);assert.equal(directory.isError,false,JSON.stringify(directory));assert.equal(body(directory).types[0].title,'客户');assert.equal(f.approvals.length,0)
 f.approve(async()=> 'rejected');assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(f.requests.length,0)
 f.approve(async()=> 'allowed-once');const result=await f.call(write,{operations:[operation,{...operation,title:'客户乙'}]});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0]!.actor,{ownerId:'self',scopeIds:['sales']});assert.equal(f.requests[0]!.source!.sessionId,f.agent.session.id);assert.equal(f.requests[0]!.source!.seq,1)
 assert.equal(body(result).items.length,2);assert.ok(body(result).items.every((row:Record<string,unknown>)=>!('fields'in row)));assert.match(f.approvals.at(-1)!,/销售/);assert.match(f.approvals.at(-1)!,/客户乙/)
 assert.equal((await f.call(write,{operations:[operation,{...operation,title:'客户乙'}]})).isError,false);assert.equal(f.requests[0]!.input.requestId,f.requests[1]!.input.requestId)
 assert.equal((await f.call(write,{operations:[{...operation,title:'同轮另一意图'}]})).isError,true);assert.equal(f.saved.size,1)
})
test('edit完整读取并保留可选字段：遗漏明确拒绝，清空在确认中完整显示',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'name',value:'新姓名'},{name:'stage',value:'已联系'},{name:'note',value:''}]}
 const got=await f.call(read,{mode:'get',type:'customer',id:'one'});assert.equal(got.isError,false);assert.deepEqual(body(got).values,[{name:'name',value:'旧姓名'},{name:'stage',value:'待联系'},{name:'note',value:'必须保留'}])
 assert.equal((await f.call(write,{operations:[{...edit,fields:edit.fields.slice(0,2)}]})).isError,true);assert.equal(f.requests.length,0)
 assert.equal((await f.call(write,{operations:[edit]})).isError,false);assert.match(f.approvals.at(-1)!,/必须保留/);assert.match(f.approvals.at(-1)!,/清空/)
 f.existing.version=9;f.definition.fields.push({name:'added',label:'新增可选',from:'新增',type:'text',required:false});assert.equal((await f.call(write,{operations:[edit]})).isError,false,'已提交批次不因现定义多字段或旧版本先被拒');assert.equal(f.saved.size,1)
})
test('所有读mode严格互斥和有界，同业务回执可读，recent只用当前session发现旧request',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(write,{operations:[operation]})).isError,false);const request=f.requests[0]!.input.requestId;f.turn()
 for(const args of [{mode:'type',type:'customer'},{mode:'list',type:'customer',limit:1},{mode:'receipt',requestId:request},{mode:'recent-writes'}])assert.equal((await f.call(read,args)).isError,false)
 assert.equal(body(await f.call(read,{mode:'recent-writes'})).items[0].requestId,request);assert.match(JSON.stringify(body(await f.call(read,{mode:'recent-writes'}))),/不能证明/)
 for(const args of [{mode:'recent-writes',sessionId:'foreign'},{mode:'receipt',requestId:request,type:'customer'},{mode:'list',type:'customer',limit:101},{mode:'directory',scope:'other'},{mode:'get',type:'customer',id:'one',cursor:'x'},{mode:'unknown'}])assert.equal((await f.call(read,args)).isError,true)
})
test('审批中换轮/指令替换/业务/本人/角色/权限变化均拒绝；上游cancel与ask链保留',async t=>{
 for(const change of ['turn','replace','scope','owner','role','access']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>{if(change==='turn')f.turn();if(change==='replace')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never);if(change==='scope')f.ports.context=async sessionId=>({sessionId,scopeId:'other',roleId:null,version:2,locked:true});if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'foreign',sessionId,status:'ready'});if(change==='role')f.ports.isRoleConversation=async()=>true;if(change==='access')f.ports.scopes=async()=>[];return 'allowed-once'});assert.equal((await f.call(write,{operations:[operation]})).isError,true,change);assert.equal(f.requests.length,0,change)
 }
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const off=f.ctx.on('tools/pre-execute',async()=>({kind:'cancel' as const}));await f.call(write,{operations:[operation]});assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0);off()
 f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'原生策略确认'}));assert.equal((await f.call(write,{operations:[operation]})).isError,false);assert.match(f.approvals.at(-1)!,/原生策略确认/)
})
test('builder/pending daily/岗位/TaskRun/子Agent/general与伪参数均在审批前拒绝',async t=>{
 const binding={kind:'builder' as const,requestId:randomUUID(),title:'搭建',createdAt:stamp,updatedAt:stamp}
 for(const overrides of [{binding:async()=>binding},{binding:async()=>({...binding,kind:'daily' as const,scope:'sales'})},{isRoleConversation:async()=>true},{isTaskConversation:async()=>true},{readTaskPolicy:async()=>({allowedTools:[]})},{context:async()=>null}] satisfies Partial<BusinessRecordToolsPorts>[]){const f=await fixture(overrides);t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(read)).isError,true);assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(f.approvals.length,0)}
 const child=await fixture({},'subagent');t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call(read)).isError,true)
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());for(const args of [{operations:[operation],requestId:randomUUID()},{operations:[{...operation,scope:'other'}]},{operations:[]},{operations:Array(51).fill(operation)}])assert.equal((await f.call(write,args)).isError,true);assert.equal(f.approvals.length,0)
})
test('缺失目标声明和外部类型不得写，字段值先核验；大请求审批前拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(write,{operations:[{...operation,fields:[{name:'name',value:'甲'},{name:'stage',value:'伪阶段'}]}]})).isError,true)
 f.definition.fields.push({name:'related',label:'关系',from:'关系',type:'reference',required:false,referenceType:'missing'});assert.equal((await f.call(write,{operations:[operation]})).isError,true)
 f.definition.fields.pop();f.bundle.origin={kind:'market',loadId:'external'};assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(body(await f.call(read)).types[0].writable,false)
 f.bundle.origin={kind:'local-configuration',configurationVersion:1,configurationHash:hash};const large={...operation,summary:'文'.repeat(3500)};assert.equal((await f.call(write,{operations:Array.from({length:20},(_,i)=>({...large,title:'客户'+i}))})).isError,true);assert.equal(f.approvals.length,0)
})
test('丢写回包后新用户轮recent发现原提交且不重写；错误回包身份与跨scope回执拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const batch=f.ports.records.batch;f.ports.records.batch=async(...args)=>{await batch(...args);throw Error('lost response')}
 assert.equal((await f.call(write,{operations:[operation]})).isError,true);const request=f.requests[0]!.input.requestId;f.turn();const recent=await f.call(read,{mode:'recent-writes'});assert.equal(recent.isError,false);assert.equal(body(recent).items[0].requestId,request);assert.equal(f.requests.length,1)
 f.ports.records.batchReceipt=async()=>({...f.saved.get(request)!.result,scope:'other'});assert.equal((await f.call(read,{mode:'receipt',requestId:request})).isError,true)
 const g=await fixture();t.after(()=>g.ctx.fiber.dispose());g.ports.records.batch=async()=>({requestId:randomUUID(),scope:'sales',items:[g.existing]});assert.equal((await g.call(write,{operations:[operation]})).isError,true)
})

test('旧值使确认膨胀时审批前拒绝且不截断；缩小批次后完整显示，原生附加理由同受上限',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 f.definition.fields=Array.from({length:20},(_,i)=>({name:'field'+i,label:'字段'+i,from:'字段'+i,type:'text',required:false}))
 f.existing.fields=f.definition.fields.map(field=>({label:field.from,value:'旧'.repeat(2000)}))
 f.ports.records.get=async(_actor,input)=>({...structuredClone(f.existing),id:readBusinessRecordGet(input).id})
 const edit=(id:string)=>({operation:'edit',type:'customer',id,expectedVersion:1,fields:f.definition.fields.map(field=>({name:field.name,value:''}))})
 const operations=[edit('one'),edit('two')]
 assert.ok(Buffer.byteLength(JSON.stringify({operations}))<4096,'小请求也可能被旧值撑大确认')
 const denied=await f.call(write,{operations});assert.equal(denied.isError,true);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
 assert.match(denied.content.map(block=>block.type==='text'?block.text:'').join(''),/确认.*128.*缩小批次/)
 assert.equal((await f.call(write,{operations:[edit('one')]})).isError,false)
 assert.ok(Buffer.byteLength(f.approvals[0]!)<=131072);assert.equal(f.approvals[0]!.split('旧'.repeat(2000)).length-1,20,'完整保留所有旧值，不截断确认')
 f.turn();f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'原'.repeat(44000)}))
 const oversized=await f.call(write,{operations:[edit('two')]});assert.equal(oversized.isError,true);assert.equal(f.approvals.length,1);assert.equal(f.requests.length,1)
})

test('本人pre-step仅注入有界本地记录指引，pending/builder不注入且不影响原next',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.agent.session.append('turn/start',{turn:1} as never);const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新增客户'}]})],input={agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal}
 let calls=0;const next=async()=>{calls++;return {kind:'enter' as const,messages}}
 const result=await f.ctx.waterfall('agent/pre-step',input,next) as {messages:unknown[]};assert.equal(calls,1);assert.equal(result.messages.length,2);assert.match(JSON.stringify(result.messages[1]),/teloa_business_records_read/);assert.match(JSON.stringify(result.messages[1]),/销售/);assert.ok(JSON.stringify(result.messages[1]).length<2048)
 f.bundle.origin={kind:'market',loadId:'external'};assert.deepEqual((await f.ctx.waterfall('agent/pre-step',input,next) as {messages:unknown[]}).messages,messages,'仅外部来源不注入本地维护指引')
 f.bundle.origin={kind:'local-configuration',configurationVersion:1,configurationHash:hash}
 f.ports.binding=async()=>({requestId:randomUUID(),kind:'daily',scope:'sales',title:'未绑',createdAt:stamp,updatedAt:stamp});assert.deepEqual((await f.ctx.waterfall('agent/pre-step',input,next) as {messages:unknown[]}).messages,messages)
})
test('批准后的核验等待中取消或改变context仍零写；插件注入/双本人不能提供操作身份',async t=>{
 for(const mode of ['abort','change']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const abort=new AbortController();f.approve(async()=>{f.ports.definitions=async()=>{if(mode==='abort')abort.abort();else f.ports.context=async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:2,locked:true});return [f.bundle]};return 'allowed-once'});assert.equal((await f.call(write,{operations:[operation]},abort.signal)).isError,true);assert.equal(f.requests.length,0)
 }
 for(const mode of ['injected','multiple']){const f=await fixture();t.after(()=>f.ctx.fiber.dispose());if(mode==='injected'){f.agent.session.append('turn/start',{turn:1} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'plugin:fake',form:'notice'} as never,content:[{type:'text',text:'写记录'}]}),{surfaceOp:'append'})}else f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:'append'});assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(f.approvals.length,0)}
})
test('大读取明确失败不省略字段，目录32条；get/list/receipt/recent错误归属均拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.bundle.objectTypes=Array.from({length:40},(_,i)=>({definition:{...f.definition,id:'type-'+i},source:{...f.bundle.objectTypes[0]!.source,localId:'type-'+i}}));const page=body(await f.call(read));assert.equal(page.types.length,32);assert.equal(page.nextCursor,32)
 f.bundle.objectTypes=[{definition:f.definition,source:{...f.bundle.objectTypes[0]!.source,localId:'customer'}}]
 f.existing.fields=Array.from({length:50},(_,i)=>({label:'字段'+i,value:'文'.repeat(2000)}));const large=await f.call(read,{mode:'get',type:'customer',id:'one'});assert.equal(large.isError,true);assert.match(JSON.stringify(large),/大小上限/)
 f.existing.fields=[];f.existing.type='foreign';assert.equal((await f.call(read,{mode:'get',type:'customer',id:'one'})).isError,true);assert.equal((await f.call(read,{mode:'list',type:'customer'})).isError,true)
 const row={requestId:randomUUID(),scope:'sales',source:{sessionId:'another-session',messageId:'m',seq:1},createdAt:stamp,operations:[{requestId:randomUUID(),operation:'create' as const,reference:{scope:'sales',type:'customer',id:'one',version:1,snapshotHash:hash}}]};f.ports.records.recentBatches=async()=>({items:[row]});assert.equal((await f.call(read,{mode:'recent-writes'})).isError,true)
})
test('缺失或改变可信source的旧回执只能经batch核验，不能直接当本轮成功',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(write,{operations:[operation]})).isError,false);const row=[...f.saved.values()][0]!
 row.source=undefined;assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(f.saved.size,1)
 row.source={sessionId:'other',messageId:'other',seq:1};assert.equal((await f.call(write,{operations:[operation]})).isError,true);assert.equal(f.saved.size,1)
})

test('普通本人会话的接手同事偏好不扩大身份：无真实role/task link仍可读写',async t=>{
 const f=await fixture({context:async sessionId=>({sessionId,scopeId:'sales',roleId:'12345678-1234-4234-8234-123456789012',version:2,locked:true})});t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call(read)).isError,false);assert.equal((await f.call(write,{operations:[operation]})).isError,false);assert.equal(f.requests.length,1)
})

test('recent-writes最长合法引用仍有界且保留下一页，归档返回原准确快照身份',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.ports.records.recentBatches=async(_actor,input)=>{
  const item=()=>({requestId:randomUUID(),scope:'sales',source:{sessionId:f.agent.session.id,messageId:'文'.repeat(200),seq:1},createdAt:stamp,operations:Array.from({length:50},(_,i)=>({requestId:randomUUID(),operation:'create' as const,reference:{scope:'sales',type:'类'.repeat(80),id:'录'.repeat(197)+String(i).padStart(3,'0'),version:1,snapshotHash:hash}}))})
  return {items:Array.from({length:input.limit??20},item),nextCursor:'next-page'}
 };const recent=await f.call(read,{mode:'recent-writes'});assert.equal(recent.isError,false,JSON.stringify(recent));assert.equal(body(recent).nextCursor,'next-page');assert.ok(Buffer.byteLength(recent.content.map(block=>block.type==='text'?block.text:'').join(''))<262144)
 const archived=await f.call(write,{operations:[{operation:'archive',type:'customer',id:'one',expectedVersion:1}]});assert.equal(archived.isError,false,JSON.stringify(archived));assert.deepEqual(body(archived).items[0],{operation:'archive',scope:'sales',type:'customer',id:'one',version:2,snapshotHash:hash})
})

test('共享业务身份授权保持本人普通偏好、bound daily及即时scope指纹',async t=>{
 const shared=await import('../src/business-conversation-authorization.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-conversation-authorization.ts');throw error})
 assert.equal(typeof shared.authorizeBusinessConversation,'function')
 const f=await fixture({context:async sessionId=>({sessionId,scopeId:'sales',roleId:'preference',version:2,locked:true})});t.after(()=>f.ctx.fiber.dispose())
 const value=await shared.authorizeBusinessConversation(f.ports,{agent:f.agent,signal:new AbortController().signal},'业务负责人')
 assert.deepEqual(value.actor,{ownerId:'self',scopeIds:['sales']});assert.equal(value.scope,'sales');assert.match(value.fingerprint,/preference/)
 f.ports.scopes=async()=>[];await assert.rejects(shared.authorizeBusinessConversation(f.ports,{agent:f.agent,signal:new AbortController().signal},'业务负责人'),{code:'teloa/forbidden'})
})

async function referenceFixture(format:'teloa.business-object-type/v1'|'teloa.business-object-type/v2'='teloa.business-object-type/v1'){
 const f=await fixture()
 const definition=readBusinessObjectTypeDefinitionV2({...f.definition,format:'teloa.business-object-type/v2',fields:[{name:'related',label:'客户公司',from:'原客户公司',type:'reference',required:true,referenceType:'account'}]})
 const sourceDefinition={...definition,format,fields:definition.fields} as BusinessObjectTypeDefinition
 const account={...f.definition,id:'account',title:'公司'}
 f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition:sourceDefinition},{source:{...f.bundle.objectTypes[0]!.source,localId:'account'},definition:account}]}]
 const targets=new Map(['old-company','new-company'].map((id,i)=>[id,{...f.existing,type:'account',id,title:i===0?'原公司中文名':'新公司中文名',fields:[]}]))
 const reads:Array<{scope:string;type:string;id:string;version?:number}>=[]
 f.existing.fields=[{label:'原客户公司',value:'old-company'}]
 f.ports.records.get=async(actor,input)=>{
  assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']})
  const target=readBusinessRecordGet(input);reads.push(target)
  if(target.type==='customer'&&target.id==='one')return structuredClone(f.existing)
  const result=target.type==='account'?targets.get(target.id):undefined
  if(!result)throw new WorkError('teloa/invalid-input','本地记录类型、身份或完整字段值不正确。')
  return structuredClone(result)
 }
 const create={operation:'create',type:'customer',title:'关联客户',summary:'登记关联',fields:[{name:'related',value:'new-company'}]}
 return {...f,targets,targetReads:reads,sourceDefinition,account,create}
}
test('v1/v2 原生目录开放同业务本地单选关联，批准才原子写入原目标ID且显示真实名称',async t=>{
 for(const format of ['teloa.business-object-type/v1','teloa.business-object-type/v2'] as const){
  const f=await referenceFixture(format);t.after(()=>f.ctx.fiber.dispose())
  const directory=body(await f.call(read));assert.equal(directory.types[0].writable,true);assert.match(directory.rules,/referenceType/);assert.match(directory.rules,/单选/)
  const type=body(await f.call(read,{mode:'type',type:'customer'}));assert.equal(type.writable,true);assert.match(type.rules,/ID/);assert.match(type.rules,/标题/)
  f.approve(async()=> 'rejected');assert.equal((await f.call(write,{operations:[f.create]})).isError,true);assert.equal(f.requests.length,0)
  f.approve(async()=> 'allowed-once');const result=await f.call(write,{operations:[f.create]});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.requests.length,1)
  assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,[{name:'related',value:'new-company'}]);assert.match(f.approvals.at(-1)!,/新公司中文名/)
  assert.ok(f.targetReads.every(item=>item.scope==='sales'&&item.type==='account'&&item.id==='new-company'&&item.version===undefined))
 }
})
test('目标缺失、归档、外部来源、身份错误和无效ID均在原生审批前拒绝',async t=>{
 for(const problem of ['missing','archived','external','source','wrong-type','wrong-id','wrong-scope','corrupt','empty','json','unsafe']){
  const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose())
  if(problem==='missing')f.targets.delete('new-company')
  if(problem==='archived')f.targets.get('new-company')!.deletedAt=stamp
  if(problem==='external')f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition:f.sourceDefinition}]},{...f.bundle,origin:{kind:'market',loadId:'outside'},objectTypes:[{source:{...f.bundle.objectTypes[0]!.source,localId:'account'},definition:f.account}]}]
  if(problem==='source')f.account.sourceId='unregistered'
  if(problem==='wrong-type')f.targets.get('new-company')!.type='customer'
  if(problem==='wrong-id')f.targets.get('new-company')!.id='other'
  if(problem==='wrong-scope')f.targets.get('new-company')!.scope='other'
  if(problem==='corrupt')f.ports.records.get=async()=>{throw new WorkError('teloa/storage-corrupt','目标快照损坏。')}
  const value=problem==='empty'?'':problem==='json'?'"new-company"':problem==='unsafe'?'../new-company':'new-company'
  assert.equal((await f.call(write,{operations:[{...f.create,fields:[{name:'related',value}]}]})).isError,true,problem);assert.equal(f.approvals.length,0,problem);assert.equal(f.requests.length,0,problem)
  if(['external','source'].includes(problem))assert.equal(body(await f.call(read)).types[0].writable,false,problem)
 }
})
test('原生单选编辑完整摘要显示关联前后名称，审批期间目标更新或归档拒绝落批',async t=>{
 const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose())
 const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:'new-company'}]}
 assert.equal((await f.call(write,{operations:[edit]})).isError,false);assert.match(f.approvals[0]!,/原公司中文名/);assert.match(f.approvals[0]!,/新公司中文名/)
 for(const change of ['rename','archive','before','hash','definition']){
  const g=await referenceFixture();t.after(()=>g.ctx.fiber.dispose());g.approve(async()=>{const target=g.targets.get(change==='before'?'old-company':'new-company')!;if(change==='definition')g.account.version='2.0.0';else{target.snapshotHash='b'.repeat(64);if(change!=='hash')target.version=2;if(change==='archive')target.deletedAt=stamp;else if(change!=='hash')target.title='变更公司'};return 'allowed-once'})
  assert.equal((await g.call(write,{operations:[edit]})).isError,true,change);assert.equal(g.approvals.length,1);assert.equal(g.requests.length,0,change)
 }
})
test('单选成功回执优先重放，不因目标后来归档或类型变化否认已保存批次',async t=>{
 const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call(write,{operations:[f.create]})).isError,false)
 f.targets.get('new-company')!.deletedAt=stamp;f.ports.records.get=async()=>{throw new WorkError('teloa/storage-corrupt','重放不应读取当前目标。')};f.account.sourceId='removed'
 assert.equal((await f.call(write,{operations:[f.create]})).isError,false);assert.equal(f.saved.size,1);assert.equal(f.requests.length,2)
 assert.equal(f.requests[0]!.input.requestId,f.requests[1]!.input.requestId)
})

test('所有非空旧关联编辑均重查；清空可选失效关联保留真实状态，源归档不查询目标',async t=>{
 for(const unavailable of ['missing','archived']){
  const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose())
  f.sourceDefinition.fields[0]!.required=false
  if(unavailable==='missing')f.targets.delete('old-company');else f.targets.get('old-company')!.deletedAt=stamp
  const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:'old-company'}]}
  assert.equal((await f.call(write,{operations:[edit]})).isError,true,unavailable);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
  assert.equal((await f.call(write,{operations:[{...edit,fields:[{name:'related',value:''}]}]})).isError,false);assert.match(f.approvals[0]!,new RegExp(unavailable==='missing'?'不存在':'已归档'));assert.match(f.approvals[0]!,/清空/)
  f.turn();f.targetReads.length=0
  assert.equal((await f.call(write,{operations:[{operation:'archive',type:'customer',id:'one',expectedVersion:1}]})).isError,false);assert.deepEqual(f.targetReads,[{scope:'sales',type:'customer',id:'one'},{scope:'sales',type:'customer',id:'one'}])
 }
})
test('关联目标重命名后仍保存同ID；读取源完整原值不向关联递归展开',async t=>{
 const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose())
 f.targets.get('new-company')!.title='后来更名的公司'
 const got=await f.call(read,{mode:'get',type:'customer',id:'one'});assert.equal(got.isError,false);assert.deepEqual(body(got).values,[{name:'related',value:'old-company'}]);assert.deepEqual(f.targetReads,[{scope:'sales',type:'customer',id:'one'}])
 assert.equal((await f.call(write,{operations:[f.create]})).isError,false);assert.equal((f.requests[0]!.input.operations[0] as any).fields[0].value,'new-company');assert.match(f.approvals[0]!,/后来更名的公司/)
})

test('真实后端 invalid-input 缺失语义：v1/v2 可清空旧悬空关联并在审批中展示不存在',async t=>{
 for(const format of ['teloa.business-object-type/v1','teloa.business-object-type/v2'] as const){
  const f=await referenceFixture(format);t.after(()=>f.ctx.fiber.dispose());f.sourceDefinition.fields[0]!.required=false;f.targets.delete('old-company')
  const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:''}]}
  const result=await f.call(write,{operations:[edit]});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.approvals.length,1);assert.match(f.approvals[0]!,/不存在/);assert.match(f.approvals[0]!,/清空/)
  assert.equal(f.requests.length,1);assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,[{name:'related',value:''}])
 }
})
test('真实后端 invalid-input 缺失语义：v1/v2 可将旧悬空关联改绑有效目标的原ID',async t=>{
 for(const format of ['teloa.business-object-type/v1','teloa.business-object-type/v2'] as const){
  const f=await referenceFixture(format);t.after(()=>f.ctx.fiber.dispose());f.targets.delete('old-company')
  const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:'new-company'}]}
  const result=await f.call(write,{operations:[edit]});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.approvals.length,1);assert.match(f.approvals[0]!,/不存在/);assert.match(f.approvals[0]!,/新公司中文名/)
  assert.equal(f.requests.length,1);assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,[{name:'related',value:'new-company'}])
 }
})
test('旧值缺失分类不吞非法ID、非本地类型、坏回包或服务权限与不可用错误',async t=>{
 for(const problem of ['unsafe-id','missing-type','external-source','bad-response','storage-corrupt','forbidden','host-unavailable']){
  const f=await referenceFixture();t.after(()=>f.ctx.fiber.dispose());f.sourceDefinition.fields[0]!.required=false
  const original=f.ports.records.get
  if(problem==='unsafe-id')f.existing.fields[0]!.value='../old-company'
  if(problem==='missing-type')f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition:f.sourceDefinition}]}]
  if(problem==='external-source')f.account.sourceId='external'
  f.ports.records.get=async(actor,input)=>{const target=readBusinessRecordGet(input);if(target.type==='account'){
   if(problem==='bad-response')return {...f.targets.get('old-company')!,unexpected:'corrupt'} as BusinessObjectSnapshot
   if(['storage-corrupt','forbidden','host-unavailable'].includes(problem))throw new WorkError(('teloa/'+problem) as 'teloa/storage-corrupt','旧目标读取明确失败：'+problem)
  }return original(actor,input)}
  const result=await f.call(write,{operations:[{operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:''}]}]})
  assert.equal(result.isError,true,problem);assert.equal(f.approvals.length,0,problem);assert.equal(f.requests.length,0,problem)
  if(['storage-corrupt','forbidden','host-unavailable'].includes(problem))assert.match(result.content.map(item=>item.type==='text'?item.text:'').join(''),new RegExp('旧目标读取明确失败：'+problem))
 }
})

async function multiReferenceFixture(){
 const f=await fixture()
 const definition=readBusinessObjectTypeDefinitionV2({...f.definition,format:'teloa.business-object-type/v2',fields:[{format:'teloa.business-rich-field/v2',name:'related',label:'关联客户',from:'原关联客户',type:'multi-reference',referenceType:'account',required:true},{name:'code',label:'编号',from:'原编号',type:'text',required:false}],constraints:{uniqueFields:['related','code']}})
 const account:BusinessObjectTypeDefinition={...f.definition,id:'account',title:'公司',fields:[{name:'name',label:'公司名',from:'公司名',type:'text',required:false}]}
 f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition},{source:{...f.bundle.objectTypes[0]!.source,localId:'account'},definition:account}]}]
 const targets=new Map(['old-a','old-b','new-a','new-b'].map((id,i)=>[id,{...f.existing,type:'account',id,title:['原公司甲','原公司乙','新公司甲','新公司乙'][i]!,fields:[]}]))
 const targetReads:Array<{scope:string;type:string;id:string;version?:number}>=[]
 f.existing.fields=[{label:'原关联客户',value:'["old-a","old-b"]'},{label:'原编号',value:'必须保留'}]
 f.ports.records.get=async(actor,input)=>{
  assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']})
  const target=readBusinessRecordGet(input);targetReads.push(target)
  if(target.type==='customer'&&target.id==='one')return structuredClone(f.existing)
  const snapshot=target.type==='account'?targets.get(target.id):undefined
  if(!snapshot)throw new WorkError('teloa/invalid-input','本地记录类型、身份或完整字段值不正确。')
  return structuredClone(snapshot)
 }
 const create={operation:'create',type:'customer',title:'关联项目',summary:'登记两家客户',fields:[{name:'related',value:'["new-a","new-b"]'},{name:'code',value:'项目甲'}]}
 const edit={operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'related',value:'["new-a","new-b"]'},{name:'code',value:'必须保留'}]}
 return {...f,definition,account,targets,targetReads,create,edit}
}
test('多选原生目录说明规范真实ID与独立唯一，批准后一次保存全部目标且拒绝零批次',async t=>{
 const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose())
 const directory=body(await f.call(read));assert.equal(directory.types[0].writable,true);assert.match(directory.rules,/multi-reference/);assert.match(directory.rules,/uniqueFields/)
 const type=body(await f.call(read,{mode:'type',type:'customer'}));assert.equal(type.writable,true);assert.deepEqual(type.definition,f.definition)
 assert.match(type.rules,/字典序/);assert.match(type.rules,/1[–-]32/);assert.match(type.rules,/2000/);assert.match(type.rules,/独立唯一/);assert.match(type.rules,/每个成员/);assert.match(type.rules,/事务/);assert.match(type.rules,/预查.*不能/)
 assert.doesNotMatch(type.rules,/关系多选、唯一.*尚不支持/)
 f.approve(async()=> 'rejected');assert.equal((await f.call(write,{operations:[f.create]})).isError,true);assert.equal(f.requests.length,0)
 f.approve(async()=> 'allowed-once');const result=await f.call(write,{operations:[f.create]});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.requests.length,1)
 assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,[...f.create.fields].sort((a,b)=>a.name.localeCompare(b.name)))
 const summary=JSON.parse(f.approvals.at(-1)!.split('：').at(-1)!);const related=summary.operations[0].fields[0]
 assert.deepEqual(related.relations.value.map((row:any)=>[row.id,row.title,row.status,row.reference.type,row.reference.scope,row.reference.snapshotHash]),[['new-a','新公司甲','可用','account','sales',hash],['new-b','新公司乙','可用','account','sales',hash]])
 assert.deepEqual(f.targetReads.map(row=>row.id),['new-a','new-b','new-a','new-b','new-a','new-b']);assert.equal(f.reads.includes('list'),false)
})
test('多选编辑审批完整显示全部前后真实标题与状态，字段完整替换不遗漏编号',async t=>{
 const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose())
 const got=await f.call(read,{mode:'get',type:'customer',id:'one'});assert.equal(got.isError,false);assert.deepEqual(body(got).values,[{name:'related',value:'["old-a","old-b"]'},{name:'code',value:'必须保留'}]);assert.deepEqual(f.targetReads.map(row=>row.type),['customer'])
 assert.equal((await f.call(write,{operations:[{...f.edit,fields:f.edit.fields.slice(0,1)}]})).isError,true);assert.equal(f.approvals.length,0)
 assert.equal((await f.call(write,{operations:[f.edit]})).isError,false)
 for(const title of ['原公司甲','原公司乙','新公司甲','新公司乙','必须保留'])assert.ok(f.approvals[0]!.includes(title),title)
 const summary=JSON.parse(f.approvals[0]!.split('：').at(-1)!);assert.deepEqual(summary.operations[0].fields[0].relations.before.map((row:any)=>row.id),['old-a','old-b'])
 assert.equal(summary.operations[0].fields[0].relations.value.length,2);assert.deepEqual((f.requests[0]!.input.operations[0] as any).fields,[...f.edit.fields].sort((a,b)=>a.name.localeCompare(b.name)))
})
test('多选每个目标的有效性与声明类型真实核验，任一失效或非法值都在审批前拒绝',async t=>{
 for(const problem of ['missing','archived','wrong-type','wrong-id','wrong-scope','bad-response','forbidden','storage-corrupt','external','source','empty','duplicate','unsorted','unsafe','noncanonical','over-count','over-bytes']){
  const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose());let value=f.create.fields[0]!.value
  if(problem==='missing')f.targets.delete('new-b')
  if(problem==='archived')f.targets.get('new-b')!.deletedAt=stamp
  if(problem==='wrong-type')f.targets.get('new-b')!.type='customer'
  if(problem==='wrong-id')f.targets.get('new-b')!.id='other'
  if(problem==='wrong-scope')f.targets.get('new-b')!.scope='other'
  if(problem==='source')f.account.sourceId='outside'
  if(problem==='external')f.ports.definitions=async()=>[{...f.bundle,objectTypes:[{source:f.bundle.objectTypes[0]!.source,definition:f.definition}]},{...f.bundle,origin:{kind:'market',loadId:'outside'},objectTypes:[{source:{...f.bundle.objectTypes[0]!.source,localId:'account'},definition:f.account}]}]
  const original=f.ports.records.get
  f.ports.records.get=async(actor,input)=>{const target=readBusinessRecordGet(input);if(target.id==='new-b'){
   if(problem==='bad-response')return {...f.targets.get('new-b')!,unexpected:'corrupt'} as BusinessObjectSnapshot
   if(['forbidden','storage-corrupt'].includes(problem))throw new WorkError(('teloa/'+problem) as 'teloa/forbidden','目标读取失败')
  }return original(actor,input)}
  if(problem==='empty')value=''
  if(problem==='duplicate')value='["new-a","new-a"]'
  if(problem==='unsorted')value='["new-b","new-a"]'
  if(problem==='unsafe')value='["../new-a","new-b"]'
  if(problem==='noncanonical')value='["new-a", "new-b"]'
  if(problem==='over-count')value=JSON.stringify(Array.from({length:33},(_,i)=>'id'+String(i).padStart(2,'0')))
  if(problem==='over-bytes')value=JSON.stringify(Array.from({length:32},(_,i)=>'id'+String(i).padStart(2,'0')+'a'.repeat(80)))
  const result=await f.call(write,{operations:[{...f.create,fields:[{name:'related',value},f.create.fields[1]]}]})
  assert.equal(result.isError,true,problem);assert.equal(f.approvals.length,0,problem);assert.equal(f.requests.length,0,problem)
  if(['source','external'].includes(problem))assert.equal(body(await f.call(read)).types[0].writable,false,problem)
 }
})
test('多选审批中任一前后目标或约束变动都使fingerprint失效，执行零落批',async t=>{
 for(const change of ['before-title','after-title','hash','archive','version','definition','constraints']){
  const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose())
  f.approve(async()=>{const item=f.targets.get(change==='before-title'?'old-b':'new-b')!;if(change==='definition')f.account.version='2.0.0';else if(change==='constraints')f.definition.constraints={uniqueFields:['code']};else if(change==='before-title'||change==='after-title')item.title='审批后新名称';else if(change==='hash')item.snapshotHash='b'.repeat(64);else if(change==='version')item.version=2;else item.deletedAt=stamp;return 'allowed-once'})
  assert.equal((await f.call(write,{operations:[f.edit]})).isError,true,change);assert.equal(f.approvals.length,1,change);assert.equal(f.requests.length,0,change)
 }
})
test('多选旧缺失或归档可逐成员移除、清空或改绑；仍保留任一失效成员拒绝',async t=>{
 for(const unavailable of ['missing','not-found','archived'])for(const replacement of ['["old-a"]','','["new-a","new-b"]']){
  const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose());f.definition.fields[0]!.required=false
  if(unavailable==='archived')f.targets.get('old-b')!.deletedAt=stamp;else f.targets.delete('old-b')
  const original=f.ports.records.get
  if(unavailable==='not-found')f.ports.records.get=async(actor,input)=>{if(readBusinessRecordGet(input).id==='old-b')throw new WorkError('teloa/not-found','目标不存在');return original(actor,input)}
  const retained=await f.call(write,{operations:[{...f.edit,fields:[{name:'related',value:'["old-a","old-b"]'},f.edit.fields[1]]}]})
  assert.equal(retained.isError,true);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
  const result=await f.call(write,{operations:[{...f.edit,fields:[{name:'related',value:replacement},f.edit.fields[1]]}]})
  assert.equal(result.isError,false,unavailable+replacement+JSON.stringify(result));assert.match(f.approvals[0]!,new RegExp(unavailable==='archived'?'已归档':'不存在'))
  assert.equal((f.requests[0]!.input.operations[0] as any).fields.find((field:any)=>field.name==='related').value,replacement)
 }
})
test('多选旧值解析与服务权限错误严格拒绝，不把坏回包或非法数组归为缺失',async t=>{
 for(const problem of ['unsafe','unsorted','bad-response','forbidden','storage-corrupt','host-unavailable']){
  const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose());f.definition.fields[0]!.required=false
  if(problem==='unsafe')f.existing.fields[0]!.value='["../old-a"]'
  if(problem==='unsorted')f.existing.fields[0]!.value='["old-b","old-a"]'
  const original=f.ports.records.get
  f.ports.records.get=async(actor,input)=>{if(readBusinessRecordGet(input).id==='old-b'){
   if(problem==='bad-response')return {...f.targets.get('old-b')!,unexpected:'corrupt'} as BusinessObjectSnapshot
   if(['forbidden','storage-corrupt','host-unavailable'].includes(problem))throw new WorkError(('teloa/'+problem) as 'teloa/forbidden','旧目标明确读取失败：'+problem)
  }return original(actor,input)}
  const result=await f.call(write,{operations:[{...f.edit,fields:[{name:'related',value:''},f.edit.fields[1]]}]})
  assert.equal(result.isError,true,problem);assert.equal(f.approvals.length,0,problem);assert.equal(f.requests.length,0,problem)
 }
})
test('多选已成功回执优先重放，源归档仅核源不展开目标且服务唯一拒绝真实回传',async t=>{
 const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call(write,{operations:[f.create]})).isError,false)
 f.ports.records.get=async()=>{throw new WorkError('teloa/storage-corrupt','重放不可查当前目标')};f.account.sourceId='removed'
 assert.equal((await f.call(write,{operations:[f.create]})).isError,false);assert.equal(f.saved.size,1);assert.equal(f.requests[0]!.input.requestId,f.requests[1]!.input.requestId)
 const g=await multiReferenceFixture();t.after(()=>g.ctx.fiber.dispose());g.account.sourceId='removed'
 assert.equal((await g.call(write,{operations:[{operation:'archive',type:'customer',id:'one',expectedVersion:1}]})).isError,false)
 assert.deepEqual(g.targetReads.map(row=>row.type),['customer','customer'])
 const rejected=await multiReferenceFixture();t.after(()=>rejected.ctx.fiber.dispose());rejected.ports.records.batch=async()=>{throw new WorkError('teloa/conflict','字段「关联客户」唯一值已被其他活跃项目占用。')}
 const result=await rejected.call(write,{operations:[rejected.create]});assert.equal(result.isError,true);assert.match(result.content.map(row=>row.type==='text'?row.text:'').join(''),/唯一值.*占用/);assert.equal(rejected.approvals.length,1);assert.equal(rejected.saved.size,0);assert.equal(rejected.reads.includes('list'),false)
})

test('多选最大32个目标仍完整确认，确认摘要超128KiB先拒绝且不截断',async t=>{
 const f=await multiReferenceFixture();t.after(()=>f.ctx.fiber.dispose())
 const ids=Array.from({length:32},(_,i)=>'target'+String(i).padStart(2,'0'))
 for(const id of ids)f.targets.set(id,{...f.existing,type:'account',id,title:'中文目标'+id,fields:[]})
 const create={...f.create,fields:[{name:'related',value:JSON.stringify(ids)},f.create.fields[1]]}
 const large=await f.call(write,{operations:Array.from({length:32},(_,i)=>({...create,title:'项目'+i}))})
 assert.equal(large.isError,true);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0);assert.match(large.content.map(row=>row.type==='text'?row.text:'').join(''),/确认.*128/)
 const result=await f.call(write,{operations:[create]});assert.equal(result.isError,false,JSON.stringify(result))
 const summary=JSON.parse(f.approvals[0]!.split('：').at(-1)!);assert.equal(summary.operations[0].fields[0].relations.value.length,32)
 assert.deepEqual(summary.operations[0].fields[0].relations.value.map((row:any)=>row.id),ids)
})
