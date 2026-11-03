import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {WorkError,readBusinessObjectTypeDefinition} from '@teloa/contract'
import {BusinessRecordService} from '../../backend/src/work/business-records.ts'
import {BusinessChangeSetService} from '../../backend/src/work/business-change-sets.ts'
import {registerBusinessChangeSetTools} from '../src/business-change-set-tools.ts'
const owner='synthetic-owner',scope='receipts'
const field=(name,type,required=true,extra={})=>({name,label:name,from:name,type,required,...extra})
const definition=(fields=[field('item','text'),field('units','number',true,{integer:true,minimum:0}),field('amount','number',true,{decimalScale:2}),field('verified','boolean'),field('note','text',false)])=>readBusinessObjectTypeDefinition({format:'teloa.business-object-type/v1',id:'receipt',version:'1.0.0',domain:'receipts',title:'合成记录',unit:'条',lead:'合成记录',sourceId:'receipt-local',fields})
function fixture(def=definition(),kind='local-configuration'){
 const reads=[],queries=[]
 const db={query:async(sql,params)=>{queries.push({sql,params});assert.match(sql,/^select pg_advisory_xact_lock_shared\(hashtextextended\(\$1,0\)\)$/);return {rows:[],rowCount:0}}}
 const records=new BusinessRecordService({connect:()=>{throw Error('不允许建库或打开外部连接')}},{now:()=> '2026-11-02T00:00:00.000Z'},{definitions:{forScope:async(_db,o,s)=>{reads.push([o,s]);return o===owner&&s===scope?[{origin:{kind,configurationVersion:1,configurationHash:'a'.repeat(64)},objectTypes:[{definition:def}],sources:new Map([[def.sourceId,{connected:true}]])}]:[]}},warehouse:{assertQuota:()=>{throw Error('不应写入')},tombstone:()=>{throw Error('不应写入')}},references:{pinInTransaction:()=>{throw Error('不应写入')}}})
 return {records,db,reads,queries,preview:(value,actor={ownerId:owner,scopeIds:[scope]})=>records.previewBatchInTransaction(db,actor,value)}
}
const values=(legacy=false)=>[{name:'item',value:'合成事项'},{name:'units',value:legacy?'2':2},{name:'amount',value:legacy?'7.50':7.5},{name:'verified',value:legacy?'false':false}]
const batch=(fields=values(),type='receipt')=>({scope,requestId:randomUUID(),operations:[{operation:'create',type,title:'合成记录',summary:'',fields}]})
const wrong=()=>batch([{name:'untrusted-name',value:'untrusted-value'}])
async function errorOf(promise){try{await promise;assert.fail('应拒绝')}catch(error){assert.ok(error instanceof WorkError);return error}}
test('真实记录服务只向已授权同类型未知字段返回准确有界定义，短API文案不回显输入',async()=>{
 const f=fixture(),e=await errorOf(f.preview(wrong()))
 assert.equal(e.code,'teloa/invalid-input');assert.ok(!e.message.includes('units'));assert.ok(!JSON.stringify(e).includes('untrusted'))
 assert.deepEqual(e.details,{reason:'unknown-record-field',fieldGuidance:{type:'receipt',totalFields:5,truncated:false,fields:[{name:'item',type:'text',required:true},{name:'units',type:'number',required:true,integer:true,minimum:0},{name:'amount',type:'number',required:true,decimalScale:2},{name:'verified',type:'boolean',required:true},{name:'note',type:'text',required:false}]}})
 assert.ok(f.queries.length>0);assert.ok(f.queries.every(q=>q.sql.startsWith('select ')))
})
test('无权scope、其他owner、未知type和不可写来源均不泄露字段定义',async()=>{
 const f=fixture()
 for(const [value,actor,code] of [[wrong(),{ownerId:owner,scopeIds:['other']},'teloa/forbidden'],[wrong(),{ownerId:'other-owner',scopeIds:[scope]},'teloa/invalid-input'],[batch(values(),'other-type'),{ownerId:owner,scopeIds:[scope]},'teloa/invalid-input']]){
  const e=await errorOf(f.preview(value,actor));assert.equal(e.code,code);assert.equal(e.details,undefined);assert.ok(!e.message.includes('units'))
 }
 assert.ok(!f.reads.some(([o,s])=>o===owner&&s==='other'))
 for(const kind of ['market','configuration-preview'])assert.equal((await errorOf(fixture(definition(),kind).preview(wrong()))).details,undefined)
})
test('50个最长required字段及数字约束在Service与受限prepare工具中完整可见且有界',async t=>{
 const def=definition(Array.from({length:50},(_,i)=>field('f'+String(i).padStart(2,'0')+'x'.repeat(60),'number',true,{integer:true,minimum:-0.0000012345678901234567,decimalScale:15})))
 const e=await errorOf(fixture(def).preview(wrong())),g=e.details.fieldGuidance
 assert.equal(g.totalFields,50);assert.equal(g.truncated,false);assert.equal(g.fields.length,50)
 assert.deepEqual(g.fields,def.fields.map(({name,type,required,integer,minimum,decimalScale})=>({name,type,required,integer,minimum,decimalScale})))
 assert.ok(Buffer.byteLength(JSON.stringify(g))>768);assert.ok(Buffer.byteLength(JSON.stringify(g))<=16384);assert.ok(!JSON.stringify(g).includes('untrusted'))
 const f=await toolFixture(t,def,true),result=await f.call({operations:wrong().operations});assert.equal(result.isError,true)
 const strings=[];const visit=value=>{if(typeof value==='string')strings.push(value);else if(value&&typeof value==='object')for(const item of Object.values(value))visit(item)};visit(result)
 const rendered=strings.find(value=>value.includes('可写字段定义：'));assert.ok(rendered)
 const actual=JSON.parse(rendered.split('可写字段定义：')[1].split('。number/boolean')[0]);assert.deepEqual(actual,g)
 assert.deepEqual(f.facts(),{prepareCount:1,approvals:0});assert.equal(f.groupPolicy.allowedTools.length,1);assert.deepEqual(f.groupPolicy.allowedTools,['teloa_business_change_prepare'])
})
test('真实预览保留typed和legacy原值；错误数字约束仍拒绝且批次无写',async()=>{
 for(const legacy of [false,true]){
  const f=fixture(),v=values(legacy),preview=await f.preview(batch(v))
  assert.deepEqual(preview.operations[0].fields.map(({name,value})=>({name,value})),v.toSorted((a,b)=>a.name.localeCompare(b.name)))
  assert.ok(f.queries.every(q=>q.sql.startsWith('select ')))
 }
 for(const [name,value] of [['units',1.5],['units',-1],['amount',1.234],['verified','maybe']]){
  const f=fixture(),input=values().map(row=>row.name===name?{name,value}:row)
  const e=await errorOf(f.preview(batch(input)));assert.equal(e.code,'teloa/invalid-input');assert.notEqual(e.details?.reason,'unknown-record-field')
 }
 const f=fixture(),value=batch();value.operations.push(wrong().operations[0]);await errorOf(f.preview(value));assert.ok(f.queries.every(q=>q.sql.startsWith('select ')))
})
async function toolFixture(t,def=definition(),groupOnly=false){
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('guidance-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({source:{kind:'user',...(groupOnly?{rpcId:'synthetic-native'}:{})},content:[{type:'text',text:'整理合成记录'}]}),{surfaceOp:'append'})
 const f=fixture(def);let fallback,prepareCount=0,approvals=0
 const groupPolicy={allowedTools:['teloa_business_change_prepare'],nativeRequestId:'synthetic-native',stopRequested:false}
 const groupTask=async()=>({ownerId:owner,sessionId:agent.session.id,scope,runId:'synthetic-run',taskId:'synthetic-task',taskVersion:1,groupId:'synthetic-group',roleId:'synthetic-role',fingerprint:'synthetic-group-current',nativeRequestId:'synthetic-native'})
 registerBusinessChangeSetTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>groupOnly?groupPolicy:null,groupTask,isRoleConversation:async()=>false,isTaskConversation:async()=>groupOnly,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:scope,roleId:null,version:1,locked:false}),scopes:async()=>[{scope,title:'合成记录'}],changes:{prepare:async(actor,input)=>{prepareCount++;if(fallback)throw fallback;return f.preview({...input,requestId:input.requestId},actor)},get:()=>{throw Error('不读草稿')},apply:()=>{throw Error('不采用')}}})
 ctx.provide('approval',{request:()=>{approvals++;throw Error('不应审批')}})
 return {call:args=>ctx.tools.execute({name:'teloa_business_change_prepare',arguments:args,callId:ToolCallId(randomUUID()),agent,signal:new AbortController().signal}),setError:value=>{fallback=value},facts:()=>({prepareCount,approvals}),groupPolicy,f}
}
test('真实ToolRuntime准备链呈现同一Service错误的模型字段指引，不变成功/审批路径',async t=>{
 const f=await toolFixture(t),result=await f.call({operations:wrong().operations})
 assert.equal(result.isError,true);const text=JSON.stringify(result)
 for(const value of ['units','integer','decimalScale','verified','boolean','totalFields','truncated'])assert.ok(text.includes(value),value)
 assert.ok(!text.includes('untrusted-name')&&!text.includes('untrusted-value'));assert.deepEqual(f.facts(),{prepareCount:1,approvals:0})
 const ok=await f.call({operations:batch().operations});assert.equal(ok.isError,false,JSON.stringify(ok));assert.equal(f.facts().approvals,0)
})
test('真实工具授权拒绝与其他WorkError保持原语义，不把任意details当字段发现',async t=>{
 const f=await toolFixture(t)
 f.setError(new WorkError('teloa/forbidden','合成无权提示。',{reason:'unknown-record-field',fieldGuidance:{secret:'must-not-expose'}}))
 const denied=await f.call({operations:batch().operations});assert.equal(denied.isError,true);assert.ok(JSON.stringify(denied).includes('合成无权提示'));assert.ok(!JSON.stringify(denied).includes('must-not-expose'))
 f.setError(new WorkError('teloa/invalid-input','原格式拒绝。',{reason:'other',fieldGuidance:{secret:'must-not-expose'}}))
 const invalid=await f.call({operations:batch().operations});assert.ok(JSON.stringify(invalid).includes('原格式拒绝'));assert.ok(!JSON.stringify(invalid).includes('must-not-expose'))
})

test('真实草稿事务在同一批次出现未知字段时回滚，零草稿/正式记录写入',async()=>{
 const f=fixture(),queries=[]
 const db={query:async(sql)=>{queries.push(sql);if(sql==='begin'||sql==='rollback'||sql.startsWith('select pg_advisory_xact_lock(')||sql.startsWith('select pg_advisory_xact_lock_shared(')||sql==='select request_hash,document from teloa_business_change_requests where owner_id=$1 and request_id=$2')return {rows:[],rowCount:0};throw Error('禁止未预期SQL：'+sql)},release:()=>queries.push('release')}
 const changes=new BusinessChangeSetService({connect:async()=>db},{id:randomUUID,now:()=> '2026-11-02T00:00:00.000Z'},f.records)
 const input=batch();input.operations.push(wrong().operations[0])
 const e=await errorOf(changes.prepare({ownerId:owner,scopeIds:[scope]},input,{sessionId:'synthetic-session',messageId:'synthetic-instruction',seq:1,fingerprint:'synthetic-context'}))
 assert.equal(e.details.reason,'unknown-record-field');assert.deepEqual(queries.slice(-2),['rollback','release'])
 assert.ok(!queries.some(sql=>/^(insert|update|delete|commit)/i.test(sql)))
})
