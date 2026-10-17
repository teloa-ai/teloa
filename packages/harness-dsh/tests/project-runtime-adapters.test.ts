import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError} from '@teloa/contract'
import {createProjectRuntimeAdapters} from '../src/project-runtime-adapters.ts'
import type {DigitalRole} from '@teloa/contract'

function fixture(){
 const session=Session.create(SessionId('ordinary'))
 const binding={id:'conversation',ownerId:'owner',sessionId:'ordinary',title:'本人工作',status:'ready',scopeIds:['general'],version:1}
 const state={scope:'sales',pending:false,projection:{pending:null as {provider:string;model:string;reasoningEffort?:string}|null,lastUsed:null},resolved:[] as unknown[],activation:0}
 const ctx={agents:{get:()=>undefined},sessionController:{inspect:async(id:string)=>{assert.equal(id,session.id);return {meta:session.header,events:session.snapshotEvents(),inheritedEventCount:0}},resolveAgent:()=>{state.activation++;throw Error('must not activate')}},sessionProjections:{stateOf:(_session:Session,key:string)=>key==='inbox'?{'next-turn':state.pending?[{id:'queued'}]:[],'next-step':[]}:state.projection},llm:{resolveCallConfig:async(value:unknown)=>{state.resolved.push(value);return value}},workspaceRegistry:{archivedSessionIds:[]}}
 const pool={query:async(text:string)=>({rows:text.includes('teloa_conversation_work_contexts')?[{session_id:session.id,scope_id:state.scope,role_id:null,version:1,locked:false}]:[]})}
 const ports={owner:'owner',pool,conversations:{snapshotBySession:async()=>binding,repository:{read:async()=>[binding]}},links:{bySession:async()=>[]},runs:async()=>({}),resources:{readForIndexInTransaction:async()=>{throw Error('not configured')}}}
 const adapters=createProjectRuntimeAdapters(ctx as never,ports as never)
 return {session,state,adapters,pool}
}

test('普通冷会话采用真实交办范围和官方待办投影，不激活原Agent',async()=>{
 const f=fixture();f.state.pending=true
 f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'原消息'}]}),{surfaceOp:'append'})
 const actor=await f.adapters.inspect('owner','ordinary')
 assert.equal(actor.scope,'sales');assert.equal(actor.kind,'ordinary');assert.equal(actor.submitted,true);assert.equal(actor.pending,true);assert.equal(actor.running,false);assert.equal(f.state.activation,0)
 await assert.rejects(f.adapters.inspect('other','ordinary'),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
})

test('没有真实已配置模型时等待，不偷偷改用宿主默认模型',async()=>{
 const f=fixture()
 await assert.rejects(f.adapters.model('ordinary',new AbortController().signal),error=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable')
 assert.deepEqual(f.state.resolved,[])
})
test('辅助模型沿原会话实际选择并保留采样控制，不写入新turn或request',async()=>{
 const f=fixture()
 f.session.append('request/header',{header:{config:{provider:'old-provider',model:'old-model',temperature:0.25,maxTokens:4096}},reason:'initial'})
 f.state.projection.pending={provider:'chosen-provider',model:'chosen-model',reasoningEffort:'low'}
 const before=f.session.snapshotEvents()
 const config=await f.adapters.model('ordinary',new AbortController().signal)
 assert.equal(config.provider,'chosen-provider');assert.equal(config.model,'chosen-model');assert.equal(config.temperature,0.25);assert.equal(config.maxTokens,4096);assert.equal(config.reasoningEffort,'low')
 assert.deepEqual(f.session.snapshotEvents(),before);assert.equal(f.state.activation,0)
})

test('资料只沿知识发布账本换版，主动撤回不得复活',async()=>{
 const f=fixture(),calls:string[]=[]
 const db={query:async(_sql:string,values:string[])=>({rows:values[1]==='old'?[{resource_id:'new'}]:[]})}
 const resources={readForIndexInTransaction:async(_db:unknown,_actor:unknown,id:string)=>{calls.push(id);if(id!=='new')throw new WorkError('teloa/resource-withdrawn','已撤回');return {resource:{id,version:2,title:'现版本',scopeIds:['sales'],sourceId:'knowledge_source'},text:'新版正文'}}}
 const adapters=createProjectRuntimeAdapters({} as never,{owner:'owner',resources} as never)
 const current=await adapters.resource(db as never,'owner','old',['sales'])
 assert.equal(current.id,'new');assert.equal(current.markdown,'新版正文');assert.equal(current.version,2);assert.deepEqual(calls,['old','new'])
 await assert.rejects(adapters.resource(db as never,'owner','withdrawn',['sales']),error=>error instanceof WorkError&&error.code==='teloa/resource-withdrawn')
})

function ownerFixture(){
 const session=Session.create(SessionId('owner-run')),parent=Session.create(SessionId('accepted-parent')),message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'原受理消息'}]}),requestId='11111111-1111-4111-8111-111111111111'
 parent.append('user/message',message,{surfaceOp:'append'})
 const state={parent:'accepted-parent',grantId:requestId,missing:false,activation:0},reads:string[]=[]
 const ctx={agents:{get:(id:string)=>{assert.equal(id,session.id);return undefined}},sessionController:{inspect:async(id:string)=>{reads.push(id);assert.equal(id,session.id,'不读live parent或当前UI会话');return {meta:session.header,events:session.snapshotEvents(),inheritedEventCount:0}},resolveAgent:()=>{state.activation++;throw Error('不得激活')}},sessionProjections:{stateOf:()=>({'next-turn':[],'next-step':[]})}}
 const pool={query:async(sql:string,values:string[])=>{
  assert.equal(values[0],'owner')
  if(sql.includes('teloa_task_runs'))return {rows:[{id:'run-one'}]}
  assert.match(sql,/teloa_conversation_work_requests/);assert.equal(values[1],requestId)
  const spec={requestId,sessionId:state.parent,messageId:message.id,messageSeq:0,kind:'task',executor:'general',scope:'general',title:'原工作',goal:'保留原工作目标'}
  return {rows:state.missing?[]:[{request_id:requestId,session_id:state.parent,request_spec:spec,targets:[],failures:{},stopped_at:null,created_at:new Date('2026-10-17T00:00:00.000Z')}]}
 }}
 const adapters=createProjectRuntimeAdapters(ctx as never,{owner:'owner',pool,conversations:{snapshotBySession:async()=>({id:'conversation-run',ownerId:'owner',sessionId:session.id,title:'原Run',purpose:'task-run'}),repository:{read:async()=>{throw Error('不按当前目录选择父会话')}}},runs:async()=>({get:async()=>({id:'run-one',sessionId:session.id,roleId:null,executor:{kind:'owner',grantId:state.grantId,grantVersion:1},inputText:JSON.stringify({task:{scope:'general',goal:'固定Run目标'}})}),conversationParent:async()=>({executor:'general',sessionId:parent.id,requestId})})} as never)
 return {adapters,session,parent,message,state,reads}
}

test('owner派生背景只绑定已受理原消息，不读取live parent、最新UI或激活Agent',async()=>{
 const f=ownerFixture();f.parent.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'父会话最新但未授权给原Run的内容'}]}),{surfaceOp:'append'})
 const actor=await f.adapters.inspect('owner',f.session.id)
 assert.equal(actor.kind,'task');assert.equal(actor.parentSessionId,f.parent.id);assert.equal(actor.parentMessageId,f.message.id);assert.equal(actor.goal,'固定Run目标');assert.deepEqual(actor.scopes,['general']);assert.equal(actor.roleId,undefined);assert.deepEqual(f.reads,[f.session.id]);assert.equal(f.state.activation,0)
})

test('owner原父请求缺失或被错接、grant不匹配和跨本人均拒绝，不回退最新会话',async()=>{
 for(const change of ['missing','parent','grant'] as const){const f=ownerFixture();if(change==='missing')f.state.missing=true;if(change==='parent')f.state.parent='different-parent';if(change==='grant')f.state.grantId='22222222-2222-4222-8222-222222222222';await assert.rejects(f.adapters.inspect('owner',f.session.id),{code:'teloa/forbidden'})}
 const f=ownerFixture();await assert.rejects(f.adapters.inspect('other',f.session.id),{code:'teloa/forbidden'});assert.deepEqual(f.reads,[])
})

test('本人计划背景沿固定计划授权，人工认可不伪造父会话，撤回与错配拒绝',async()=>{
 const planId='33333333-3333-4333-8333-333333333333',session=Session.create(SessionId('owner-plan-run'))
 const state={source:undefined as undefined|{sessionId:string;messageId:string},revoked:false,configVersion:2},transactions:string[]=[]
 const db={query:async(sql:string)=>{transactions.push(sql);return {rows:[]}},release:()=>{transactions.push('release')}}
 const ctx={agents:{get:()=>undefined},sessionController:{inspect:async()=>({meta:session.header,events:session.snapshotEvents(),inheritedEventCount:0})},sessionProjections:{stateOf:()=>({'next-turn':[],'next-step':[]})}}
 const executor={kind:'owner',grantId:planId,grantVersion:2}
 const run={id:'run-plan',sessionId:session.id,roleId:null,executor,lineage:{definition:{planId,definitionVersion:2}},inputText:JSON.stringify({task:{scope:'general',goal:'计划原冻结目标'}})}
 const ports={
  owner:'owner',pool:{query:async()=>({rows:[{id:run.id}]}),connect:async()=>db},
  conversations:{snapshotBySession:async()=>({id:'conversation',ownerId:'owner',sessionId:session.id,title:'计划工作',purpose:'task-run'})},
  runs:async()=>({get:async()=>run,conversationParent:async()=>{throw Error('计划不得猜普通会话父请求')}}),
  ownerExecution:{current:async(_db:unknown,actor:string,value:unknown)=>{
   assert.equal(actor,'owner');assert.deepEqual(value,executor)
   if(state.revoked)throw new WorkError('teloa/forbidden','已撤回')
   return {executor,scope:'general',plan:{planId,configVersion:state.configVersion},...(state.source?{source:state.source}:{}),admission:{assertCurrent:()=>{}}}
  }},
 }
 const adapters=createProjectRuntimeAdapters(ctx as never,ports as never)
 const manual=await adapters.inspect('owner',session.id)
 assert.equal(manual.kind,'task');assert.equal(manual.goal,'计划原冻结目标');assert.equal(manual.parentSessionId,undefined)
 assert.deepEqual(transactions,['begin','commit','release'])
 state.source={sessionId:'fixed-source',messageId:'fixed-message'}
 const accepted=await adapters.inspect('owner',session.id)
 assert.equal(accepted.parentSessionId,'fixed-source');assert.equal(accepted.parentMessageId,'fixed-message')
 state.configVersion=3;await assert.rejects(adapters.inspect('owner',session.id),{code:'teloa/forbidden'})
 state.configVersion=2;state.revoked=true;await assert.rejects(adapters.inspect('owner',session.id),{code:'teloa/forbidden'})
 assert.deepEqual(transactions.slice(-3),['begin','rollback','release'])
})

test('项目optionalMemories仅普通分身私聊复用原private读取选择，Task/群和员工不冒私有口',async()=>{
 const role={id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',kind:'twin',version:1,state:'active',scopes:['general'],createdAt:'2026-10-17T00:00:00.000Z',updatedAt:'2026-10-17T00:00:00.000Z',name:'本人分身',duty:'核对',dataScope:'本人私有',executionScope:'只读',skills:[],knowledge:[]} as DigitalRole
 const memory={id:'memory-one',title:'本人习惯',version:1,contentHash:'a'.repeat(64),markdown:'私有确认正文',visibility:{kind:'private',scopeIds:[]}},calls:unknown[]=[]
 const adapters=createProjectRuntimeAdapters({} as never,{owner:'owner',pool:{},roleMemories:async()=>({confirmedForRun:async(...args:unknown[])=>{calls.push(args);return [memory]}})} as never)
 const db={query:async()=>({rows:[{id:role.id,owner_id:role.ownerId,definition:{name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:[],knowledge:[]},version:role.version,state:role.state,created_at:new Date(role.createdAt),updated_at:new Date(role.updatedAt)}]})}
 const target={sessionId:'twin-chat',kind:'employee' as const,scope:'general',roleId:role.id,title:'分身私聊',submitted:true,running:false}
 const result=await adapters.optionalMemories(db as never,'owner',target,'',false)
 assert.equal(result[0]?.markdown,memory.markdown);assert.deepEqual((calls[0] as unknown[])[2],{scope:'general',groupId:null,memoryViewId:null})
 calls.length=0
 for(const kind of ['task','subagent','ordinary'] as const)assert.deepEqual(await adapters.optionalMemories(db as never,'owner',{...target,kind},'',false),[])
 assert.equal(calls.length,0)
 await assert.rejects(adapters.optionalMemories(db as never,'other',target,'',false),{code:'teloa/forbidden'})
})

test('真实私聊adapter回读本人role/link和固定private选择，迟撤回的lease失效不复活',async()=>{
 const session=Session.create(SessionId('twin-private-chat')),roleId='11111111-1111-4111-8111-111111111111',reads:unknown[]=[]
 const row={id:roleId,owner_id:'owner',definition:{name:'本人分身',kind:'twin',scopes:['general'],duty:'核对',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[]},version:1,state:'active',created_at:new Date('2026-10-17T00:00:00.000Z'),updated_at:new Date('2026-10-17T00:00:00.000Z')}
 const memory={id:'memory-one',title:'偏好',version:1,contentHash:'a'.repeat(64),markdown:'本人私有习惯',visibility:{kind:'private',scopeIds:[]}}
 const state={memories:[memory],linked:true,version:1,afterRead:undefined as (()=>Promise<void>)|undefined}
 const pool={query:async(sql:string,values:string[])=>{assert.equal(values[0],'owner');if(sql.includes('teloa_task_runs'))return {rows:[]};assert.match(sql,/teloa_roles/);assert.equal(values[1],roleId);return {rows:[{...row,version:state.version}]}}}
 const ctx={agents:{get:()=>undefined},sessionController:{inspect:async(id:string)=>{assert.equal(id,session.id);return {meta:session.header,events:session.snapshotEvents(),inheritedEventCount:0}}},sessionProjections:{stateOf:()=>({'next-turn':[],'next-step':[]})}}
 const adapters=createProjectRuntimeAdapters(ctx as never,{owner:'owner',pool,conversations:{snapshotBySession:async()=>({id:'conversation',ownerId:'owner',sessionId:session.id,title:'分身私聊'}),repository:{read:async()=>[{sessionId:session.id,requestedRoleId:roleId}]}},links:{bySession:async()=>state.linked?[{kind:'role',active:true,objectId:roleId,conversationId:'conversation',sessionId:session.id,scopeId:'general'}]:[]},roleMemories:async()=>({confirmedForRun:async(...args:unknown[])=>{reads.push(args);await state.afterRead?.();return state.memories}})} as never)
 const role={...row.definition,id:roleId,ownerId:'owner',version:1,state:'active',createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()} as DigitalRole
 const input={sessionId:session.id,role,scopeId:'general'},lease=await adapters.privateMemory(input)
 assert.match(lease.text,/本人私有习惯/);assert.deepEqual((reads[0] as unknown[]).slice(1,3),['owner',{scope:'general',groupId:null,memoryViewId:null}]);await lease.assertCurrent()
 state.memories=[];await assert.rejects(lease.assertCurrent(),{code:'teloa/version-conflict'});assert.equal((await adapters.privateMemory(input)).text,'')
 state.version=2;await assert.rejects(adapters.privateMemory(input),{code:'teloa/forbidden'});state.version=1
 state.linked=false;await assert.rejects(adapters.privateMemory(input),{code:'teloa/forbidden'})
 await assert.rejects(adapters.privateMemory({...input,role:{...role,ownerId:'other'}}),{code:'teloa/forbidden'})
 await assert.rejects(adapters.privateMemory({...input,role:{...role,kind:'employee'}}),{code:'teloa/forbidden'})
 for(const phase of ['load','lease'] as const)for(const change of ['role','link'] as const){
  state.version=1;state.linked=true;state.memories=[memory]
  const current=phase==='lease'?await adapters.privateMemory(input):undefined
  state.afterRead=async()=>{await Promise.resolve();if(change==='role')state.version=2;else state.linked=false}
  await assert.rejects(current?current.assertCurrent():adapters.privateMemory(input),{code:'teloa/forbidden'},phase+':'+change)
  state.afterRead=undefined
 }
})
