import test from 'node:test'
import assert from 'node:assert/strict'
import {createSecurityActionApi,securityActionCommands,readSecurityActionAttention} from '../src/client/security-action-api.ts'
import {action,panel,execution,approval,command,taskId,actionId,owner,requestId,source} from './security-action-fixtures.ts'
const context={panel,taskVersion:1,source},proposalContext={...context,panel:{...panel,actions:[],approvals:[]}}
function storage(){const data=new Map<string,string>();return {data,journals:Object.fromEntries(securityActionCommands.map(k=>[k,{read:()=>data.get(k)??null,write:(v:string)=>{data.set(k,v)},clear:()=>{data.delete(k)}}]))}}
test('目录严格核对本人、任务和重复 Attention；UUID v8 规范化',async()=>{
 assert.equal((await createSecurityActionApi(async()=>panel,{},owner).list(taskId)).taskId,taskId)
 for(const bad of [{...panel,taskId:actionId},{...panel,actions:[{...action,ownerId:'other'}]},{...panel,approvals:[{...approval,approverId:'other'}]}])await assert.rejects(createSecurityActionApi(async()=>bad,{},owner).list(taskId),{code:'teloa/invalid-host-response'})
 for(const reason of ['approval-required','execution-required','execution-dispatching','external-accepted','effect-unknown','execution-failed','adapter-unavailable'])assert.equal(readSecurityActionAttention([{taskId,actionId,kind:'security-action',reason}]).length,1)
 const row={taskId,actionId,kind:'security-action',reason:'execution-required'}
 for(const bad of [[row,row],[{...row,extra:true}],[{...row,reason:'ready'}],[{...row,taskId:'bad'}]])assert.throws(()=>readSecurityActionAttention(bad))
})
test('execute 取消后重建 API 用同 requestId 恢复',async()=>{
 const s=storage(),calls:unknown[]=[]
 const first=createSecurityActionApi(async(_,v)=>{calls.push(v);throw new DOMException('cancel','AbortError')},s.journals,owner)
 await assert.rejects(first.execute(command,context),{name:'AbortError'})
 assert.equal(first.pending('execute')!.request.requestId,requestId)
 const second=createSecurityActionApi(async(_,v)=>{calls.push(v);return {...execution,revision:3}},s.journals,owner)
 assert.equal((await second.recover('execute')).revision,3);assert.deepEqual(calls[0],calls[1]);assert.equal(s.data.size,0)
})
test('只清理四类可信明确拒绝；无效 host 与不确定故障保留原请求',async()=>{
 for(const code of ['invalid-input','forbidden','version-conflict','conflict','dependency-unavailable','invalid-host-response','storage-corrupt']){
  const s=storage(),api=createSecurityActionApi(async()=>{throw Object.assign(Error(),{rejected:true,code:'teloa/'+code})},s.journals,owner)
  await assert.rejects(api.execute(command,context));assert.equal(!!api.pending('execute'),!['invalid-input','forbidden','version-conflict','conflict'].includes(code))
 }
 for(const bad of [{...execution,ownerId:'other'},{...execution,actionId:taskId},{...execution,approvalId:taskId},{...execution,approvalVersion:3},{...execution,dispatch:{...execution.dispatch,params:{reason:'changed'}}},{...execution,frozen:{...execution.frozen,sourceSnapshotDigest:'f'.repeat(64)}}]){
  const s=storage(),api=createSecurityActionApi(async()=>bad,s.journals,owner);await assert.rejects(api.execute(command,context),{code:'teloa/invalid-host-response'});assert.ok(api.pending('execute'))
 }
})
test('八个写 journal 独立，损坏或存储写失败阻止调用，pending 为副本',async()=>{
 assert.equal(new Set(securityActionCommands).size,8)
 const s=storage();s.data.set('execute','{broken');let calls=0
 const api=createSecurityActionApi(async()=>{calls++;return execution},s.journals,owner)
 await assert.rejects(api.execute(command,context),{code:'teloa/storage-corrupt'});assert.equal(calls,0)
 const failed=createSecurityActionApi(async()=>{calls++;return execution},{execute:{read:()=>null,write:()=>{throw Error()},clear:()=>{}}},owner)
 await assert.rejects(failed.execute(command,context));assert.equal(calls,0)
 const saved=failed.pending('execute')!;saved.request.requestId=taskId;assert.equal(failed.pending('execute')!.request.requestId,requestId)
})
test('提议只允许固定隔离工具、目标与精确 reason；decide 返回 Approval',async()=>{
 const proposed={...action,state:'proposed' as const,version:1,frozen:null},input={requestId,taskId,expectedTaskVersion:1,title:action.title,goal:action.goal,tool:action.tool,targetSet:action.targetSet,params:action.params}
 assert.equal((await createSecurityActionApi(async()=>proposed,{},owner).propose(input,proposalContext)).state,'proposed')
 for(const fields of [{params:{}},{params:{reason:' '}},{params:{reason:'a'.repeat(1001)}},{params:{reason:'x',extra:true}},{targetSet:['other']},{tool:'other'}])await assert.rejects(createSecurityActionApi(async()=>proposed,{},owner).propose({...input,...fields},proposalContext))
 const pending={...action,state:'pending_approval' as const,version:2},ctx={panel:{...panel,actions:[pending],approvals:[]},taskVersion:1,source}
 assert.equal((await createSecurityActionApi(async()=>approval,{},owner).decide({requestId,actionId,expectedActionVersion:2,decision:'approved',reason:approval.reason,impactConfirmed:true},ctx)).id,approval.id)
})
test('get 绑定任务与 action；迟到 list 不能倒退；观察复用原 operation',async()=>{
 await assert.rejects(createSecurityActionApi(async()=>({...action,id:taskId}),{},owner).get(taskId,actionId))
 let value=panel;const api=createSecurityActionApi(async()=>value,{},owner);await api.list(taskId);value={...panel,actions:[{...action,version:2}]};await assert.rejects(api.list(taskId))
 const ctx={panel:{...panel,actions:[{...action,state:'effect_unknown' as const,version:4}],executions:[execution]},taskVersion:1,source},s=storage()
 const observing=createSecurityActionApi(async()=>({...execution,operationId:taskId}),s.journals,owner)
 await assert.rejects(observing.observe({requestId,operationId:execution.operationId,expectedRevision:1},ctx));assert.ok(observing.pending('observe'))
})
const proposed={...action,state:'proposed' as const,version:1,frozen:null}
const pendingAction={...action,state:'pending_approval' as const,version:2}
const failedAction={...action,state:'failed' as const,version:5}
const failedExecution={...execution,state:'failed' as const,effectReceipt:{status:'failed' as const,receiptId:'receipt-failed',detail:'隔离失败',observedAt:action.updatedAt,targets:[{target:'endpoint-1',state:'failed' as const}]}}
const cases=[
 {kind:'propose',method:'propose',request:{requestId,taskId,expectedTaskVersion:1,title:action.title,goal:action.goal,tool:action.tool,targetSet:action.targetSet,params:action.params},context:proposalContext,result:proposed},
 {kind:'submit',method:'submit',request:{...command,expectedActionVersion:1},context:{panel:{...panel,actions:[proposed],approvals:[]},taskVersion:1,source},result:pendingAction},
 {kind:'decide',method:'decide',request:{...command,expectedActionVersion:2,decision:'approved',reason:approval.reason,impactConfirmed:true},context:{panel:{...panel,actions:[pendingAction],approvals:[]},taskVersion:1,source},result:approval},
 {kind:'withdraw-submission',method:'withdrawSubmission',request:{...command,expectedActionVersion:2},context:{panel:{...panel,actions:[pendingAction],approvals:[]},taskVersion:1,source},result:{...pendingAction,state:'withdrawn',version:3}},
 {kind:'withdraw-approval',method:'withdrawApproval',request:command,context,result:{...action,state:'withdrawn',version:4}},
 {kind:'execute',method:'execute',request:command,context,result:execution},
 {kind:'observe',method:'observe',request:{requestId,operationId:execution.operationId,expectedRevision:1},context:{panel:{...panel,actions:[{...action,state:'effect_unknown',version:4}],executions:[execution]},taskVersion:1,source},result:{...execution,revision:2}},
 {kind:'acknowledge-failure',method:'acknowledgeFailure',request:{...command,expectedActionVersion:5},context:{panel:{...panel,actions:[failedAction],executions:[failedExecution]},taskVersion:1,source},result:failedAction},
] as const
test('八类命令分别持久恢复原请求，成功严格清本类 journal',async()=>{
 for(const row of cases){
  const s=storage(),calls:unknown[]=[]
  const api=createSecurityActionApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);throw Error('断线')},s.journals,owner)
  const invoke=api[row.method] as (request:unknown,context:unknown)=>Promise<unknown>
  await assert.rejects(invoke(row.request,row.context))
  assert.equal(s.data.size,1);assert.ok(s.data.has(row.kind))
  const restored=createSecurityActionApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return row.result},s.journals,owner)
  const result=await restored.recover(row.kind)
  assert.deepEqual(result,row.result);assert.deepEqual(calls[0],calls[1]);assert.equal(s.data.size,0)
 }
})
test('八类命令的合法形状错身份响应全部保留 journal',async()=>{
 for(const row of cases){
  const s=storage(),result={...row.result,ownerId:'other'}
  const api=createSecurityActionApi(async()=>result,s.journals,owner),invoke=api[row.method] as (request:unknown,context:unknown)=>Promise<unknown>
  await assert.rejects(invoke(row.request,row.context),{code:'teloa/invalid-host-response'})
  assert.equal(api.pending(row.kind)?.request.requestId,requestId)
 }
})
test('发送前落盘，busy 拒绝重复发送，不同命令保持独立',async()=>{
 const s=storage();let finish!:(v:unknown)=>void,calls=0
 const api=createSecurityActionApi(async()=>{calls++;assert.ok(s.data.has('execute'));return new Promise(resolve=>{finish=resolve})},s.journals,owner)
 const sending=api.execute(command,context)
 await assert.rejects(api.execute(command,context),{code:'teloa/conflict'});assert.equal(calls,1)
 finish(execution);await sending
})
test('存储清理失败保留记录可重放；读取抛错只阻止本类',async()=>{
 let raw:string|null=null,broken=true,calls=0
 const journal={read:()=>raw,write:(s:string)=>{raw=s},clear:()=>{if(broken)throw Error();raw=null}}
 const api=createSecurityActionApi(async()=>{calls++;return execution},{execute:journal},owner)
 await assert.rejects(api.execute(command,context),{code:'teloa/storage-corrupt'});assert.ok(api.pending('execute'))
 broken=false;await api.recover('execute');assert.equal(calls,2);assert.equal(raw,null)
 const isolated=createSecurityActionApi(async()=>proposed,{execute:{read:()=>{throw Error()},write:()=>{},clear:()=>{}}},owner)
 assert.ok(isolated.recoveryError('execute'))
 assert.equal((await isolated.propose(cases[0].request,proposalContext)).id,actionId)
})
test('缓存里的 operation 不可被恢复回包换身份；同版本面板不能悄悄改状态',async()=>{
 const s=storage();let response:unknown=execution
 const api=createSecurityActionApi(async endpoint=>endpoint==='security-actions/list'?{...panel,actions:[{...action,state:'effect_unknown',version:4}],executions:[execution]}:response,s.journals,owner)
 response={...execution,operationId:taskId,dispatch:{...execution.dispatch,operationId:taskId}}
 await api.list(taskId)
 await assert.rejects(api.execute(command,context),{code:'teloa/invalid-host-response'})
 assert.ok(api.pending('execute'))
 let p=panel;const listing=createSecurityActionApi(async()=>p,{},owner);await listing.list(taskId);p={...panel,actions:[{...action,state:'withdrawn'}]}
 await assert.rejects(listing.list(taskId),{code:'teloa/invalid-host-response'})
})

test('首次提交审批冻结摘要必须对应可信调查来源；来源错误不发送',async()=>{
 const submission=cases[1],s=storage(),submitContext={panel:{...panel,actions:[proposed],approvals:[]},taskVersion:1,source}
 const api=createSecurityActionApi(async()=>({...pendingAction,frozen:{...pendingAction.frozen!,objectSnapshotHash:'f'.repeat(64)}}),s.journals,owner)
 await assert.rejects(api.submit(submission.request,submitContext),{code:'teloa/invalid-host-response'});assert.ok(api.pending('submit'))
 let calls=0
 const wrong=createSecurityActionApi(async()=>{calls++;return pendingAction},{},owner)
 await assert.rejects(wrong.submit(submission.request,{...submitContext,source:{...source,taskId:actionId}}))
 assert.equal(calls,0)
})

test('提议回包不能复用面板已有 actionId；命令时间不得倒退',async()=>{
 const s=storage(),api=createSecurityActionApi(async()=>proposed,s.journals,owner)
 await assert.rejects(api.propose(cases[0].request,context),{code:'teloa/invalid-host-response'});assert.ok(api.pending('propose'))
 const recent={...action,updatedAt:'2026-09-14T01:00:00.000Z'},withdraw=createSecurityActionApi(async()=>({...action,state:'withdrawn',version:4}),{},owner)
 await assert.rejects(withdraw.withdrawApproval(command,{...context,panel:{...panel,actions:[recent]}}),{code:'teloa/invalid-host-response'})
})
test('list 保留既有审批、冻结定义与执行回执，版本推进不能掩盖历史改写',async()=>{
 const accepted={...execution,state:'accepted' as const,revision:2,acceptanceReceipt:{status:'accepted' as const,receiptId:'accepted-1',detail:'已受理',observedAt:action.createdAt,targets:[{target:'endpoint-1',state:'unknown' as const}]}}
 const acceptedPanel={...panel,actions:[{...action,state:'executing' as const,version:4}],executions:[accepted]}
 for(const mutation of [
  {...acceptedPanel,approvals:[{...approval,reason:'替换理由'}]},
  {...acceptedPanel,executions:[{...accepted,revision:3,acceptanceReceipt:{...accepted.acceptanceReceipt,detail:'替换受理事实'}}]},
  {...acceptedPanel,actions:[{...acceptedPanel.actions[0]!,version:5,title:'替换固定动作标题'}]},
  {...acceptedPanel,actions:[{...acceptedPanel.actions[0]!,version:5,frozen:{...action.frozen!,targetFingerprint:'sha256:'+'f'.repeat(64)}}],approvals:[{...approval,frozen:{...approval.frozen,targetFingerprint:'sha256:'+'f'.repeat(64)}}],executions:[{...accepted,revision:3,frozen:{...accepted.frozen,targetFingerprint:'sha256:'+'f'.repeat(64)}}]},
 ]){
  let next=acceptedPanel;const api=createSecurityActionApi(async()=>next);await api.list(taskId);next=mutation;await assert.rejects(api.list(taskId),{code:'teloa/invalid-host-response'})
 }
 let next=panel;const api=createSecurityActionApi(async()=>next);await api.list(taskId);next={...panel,approvals:[]};await assert.rejects(api.list(taskId),{code:'teloa/invalid-host-response'})
})
test('observe 拒绝改写原受理回执，但较新缓存不误拒合法旧幂等回包',async()=>{
 const acceptanceReceipt={status:'accepted' as const,receiptId:'accepted-1',detail:'已受理',observedAt:action.createdAt,targets:[{target:'endpoint-1',state:'unknown' as const}]}
 const accepted={...execution,state:'accepted' as const,revision:2,acceptanceReceipt},ctx={panel:{...panel,actions:[{...action,state:'executing' as const,version:4}],executions:[accepted]},taskVersion:1,source}
 const request={requestId,operationId:execution.operationId,expectedRevision:2},s=storage()
 let response={...accepted,state:'effect_unknown' as const,revision:3,acceptanceReceipt:{...acceptanceReceipt,receiptId:'REPLACED'}}
 const malformed=createSecurityActionApi(async()=>response,s.journals)
 await assert.rejects(malformed.observe(request,ctx),{code:'teloa/invalid-host-response'});assert.ok(malformed.pending('observe'))
 response={...response,acceptanceReceipt};await malformed.recover('observe');assert.equal(malformed.pending('observe'),undefined)
 const succeeded={...accepted,state:'succeeded' as const,revision:4,effectReceipt:{status:'succeeded' as const,receiptId:'effect-1',detail:'效果确认',observedAt:action.createdAt,targets:[{target:'endpoint-1',state:'succeeded' as const}]}}
 let latest={...panel,actions:[{...action,state:'succeeded' as const,version:6}],executions:[succeeded]}
 const api=createSecurityActionApi(async endpoint=>endpoint==='security-actions/list'?latest:response)
 await api.list(taskId)
 assert.equal((await api.observe(request,ctx)).revision,3)
 assert.equal((await api.list(taskId)).executions[0]!.revision,4)
 latest={...latest,executions:[{...succeeded,revision:5,effectReceipt:{...succeeded.effectReceipt,detail:'重写已确认的效果'}}]}
 await assert.rejects(api.list(taskId),{code:'teloa/invalid-host-response'})
})
