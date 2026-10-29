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
import type {BusinessChangeSetOrigin} from '@teloa/backend'
import type {BusinessChangeSetToolsPorts} from '../src/business-change-set-tools.ts'
type PoolClient=Parameters<Parameters<BusinessChangeSetToolsPorts['changes']['apply']>[2]>[0]
const module=await import('../src/business-change-set-tools.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-change-set-tools.ts');throw e})
test('准备工具不审批也不采用；真实 ToolRuntime 只在具体批准后执行，拒绝零写',async t=>{
 assert.equal(typeof module.registerBusinessChangeSetTools,'function')
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('draft-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'准备本地修改'}]}),{surfaceOp:'append'})
 const id=randomUUID(),digest='a'.repeat(64),draft={id,scope:'sales',revision:1,digest,state:'draft',sessionId:agent.session.id,preview:{targets:[],operations:[{operation:'edit',type:'customer',title:'客户甲',before:{fields:[{label:'状态',value:'待联系'}]},fields:[{name:'state',value:'已联系'}]}]}}
 let adopted=0,prepared=0,approve=true,unavailable=false,cancel:AbortController|undefined;const approvals:string[]=[]
 const ports={owner:'owner',conversation:async (sessionId:string)=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async (sessionId:string)=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:false}),scopes:async()=>[{scope:'sales',title:'销售'}],changes:{prepare:async()=>{prepared++;return draft},get:async()=>draft,awaiting:async()=>{draft.state='awaiting-approval';return draft},apply:async(_actor:unknown,_input:unknown,authorize:(db:PoolClient,origin:BusinessChangeSetOrigin)=>Promise<string>)=>{await authorize({} as PoolClient,{sessionId:agent.session.id,messageId:'instruction',seq:1,fingerprint:'test-context'});adopted++;draft.state='applied';return draft}}}
 module.registerBusinessChangeSetTools(ctx,ports as unknown as BusinessChangeSetToolsPorts)
 ctx.provide('approval',{request:async (request:{reason:string})=>{approvals.push(request.reason);if(unavailable)throw Error('审批服务暂时不可用');if(cancel){cancel.abort();return 'rejected'}return approve?'allowed-once':'rejected'}})
 const call=async(name:string,args:Record<string,unknown>,controller=new AbortController())=>ctx.tools.execute({name,arguments:args,callId:ToolCallId(randomUUID()),agent,signal:controller.signal})
 assert.equal((await call('teloa_business_change_prepare',{operations:[{operation:'create',type:'customer',title:'客户甲',summary:'',fields:[]}]})).isError,false)
 assert.equal(prepared,1);assert.equal(adopted,0);assert.equal(approvals.length,0)
 const input={changeSetId:id,expectedRevision:1,expectedDigest:digest}
 approve=false;await call('teloa_business_change_apply',input);assert.equal(adopted,0);assert.equal(draft.state,'draft','原生拒绝后仍可重新审阅，不持久化虚假的等待状态')
 cancel=new AbortController();assert.equal((await call('teloa_business_change_apply',input,cancel)).isError,true);assert.equal(draft.state,'draft');assert.equal(adopted,0);cancel=undefined
 unavailable=true;assert.equal((await call('teloa_business_change_apply',input)).isError,true);assert.equal(draft.state,'draft');assert.equal(adopted,0);unavailable=false
 approve=true;const applied=await call('teloa_business_change_apply',input);assert.equal(applied.isError,false,JSON.stringify(applied));assert.equal(adopted,1)
 assert.ok(approvals.every(reason=>reason.includes('待联系')&&reason.includes('已联系')))
 assert.equal((await call('teloa_business_change_apply',{...input,approved:true})).isError,true);assert.equal(adopted,1)
})

test('群明确工作受限授权：只认 Run 冻结授予与宿主事实，原 Run 输入为指令身份，采用仍经原生审批，审批后事实变化即拒绝',async t=>{
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('task-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never)
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'native-1'} as never,content:[{type:'text',text:'群明确工作：新增客户记录'}]}),{surfaceOp:'append'})
 // 活动追加拼入同一轮：普通会话的「恰一条本人指令」不成立，但任务指令身份仍是原 Run 输入。
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'append-1'} as never,content:[{type:'text',text:'补充：备注写合成验收'}]}),{surfaceOp:'append'})
 const all=['teloa_business_change_prepare','teloa_business_change_apply','teloa_business_change_read']
 const id=randomUUID(),digest='b'.repeat(64),draft={id,scope:'sales',revision:1,digest,state:'draft',sessionId:agent.session.id,preview:{targets:[],operations:[{operation:'create',type:'customer',title:'客户乙',fields:[{name:'stage',value:'待联系'}]}]}}
 let allowed=all,grant:{fingerprint:string;nativeRequestId:string}|Error={fingerprint:'f1',nativeRequestId:'native-1'},adopted=0,approve=true,origin:BusinessChangeSetOrigin|undefined
 const reads:unknown[]=[],approvals:string[]=[]
 const ports={owner:'owner',conversation:async()=>{throw Error('任务路径不应调用本人会话闸')},readTaskPolicy:async()=>({allowedTools:allowed,nativeRequestId:'native-1'}),isRoleConversation:async()=>false,isTaskConversation:async()=>true,binding:async()=>undefined,context:async()=>null,scopes:async()=>[{scope:'sales',title:'销售'}],
  readTaskPolicyInTransaction:async(db:unknown)=>{reads.push(db);return {allowedTools:allowed,nativeRequestId:'native-1'}},
  groupTask:async(db:unknown,sessionId:string)=>{reads.push(db);if(grant instanceof Error)throw grant;return {ownerId:'owner',sessionId,runId:'r',taskId:'t',taskVersion:2,scope:'sales',groupId:'g',roleId:'role',...grant}},
  changes:{prepare:async(_actor:unknown,_input:unknown,value:BusinessChangeSetOrigin)=>{origin=value;return draft},get:async()=>draft,apply:async(_actor:unknown,_input:unknown,authorize:(db:PoolClient,origin:BusinessChangeSetOrigin)=>Promise<string>)=>{if(await authorize({tx:1} as unknown as PoolClient,origin!)!==origin!.fingerprint)throw Error('fingerprint');adopted++;draft.state='applied';return draft}}}
 module.registerBusinessChangeSetTools(ctx,ports as unknown as BusinessChangeSetToolsPorts)
 ctx.provide('approval',{request:async (request:{reason:string})=>{approvals.push(request.reason);return approve?'allowed-once':'rejected'}})
 const call=async(name:string,args:Record<string,unknown>)=>ctx.tools.execute({name,arguments:args,callId:ToolCallId(randomUUID()),agent,signal:new AbortController().signal})
 const prepare={operations:[{operation:'create',type:'customer',title:'客户乙',summary:'',fields:[{name:'stage',value:'待联系'}]}]}
 allowed=['teloa_business_change_read'];assert.equal((await call('teloa_business_change_prepare',prepare)).isError,true,'没有明确授予准备工具');assert.equal(origin,undefined)
 allowed=all;grant=new Error('交流回应不能修改业务记录。');assert.equal((await call('teloa_business_change_prepare',prepare)).isError,true,'宿主事实不成立（reply、别群、撤权、停止、摘要变化）');assert.equal(origin,undefined)
 grant={fingerprint:'f1',nativeRequestId:'other'};assert.equal((await call('teloa_business_change_prepare',prepare)).isError,true,'原 Run 身份不一致')
 grant={fingerprint:'f1',nativeRequestId:'native-1'}
 const prepared=await call('teloa_business_change_prepare',prepare);assert.equal(prepared.isError,false,JSON.stringify(prepared))
 const seen=origin as BusinessChangeSetOrigin|undefined
 assert.equal(seen?.fingerprint,'f1');assert.equal(seen?.sessionId,agent.session.id);const users=agent.session.snapshotEvents().filter(event=>event.type==='user/message');assert.equal(seen?.seq,users[0]!.seq,'指令身份是原 Run 输入而非追加');assert.notEqual(seen?.seq,users[1]!.seq)
 const input={changeSetId:id,expectedRevision:1,expectedDigest:digest}
 approve=false;await call('teloa_business_change_apply',input);assert.equal(adopted,0,'原生拒绝零写')
 assert.ok(approvals.at(-1)!.includes('客户乙')&&approvals.at(-1)!.includes('待联系'),'审批展示固定差异')
 approve=true;grant={fingerprint:'f2',nativeRequestId:'native-1'}
 assert.equal((await call('teloa_business_change_apply',input)).isError,true,'审批期间停止、撤权或来源变化后不能采用');assert.equal(adopted,0)
 grant={fingerprint:'f1',nativeRequestId:'native-1'}
 const applied=await call('teloa_business_change_apply',input);assert.equal(applied.isError,false,JSON.stringify(applied));assert.equal(adopted,1)
 assert.deepEqual(reads.slice(-2),[{tx:1},{tx:1}],'工具策略与宿主事实都在同一采用事务内读取')
 assert.equal((await call('teloa_business_change_apply',{...input,approved:true})).isError,true,'自报批准字段不算审批')
 ports.readTaskPolicyInTransaction=undefined as unknown as typeof ports.readTaskPolicyInTransaction
 assert.equal((await call('teloa_business_change_apply',input)).isError,true,'缺少事务内权限读取时不落回独立事务、不采用')
 assert.equal(adopted,1)
 // 未装配受限授权时，任务会话一律沿原闸拒绝。
 const plain=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await plain.plugin(plugin);await plain.plugin(AgentLoop,{agents:[]});t.after(()=>plain.fiber.dispose())
 const other=await plain.agents.create({sessionId:SessionId('task-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 module.registerBusinessChangeSetTools(plain,{...ports,groupTask:undefined} as unknown as BusinessChangeSetToolsPorts)
 assert.equal((await plain.tools.execute({name:'teloa_business_change_prepare',arguments:prepare,callId:ToolCallId(randomUUID()),agent:other.agent,signal:new AbortController().signal})).isError,true)
})

test('准备工具的模型可见参数即本地记录批次协议：真实失败格式在参数层被拦下并说明原因；按广告形状构造的批次通过唯一契约',async t=>{
 const {validateArgs}=await import('@deepseek-ai/dsh-tools')
 const {readBusinessChangeSetPrepare}=await import('@teloa/contract')
 const {businessRecordOperationsParameter}=await import('../src/business-record-batch-schema.ts')
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('schema-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新增客户记录'}]}),{surfaceOp:'append'})
 const seen:unknown[]=[]
 const ports={owner:'owner',conversation:async (sessionId:string)=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async (sessionId:string)=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:false}),scopes:async()=>[{scope:'sales',title:'销售'}],
  changes:{prepare:async(_actor:unknown,input:unknown)=>{seen.push(input);return {id:randomUUID(),revision:1,digest:'c'.repeat(64)}},get:async()=>{throw Error('unused')},apply:async()=>{throw Error('unused')}}}
 module.registerBusinessChangeSetTools(ctx,ports as unknown as BusinessChangeSetToolsPorts)
 const schema=ctx.tools.schemas(agent).find(item=>item.name==='teloa_business_change_prepare')!
 const spec={operations:businessRecordOperationsParameter}
 assert.deepEqual(JSON.parse(JSON.stringify((schema as {parameters?:{properties?:Record<string,unknown>}}).parameters?.properties?.operations)),JSON.parse(JSON.stringify((await import('@deepseek-ai/dsh-tools')).parameterSchemaSpecToJsonSchema(spec).properties.operations)),'广告的就是共享批次协议')
 // 真实 r7 失败参数：op 代替 operation、title/summary 嵌在 fields 对象里。
 const actual={operations:[{op:'create',type:'customer',fields:{title:'验收客户南辰',summary:'群内交办',stage:'待联系',note:'群内交办新增'}}]}
 assert.ok(validateArgs(spec,actual).length>0,'参数层就指出形状错误')
 assert.throws(()=>readBusinessChangeSetPrepare({...actual,scope:'sales',requestId:randomUUID()}),{code:'teloa/invalid-input'})
 const call=(args:Record<string,unknown>)=>ctx.tools.execute({name:'teloa_business_change_prepare',arguments:args,callId:ToolCallId(randomUUID()),agent,signal:new AbortController().signal})
 assert.equal((await call(actual)).isError,true);assert.equal(seen.length,0)
 // 只看广告形状构造：operation + 顶层 type/title/summary + fields:[{name,value}]。
 const shaped={operations:[{operation:'create',type:'customer',title:'验收客户南辰',summary:'群内交办',fields:[{name:'stage',value:'待联系'},{name:'note',value:'群内交办新增'}]}]}
 assert.deepEqual(validateArgs(spec,shaped),[])
 const result=await call(shaped);assert.equal(result.isError,false,JSON.stringify(result))
 assert.deepEqual((seen[0] as {operations:unknown}).operations,readBusinessChangeSetPrepare({...shaped,scope:'sales',requestId:randomUUID()}).operations,'宿主固定 scope/requestId 后走唯一批次契约')
 // 自报 scope/requestId 仍拒绝；edit 必须带原 id 与版本。
 assert.equal((await call({...shaped,scope:'other'})).isError,true)
 assert.equal((await call({operations:[{operation:'edit',type:'customer',fields:[{name:'stage',value:'已联系'}]}]})).isError,true);assert.equal(seen.length,1)
})

test('原生prepare公开日期与长度协议，失败给出可修正原因且不回显字段原值',async t=>{
 const {assertBusinessRecordFieldValue}=await import('@teloa/backend')
 const {readBusinessChangeSetPrepare}=await import('@teloa/contract')
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]});t.after(()=>ctx.fiber.dispose())
 const {agent}=await ctx.agents.create({sessionId:SessionId('value-rules-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'准备一条业务记录'}]}),{surfaceOp:'append'})
 let prepared=0,approvals=0
 const ports:BusinessChangeSetToolsPorts={owner:'owner',conversation:async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:false}),scopes:async()=>[{scope:'sales',title:'销售'}],changes:{
  prepare:async(_actor,input)=>{
   const batch=readBusinessChangeSetPrepare(input),op=batch.operations[0]!
   assert.ok(op.operation==='create')
   for(const field of [{name:'observed',label:'告警时间',from:'时间',type:'datetime' as const,required:true},{name:'detail',label:'告警正文',from:'正文',type:'text' as const,required:true}])assertBusinessRecordFieldValue(field,op.fields.find(value=>value.name===field.name)?.value)
   prepared++;return {id:randomUUID(),revision:1,digest:'d'.repeat(64)} as Awaited<ReturnType<BusinessChangeSetToolsPorts['changes']['prepare']>>
  },get:async()=>{throw Error('unused')},apply:async()=>{throw Error('不得采用')},
 }}
 module.registerBusinessChangeSetTools(ctx,ports)
 ctx.provide('approval',{request:async()=>{approvals++;return 'rejected'}})
 const schema=ctx.tools.schemas(agent).find(item=>item.name==='teloa_business_change_prepare')!,advertised=JSON.stringify(schema)
 for(const required of ['2000','4000','UTF-16','YYYY-MM-DDTHH:mm:ss.sssZ','2026-10-28T15:11:38.000Z','不能只改后缀'])assert.ok(advertised.includes(required),required)
 const call=(date:string,detail:string)=>ctx.tools.execute({name:'teloa_business_change_prepare',arguments:{operations:[{operation:'create',type:'alert',title:'告警',summary:'',fields:[{name:'observed',value:date},{name:'detail',value:detail}]}]},callId:ToolCallId(randomUUID()),agent,signal:new AbortController().signal})
 const invalidDate='2026-10-28T23:11:38+08:00',dateResult=await call(invalidDate,'PRIVATE-SHORT-TEXT')
 assert.equal(dateResult.isError,true);assert.match(JSON.stringify(dateResult),/YYYY-MM-DDTHH:mm:ss.sssZ/);assert.match(JSON.stringify(dateResult),/2026-10-28T15:11:38.000Z/);assert.ok(!JSON.stringify(dateResult).includes(invalidDate));assert.ok(!JSON.stringify(dateResult).includes('PRIVATE-SHORT-TEXT'))
 for(const length of [4345,2447]){
  const result=await call('2026-10-28T15:11:38.000Z','PRIVATE-LONG-TEXT-'+ '密'.repeat(length-18)),text=JSON.stringify(result)
  assert.equal(result.isError,true);assert.ok(text.includes(String(length)));assert.ok(text.includes('2000'));assert.ok(!text.includes('PRIVATE-LONG-TEXT-'))
 }
 assert.equal(prepared,0);assert.equal(approvals,0)
 const corrected=await call('2026-10-28T15:11:38.000Z','保留必要事实的正文')
 assert.equal(corrected.isError,false,JSON.stringify(corrected));assert.equal(prepared,1);assert.equal(approvals,0)
})
