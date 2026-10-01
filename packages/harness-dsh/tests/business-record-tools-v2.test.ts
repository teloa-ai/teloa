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
import {readBusinessObjectTypeDefinitionVersioned,readBusinessRichFieldValue,type BusinessObjectFieldDefinition,type BusinessRichFieldDefinition} from '@teloa/contract'
import type {BusinessDefinitionBundleVersioned} from '@teloa/backend'
import {registerBusinessRecordTools,type BusinessRecordToolsPorts} from '../src/business-record-tools.ts'

const scope='sales',hash='a'.repeat(64),origin={kind:'local-configuration' as const,configurationVersion:1,configurationHash:hash}
const basic={name:'name',label:'姓名',from:'姓名',type:'text' as const,required:false}
const money={format:'teloa.business-rich-field/v2' as const,name:'amount',label:'金额',from:'原金额',type:'money' as const,required:false,currencies:['SGD']}
const tags={format:'teloa.business-rich-field/v2' as const,name:'tags',label:'方向',from:'原方向',type:'multi-enum' as const,required:false,values:['销售','开发','安全']}
const legacyRules='新增/编辑只作用于当前业务的本地记录。编辑fields完整替换，get.values给出全部当前字段；保留未改值，空字符串显式清空。一条本人指令只确认提交一批1–50项，最多128KiB。结果未知先receipt或recent-writes核对，不能用新轮次重复写入。'
async function fixture(format:'teloa.business-object-type/v1'|'teloa.business-object-type/v2',fields:Array<BusinessObjectFieldDefinition|BusinessRichFieldDefinition>){
 const definition=readBusinessObjectTypeDefinitionVersioned({format,id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'local',fields})
 const bundle:BusinessDefinitionBundleVersioned={origin,scope,domain:scope,objectTypes:[{definition,source:{loadId:'local',scope,localId:'customer',version:'1.0.0',contentHash:hash,fileHash:hash,definitionHash:hash,origin:'local'}}],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map([['local',{connected:true}]])}
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('record-rules-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'读取客户字段'}]}),{surfaceOp:'append'})
 const unavailable=async()=>{throw Error('规则读取不得访问记录或写入')}
 const ports:BusinessRecordToolsPorts={owner:'self',conversation:async sessionId=>({ownerId:'self',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:scope,roleId:null,version:1,locked:true}),scopes:async()=>[{scope,title:'销售'}],definitions:async()=>[bundle],records:{list:unavailable,get:unavailable,batch:unavailable,batchReceipt:unavailable,recentBatches:unavailable}}
 registerBusinessRecordTools(ctx,ports)
 const call=async(args:Record<string,unknown>={})=>{
  const result=await ctx.tools.execute({agent,name:'teloa_business_records_read',arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
  assert.equal(result.isError,false,JSON.stringify(result))
  return result.content.map(item=>item.type==='text'?item.text:'').join('')
 }
 return {ctx,definition,call}
}
function assertRichRules(rules:unknown){
 assert.equal(typeof rules,'string','v2 富字段读取必须说明 fields[].value 的规范编码')
 assert.match(rules as string,/规范 JSON 字符串/)
 assert.match(rules as string,/ISO/)
 assert.match(rules as string,/currencies/)
 assert.ok((rules as string).includes('{"currency":"SGD","decimal":"123.45"}'),'金额示例须使用真实声明允许的币种')
 assert.match(rules as string,/无.*尾零/)
 assert.match(rules as string,/负零/)
 assert.match(rules as string,/声明顺序/)
 assert.match(rules as string,/无重复/)
 assert.ok((rules as string).includes('["销售","开发"]'),'多选示例须使用真实声明的选项及顺序')
 assert.match(rules as string,/可选字段/)
 assert.match(rules as string,/省略/)
 assert.match(rules as string,/\[\].*空金额/)
 assert.match(rules as string,/编辑.*空字符串/)
}
test('v2 日常目录说明富字段规范编码，并使用真实币种与选项生成示例',async t=>{
 const f=await fixture('teloa.business-object-type/v2',[basic,money,tags]);t.after(()=>f.ctx.fiber.dispose())
 const directory=JSON.parse(await f.call())
 assertRichRules(directory.rules)
 assert.equal(directory.types[0].writable,true)
 assert.equal(readBusinessRichFieldValue(money,'{"currency":"SGD","decimal":"123.45"}')?.canonical,'{"currency":"SGD","decimal":"123.45"}')
 assert.equal(readBusinessRichFieldValue(tags,'["销售","开发"]')?.canonical,'["销售","开发"]')
})
test('v2 日常 type 读取同时提供规范编码、可选缺值与编辑清空规则',async t=>{
 const f=await fixture('teloa.business-object-type/v2',[basic,money,tags]);t.after(()=>f.ctx.fiber.dispose())
 const type=JSON.parse(await f.call({mode:'type',type:'customer'}))
 assertRichRules(type.rules)
 assert.deepEqual(type.definition,f.definition)
})
test('只有多选字段时独立说明 JSON.stringify 编码且不宣称金额能力',async t=>{
 const f=await fixture('teloa.business-object-type/v2',[tags]);t.after(()=>f.ctx.fiber.dispose())
 for(const args of [{},{mode:'type',type:'customer'}]){
  const {rules}=JSON.parse(await f.call(args))
  assert.match(rules,/JSON.stringify/)
  assert.doesNotMatch(rules,/money|currency|decimal/)
 }
})
test('v1 目录与 type 回包保持原始 JSON 字节和 shape',async t=>{
 const f=await fixture('teloa.business-object-type/v1',[basic]);t.after(()=>f.ctx.fiber.dispose())
 assert.equal(await f.call(),JSON.stringify({scope,title:'销售',types:[{type:'customer',title:'客户',readable:true,writable:true,archivable:true}],rules:legacyRules}))
 assert.equal(await f.call({mode:'type',type:'customer'}),JSON.stringify({scope,definition:f.definition,writable:true,archivable:true,origin}))
})
test('只有基础字段的 v2 不宣称金额或多选能力',async t=>{
 const f=await fixture('teloa.business-object-type/v2',[basic]);t.after(()=>f.ctx.fiber.dispose())
 assert.equal(JSON.parse(await f.call()).rules,legacyRules)
 assert.equal(Object.hasOwn(JSON.parse(await f.call({mode:'type',type:'customer'})),'rules'),false)
})
