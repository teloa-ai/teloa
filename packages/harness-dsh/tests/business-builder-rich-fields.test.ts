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
import {readBusinessConfigurationCandidateVersioned} from '@teloa/contract'
import type {BusinessConfigurationDraft} from '@teloa/backend'
import {registerBusinessBuilderTools,type BusinessBuilderToolsPorts} from '../src/business-builder-tools.ts'

const sourceId='records',scope='business_0123456789abcdef0123456789abcdef'
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY']}
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId,fields:[money]}
const patch={upsertDefinitions:[{kind:'object-type',definition:object}],upsertPages:[{id:'customers',title:'客户',kind:'records',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'customers'}
async function fixture(format:'teloa.business-configuration/v1'|'teloa.business-configuration/v2'){
 const owner='builder:'+randomUUID(),now='2026-09-30T00:00:00.000Z'
 let draft:BusinessConfigurationDraft={ownerId:owner,id:randomUUID(),scope,revision:1,baseVersion:0,hash:'a'.repeat(64),status:'draft',createdAt:now,updatedAt:now,candidate:readBusinessConfigurationCandidateVersioned({format,scope,title:'客户跟进',sources:[{sourceId,kind:'local-records'}],definitions:[],pages:[]})}
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('rich-builder-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'添加金额'}]}),{surfaceOp:'append'})
 const binding={requestId:randomUUID(),kind:'builder' as const,title:'客户跟进',draftId:draft.id,sessionId:agent.session.id,createdAt:now,updatedAt:now},writes:unknown[]=[],approvals:unknown[]=[]
 const ports:BusinessBuilderToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>binding,draft:async()=>draft,revise:async input=>{writes.push(input);draft={...draft,revision:input.expectedRevision+1,candidate:readBusinessConfigurationCandidateVersioned({...draft.candidate,definitions:input.patch.upsertDefinitions??[],pages:input.patch.upsertPages??[],homePageId:input.patch.homePageId})};return draft},reviseReceipt:async()=>undefined,upgradeFormat:async()=>{throw Error('此夹具只验证现有格式读取和修订')}}
 registerBusinessBuilderTools(ctx,ports);ctx.provide('approval',{request:async(input:unknown)=>{approvals.push(input);return 'allowed-once'}})
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 return {ctx,draft,call,writes,approvals}
}
test('原生 v2 搭建目录声明真实富字段格式，并经批准修订真实对象正文',async t=>{
 const f=await fixture('teloa.business-configuration/v2');t.after(()=>f.ctx.fiber.dispose())
 const read=await f.call('teloa_business_builder_read'),body=JSON.parse(read.content.map(item=>item.type==='text'?item.text:'').join(''))
 assert.equal(body.capabilities.format,'teloa.business-configuration/v2');assert.ok(body.capabilities.fieldTypes.includes('money'));assert.ok(body.capabilities.fieldTypes.includes('multi-enum'))
 assert.match(body.capabilities.rules,/currencies/)
 assert.deepEqual(body.capabilities.viewFormats,['teloa.business-view/v1','teloa.business-view/v2'])
 assert.deepEqual(body.capabilities.richViewFieldCapabilities.money,{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']})
 assert.match(body.capabilities.rules,/half-even/);assert.match(body.capabilities.rules,/view-ref/);assert.doesNotMatch(body.capabilities.rules,/类型化指标支持仍待后续开发/)
 const result=await f.call('teloa_business_builder_revise',{draftId:f.draft.id,expectedRevision:1,patch});assert.equal(result.isError,false);assert.equal(f.writes.length,1);assert.equal(f.approvals.length,1)
 assert.deepEqual((f.writes[0] as any).patch.upsertDefinitions[0].definition,object)
})
test('旧 v1 草案工具不接受 v2 字段或伪造格式；拒绝发生在审批和服务写入之前',async t=>{
 const f=await fixture('teloa.business-configuration/v1');t.after(()=>f.ctx.fiber.dispose())
 const read=await f.call('teloa_business_builder_read'),body=JSON.parse(read.content.map(item=>item.type==='text'?item.text:'').join(''))
 assert.equal(body.capabilities.format,'teloa.business-configuration/v1');assert.equal(body.capabilities.fieldTypes.includes('money'),false)
 for(const args of [{draftId:f.draft.id,expectedRevision:1,patch},{draftId:f.draft.id,expectedRevision:1,format:'teloa.business-configuration/v2',patch}])assert.equal((await f.call('teloa_business_builder_revise',args)).isError,true)
 assert.equal(f.writes.length,0);assert.equal(f.approvals.length,0)
})
test('原生 v2 整组修订支持记录与类型化统计看板，旧视图不能伪装为金额计算',async t=>{
 const f=await fixture('teloa.business-configuration/v2');t.after(()=>f.ctx.fiber.dispose())
 const view={format:'teloa.business-view/v2',id:'total',version:'1.0.0',domain:scope,title:'人民币总额',kind:'board-card',chart:'number',objectType:'customer',measures:[{id:'sum',label:'金额',aggregation:'sum',field:'amount',currency:'CNY'}],filters:[],limit:1}
 const widget={format:'teloa.business-widget/v1',id:'total-widget',version:'1.0.0',domain:scope,title:'人民币总额',kind:'view-ref',viewRef:'total'}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'金额统计',widgets:['total-widget'],layout:[{widget:'total-widget',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:3600},acknowledgeShortInterval:false}
 const boardPatch={...patch,upsertDefinitions:[...patch.upsertDefinitions,{kind:'view',definition:view},{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],upsertPages:[...patch.upsertPages,{id:'overview',title:'金额统计',kind:'dashboard',dashboardId:'overview'}],homePageId:'overview'}
 const legacy={...boardPatch,upsertDefinitions:boardPatch.upsertDefinitions.map(item=>item.kind==='view'?{...item,definition:{...view,format:'teloa.business-view/v1'}}:item)}
 assert.equal((await f.call('teloa_business_builder_revise',{draftId:f.draft.id,expectedRevision:1,patch:legacy})).isError,true);assert.equal(f.approvals.length,0);assert.equal(f.writes.length,0)
 assert.equal((await f.call('teloa_business_builder_revise',{draftId:f.draft.id,expectedRevision:1,patch:boardPatch})).isError,false)
 assert.equal(f.approvals.length,1);assert.equal(f.writes.length,1);assert.deepEqual((f.writes[0] as any).patch.upsertDefinitions[1].definition,view)
})

test('原生 v1/v2 搭建能力开放真实同业务单选 reference，并明确未支持的关系边界',async t=>{
 for(const format of ['teloa.business-configuration/v1','teloa.business-configuration/v2'] as const){
  const f=await fixture(format);t.after(()=>f.ctx.fiber.dispose())
  const result=await f.call('teloa_business_builder_read');assert.equal(result.isError,false)
  const {capabilities}=JSON.parse(result.content.map(item=>item.type==='text'?item.text:'').join(''))
  assert.match(capabilities.rules,/单选/);assert.match(capabilities.rules,/referenceType/);assert.match(capabilities.rules,/目标.*ID/)
  assert.match(capabilities.rules,/唯一/);assert.match(capabilities.rules,/跨业务/)
  if(format==='teloa.business-configuration/v1')assert.match(capabilities.rules,/关系多选/)
  assert.doesNotMatch(capabilities.rules,/reference.*整体.*不可用|含 reference.*不支持本地新增/)
 }
})

test('原生 v2 能力声明多选关联与逐字段唯一，自然语言生成的真实本地定义经一次批准保存',async t=>{
 const f=await fixture('teloa.business-configuration/v2');t.after(()=>f.ctx.fiber.dispose())
 const result=await f.call('teloa_business_builder_read'),{capabilities}=JSON.parse(result.content.map(item=>item.type==='text'?item.text:'').join(''))
 assert.ok(capabilities.fieldTypes.includes('multi-reference'));assert.match(capabilities.rules,/referenceType/);assert.match(capabilities.rules,/uniqueFields/)
 assert.match(capabilities.rules,/独立唯一/);assert.match(capabilities.rules,/不是组合唯一/);assert.match(capabilities.rules,/每个成员/);assert.match(capabilities.rules,/事务/);assert.match(capabilities.rules,/预查.*不能/)
 assert.match(capabilities.rules,/1[–-]32/);assert.match(capabilities.rules,/2000/);assert.match(capabilities.rules,/跨业务.*尚未支持/)
 assert.deepEqual(capabilities.richViewFieldCapabilities['multi-reference'],{dimension:false,measure:false,aggregations:[],operators:['contains','overlaps']})
 assert.match(capabilities.rules,/count 条件/)
 assert.doesNotMatch(capabilities.rules,/关系多选、唯一约束.*尚未支持/)
 const customer={...object,fields:[{name:'code',label:'客户编号',from:'原客户编号',type:'text',required:true}],constraints:{uniqueFields:['code']}}
 const project={...object,id:'project',title:'项目',fields:[{format:'teloa.business-rich-field/v2',name:'customers',label:'客户',from:'原客户',type:'multi-reference',referenceType:'customer',required:false}],constraints:{uniqueFields:['customers']}}
 const relationsPatch={upsertDefinitions:[{kind:'object-type',definition:customer},{kind:'object-type',definition:project}],upsertPages:[{id:'projects',title:'项目',kind:'records',objectType:'project',fields:['customers'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'projects'}
 const saved=await f.call('teloa_business_builder_revise',{draftId:f.draft.id,expectedRevision:1,patch:relationsPatch})
 assert.equal(saved.isError,false,JSON.stringify(saved));assert.equal(f.approvals.length,1);assert.equal(f.writes.length,1)
 assert.deepEqual((f.writes[0] as any).patch.upsertDefinitions,relationsPatch.upsertDefinitions)
})

test('旧 v1 不宣称或接收多选关联和唯一声明，v2 不接受组合唯一及多选枚举唯一',async t=>{
 const multi={format:'teloa.business-rich-field/v2',name:'customers',label:'客户',from:'原客户',type:'multi-reference',referenceType:'customer',required:false}
 const legacy=await fixture('teloa.business-configuration/v1');t.after(()=>legacy.ctx.fiber.dispose())
 const read=await legacy.call('teloa_business_builder_read'),{capabilities}=JSON.parse(read.content.map(item=>item.type==='text'?item.text:'').join(''))
 assert.equal(capabilities.fieldTypes.includes('multi-reference'),false)
 for(const definition of [{...object,fields:[multi]},{...object,format:'teloa.business-object-type/v1',fields:[{name:'code',label:'编号',from:'编号',type:'text',required:false}],constraints:{uniqueFields:['code']}}])assert.equal((await legacy.call('teloa_business_builder_revise',{draftId:legacy.draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}]}})).isError,true)
 assert.equal(legacy.approvals.length,0);assert.equal(legacy.writes.length,0)
 const current=await fixture('teloa.business-configuration/v2');t.after(()=>current.ctx.fiber.dispose())
 for(const definition of [{...object,constraints:{uniqueTogether:['amount']}},{...object,fields:[{format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'标签',type:'multi-enum',values:['甲','乙'],required:false}],constraints:{uniqueFields:['tags']}}])assert.equal((await current.call('teloa_business_builder_revise',{draftId:current.draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}]}})).isError,true)
 assert.equal(current.approvals.length,0);assert.equal(current.writes.length,0)
})
