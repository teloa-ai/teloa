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
import {WorkError,readBusinessResponsibilitySet,type BusinessResponsibility,type BusinessResponsibilitySet,type DigitalRole} from '@teloa/contract'
import type {BusinessResponsibilityToolsPorts} from '../src/business-responsibility-tools.ts'
const module=await import('../src/business-responsibility-tools.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-responsibility-tools.ts');throw error})
const read='teloa_business_responsibility_read',set='teloa_business_responsibility_set',stamp='2026-09-29T00:00:00.000Z'
const body=(result:{content:readonly {type:string;text?:string}[]})=>JSON.parse(result.content.map(block=>block.type==='text'?block.text:'').join(''))
async function fixture(overrides:Partial<BusinessResponsibilityToolsPorts>={},origin?:'subagent'){
 assert.equal(typeof module.registerBusinessResponsibilityTools,'function')
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('responsibility-'+randomUUID()),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:{id:'never-read'}} as never,{type:'file',attachment:{id:'never-read'}} as never,{type:'text',text:'选择这位业务负责人'}]}),{surfaceOp:'append'})};turn()
 const role:DigitalRole={id:randomUUID(),ownerId:'self',version:1,state:'active',createdAt:stamp,updatedAt:stamp,name:'销售同事',kind:'employee',scopes:['sales'],duty:'不要泄露岗位全文',dataScope:'授权资料',executionScope:'批准动作',skills:[],knowledge:[]}
 let current:BusinessResponsibility={scope:'sales',version:0,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null}
 const saved=new Map<string,{input:BusinessResponsibilitySet;result:BusinessResponsibility}>(),writes:BusinessResponsibilitySet[]=[]
 const actor=(value:unknown)=>assert.deepEqual(value,{ownerId:'self',scopeIds:['sales']})
 const ports:BusinessResponsibilityToolsPorts={owner:'self',conversation:async sessionId=>({ownerId:'self',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:true}),scopes:async()=>[{scope:'sales',title:'销售业务'}],roles:async owner=>{assert.equal(owner,'self');return [role]},responsibility:{read:async(a)=>{actor(a);return structuredClone(current)},receipt:async(a,raw)=>{actor(a);const input=readBusinessResponsibilitySet(raw),previous=saved.get(input.requestId);if(!previous)return null;if(JSON.stringify(previous.input)!==JSON.stringify(input))throw new WorkError('teloa/conflict','原请求不同');return structuredClone(previous.result)},set:async(a,raw)=>{actor(a);const input=readBusinessResponsibilitySet(raw);writes.push(input);if(current.version!==input.expectedVersion)throw new WorkError('teloa/version-conflict','版本变化');current={scope:'sales',version:current.version+1,roleId:input.role?.id??null,selectedRoleVersion:input.role?.expectedVersion??null,availability:input.role?'ready':'none',currentRoleVersion:input.role?.expectedVersion??null};saved.set(input.requestId,{input,result:structuredClone(current)});return structuredClone(current)}},...overrides}
 module.registerBusinessResponsibilityTools(ctx,ports)
 let approve:()=>Promise<string>=async()=> 'allowed-once';const approvals:string[]=[]
 ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const call=(name:string,args:Record<string,unknown>={},signal:AbortSignal=AbortSignal.timeout(3000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal})
 return {ctx,agent,role,ports,saved,writes,approvals,call,turn,choose:()=>({expectedVersion:0,role:{id:role.id,expectedVersion:1}}),change:(value:BusinessResponsibility)=>current=value,approve:(value:typeof approve)=>approve=value}
}
test('真实原生read只读并最小投影；拒绝零写、本人附件指令一次批准固定请求及原回执早返',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const directory=await f.call(read);assert.equal(directory.isError,false,JSON.stringify(directory));assert.equal(body(directory).responsibility.version,0);assert.equal(body(directory).roles[0].name,'销售同事');assert.equal(JSON.stringify(body(directory)).includes('不要泄露'),false);assert.equal(f.approvals.length,0)
 f.approve(async()=> 'rejected');assert.equal((await f.call(set,f.choose())).isError,true);assert.equal(f.writes.length,0)
 f.approve(async()=> 'allowed-once');const result=await f.call(set,f.choose());assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.writes.length,1);assert.equal(body(result).result.roleId,f.role.id);assert.equal(body(result).requestId,f.writes[0]!.requestId)
 assert.match(f.approvals.at(-1)!,/销售业务/);assert.match(f.approvals.at(-1)!,/销售同事/);assert.match(f.approvals.at(-1)!,/不.*派任务/)
 const original=f.choose();f.role.version=2;f.role.state='paused';f.change({scope:'sales',version:2,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null})
 assert.deepEqual(body(await f.call(set,original)),body(result));assert.equal(f.writes.length,1,'已提交原请求不能再写')
 assert.equal((await f.call(set,{...original,role:null})).isError,true);assert.equal(f.writes.length,1)
})
test('清空也确认且新本人轮派生新请求；receipt只接受完整原请求，未知固定身份可核对',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const persist=f.ports.responsibility.set
 f.ports.responsibility.set=async(...args)=>{await persist(...args);throw Error('lost response')}
 const lost=await f.call(set,f.choose());assert.equal(lost.isError,true);const original=f.writes[0]!
 assert.match(JSON.stringify(lost),new RegExp(original.requestId));f.turn()
 const {scope:_,...request}=original
 const receipt=await f.call(read,{mode:'receipt',request});assert.equal(receipt.isError,false);assert.equal(body(receipt).result.roleId,f.role.id);assert.equal(f.writes.length,1)
 for(const args of [{mode:'receipt',request:{requestId:original.requestId}},{mode:'receipt',request:{...request,scope:'other'}},{mode:'receipt',request,cursor:1}])assert.equal((await f.call(read,args)).isError,true)
 f.ports.responsibility.set=persist
 assert.equal((await f.call(set,{expectedVersion:1,role:null})).isError,false);assert.equal(f.writes.length,2);assert.notEqual(f.writes[1]!.requestId,original.requestId);assert.match(f.approvals.at(-1)!,/清空/)
})
test('审批间本人、指令、scope、预约、负责人和岗位变更全部阻断，取消不调用set',async t=>{
 for(const change of ['turn','replace','owner','scope','binding','access','responsibility','role-version','role-state','role-scope']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>{
   if(change==='turn')f.turn()
   if(change==='replace')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
   if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'foreign',sessionId,status:'ready'})
   if(change==='scope')f.ports.context=async sessionId=>({sessionId,scopeId:'other',roleId:null,version:2,locked:true})
   if(change==='binding')f.ports.binding=async()=>({requestId:randomUUID(),kind:'daily',scope:'sales',title:'pending',createdAt:stamp,updatedAt:stamp})
   if(change==='access')f.ports.scopes=async()=>[]
   if(change==='responsibility')f.change({scope:'sales',version:1,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null})
   if(change==='role-version')f.role.version++
   if(change==='role-state')f.role.state='paused'
   if(change==='role-scope')f.role.scopes=['general']
   return 'allowed-once'
  });assert.equal((await f.call(set,f.choose())).isError,true,change);assert.equal(f.writes.length,0,change)
 }
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const abort=new AbortController();f.approve(async()=>{abort.abort();return 'allowed-once'});assert.equal((await f.call(set,f.choose(),abort.signal)).isError,true);assert.equal(f.writes.length,0)
})
test('真实role/task身份拒绝；接手偏好不冒充role，bound daily与ordinary均可操作',async t=>{
 const binding={requestId:randomUUID(),kind:'builder' as const,title:'搭建',createdAt:stamp,updatedAt:stamp}
 for(const overrides of [{binding:async()=>binding},{binding:async()=>({...binding,kind:'daily' as const,scope:'sales'})},{isRoleConversation:async()=>true},{isTaskConversation:async()=>true},{readTaskPolicy:async()=>({allowedTools:[]})},{context:async()=>null}] satisfies Partial<BusinessResponsibilityToolsPorts>[]){const f=await fixture(overrides);t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(read)).isError,true);assert.equal((await f.call(set,f.choose())).isError,true);assert.equal(f.approvals.length,0)}
 const child=await fixture({},'subagent');t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call(read)).isError,true)
 const f=await fixture({context:async sessionId=>({sessionId,scopeId:'sales',roleId:randomUUID(),version:2,locked:true})});t.after(()=>f.ctx.fiber.dispose())
 const preference=randomUUID();f.ports.context=async sessionId=>({sessionId,scopeId:'sales',roleId:preference,version:2,locked:true});f.ports.binding=async sessionId=>({...binding,kind:'daily',scope:'sales',sessionId})
 assert.equal((await f.call(set,f.choose())).isError,false);assert.equal(f.writes.length,1)
})
test('原生deny/cancel/ask链保持，完整确认含下游理由超过128KiB明确拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 for(const kind of ['deny','cancel'] as const){const off=f.ctx.on('tools/pre-execute',async()=>({kind,reason:'原策略'}));await f.call(set,f.choose());assert.equal(f.approvals.length,0);assert.equal(f.writes.length,0);off()}
 const off=f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'原生附加理由'}));assert.equal((await f.call(set,f.choose())).isError,false);assert.match(f.approvals[0]!,/原生附加理由/);off()
 f.turn();f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'长'.repeat(44000)}));assert.equal((await f.call(set,{expectedVersion:1,role:null})).isError,true);assert.equal(f.approvals.length,1);assert.equal(f.writes.length,1)
})
test('目录32条与大小上限、错误回包拒绝；模型不可提供set请求身份或scope',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.ports.roles=async()=>Array.from({length:40},()=>({...f.role,id:randomUUID()}));const directory=body(await f.call(read));assert.equal(directory.roles.length,32);assert.equal(directory.nextCursor,32)
 for(const input of [{...f.choose(),requestId:randomUUID()},{...f.choose(),scope:'other'},{...f.choose(),ownerId:'other'}])assert.equal((await f.call(set,input)).isError,true)
 f.ports.roles=async()=>[f.role];f.ports.responsibility.receipt=async()=>({scope:'other',version:1,roleId:f.role.id,selectedRoleVersion:1,availability:'ready',currentRoleVersion:1});assert.equal((await f.call(set,f.choose())).isError,true);assert.equal(f.writes.length,0)
 f.ports.responsibility.receipt=async()=>null;f.ports.responsibility.set=async()=>({scope:'sales',version:99,roleId:f.role.id,selectedRoleVersion:1,availability:'ready',currentRoleVersion:1});assert.equal((await f.call(set,f.choose())).isError,true)
})

test('原生服务返回host-unavailable也保留完整原请求，核对不新增选择',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const persist=f.ports.responsibility.set
 f.ports.responsibility.set=async(...args)=>{await persist(...args);throw new WorkError('teloa/host-unavailable','服务回包丢失')}
 const failed=await f.call(set,f.choose());assert.equal(failed.isError,true);assert.match(JSON.stringify(failed),new RegExp(f.writes[0]!.requestId))
 assert.equal((await f.call(set,f.choose())).isError,false);assert.equal(f.writes.length,1)
})
test('真实目录异常/膨胀及注入消息不能进入确认；32目录只投影有界字段',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 f.role.name='长'.repeat(45000);assert.equal((await f.call(set,f.choose())).isError,true);assert.equal(f.approvals.length,0);assert.equal(f.writes.length,0)
 f.role.name='长'.repeat(90000);assert.equal((await f.call(read)).isError,true)
 f.role.name='同事';f.role.ownerId='foreign';assert.equal((await f.call(read)).isError,true)
 f.role.ownerId='self';f.ports.roles=async()=>[f.role,f.role];assert.equal((await f.call(read)).isError,true)
 f.ports.roles=async()=>[f.role]
 f.agent.session.append('turn/start',{turn:1} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'plugin:fake',form:'notice'} as never,content:[{type:'text',text:'修改负责人'}]}),{surfaceOp:'append'})
 assert.equal((await f.call(set,f.choose())).isError,true);assert.equal(f.writes.length,0)
 f.turn();f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:'append'});assert.equal((await f.call(set,f.choose())).isError,true)
})
