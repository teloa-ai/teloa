import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type WorkTask} from '@teloa/contract'
import {workRequestChildId,type ConversationWorkRequest,type TaskRun} from '@teloa/backend'
import {ConversationWorkDispatch,type ConversationWorkDispatchPorts} from '../src/conversation-work-dispatch.ts'
const roleId='22222222-2222-4222-8222-222222222222',requestId='11111111-1111-4111-8111-111111111111',taskId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444'
const request:ConversationWorkRequest={requestId,sessionId:'origin',messageId:'msg',messageSeq:1,kind:'task',scope:'SOC',title:'调查',goal:'调查真实事件',targets:[{roleId,roleVersion:1,name:'调查员',scope:'SOC',unavailable:null}],failures:{},stoppedAt:null,createdAt:'2026-09-25T00:00:00.000Z'}
function fixture(){
 let stored=structuredClone(request),task:WorkTask|null=null,run:TaskRun|null=null,sendFailure=false
 const calls:string[]=[]
 const ports:ConversationWorkDispatchPorts={owner:'owner',requests:{reserve:async()=>stored,get:async()=>stored,list:async()=>[stored],withDispatchLock:async(_owner,_request,op)=>op(new AbortController().signal),stop:async()=>stored={...stored,stoppedAt:'2026-09-25T01:00:00.000Z'},failure:async(_owner,_id,role,error)=>{if(error)stored.failures[role]=error;else delete stored.failures[role]},pendingNotifications:async()=>[stored],notified:async()=>{calls.push('notified')}},
  boundTasks:undefined as never,
  tasks:{request:async()=>task,create:async(_owner,input)=>{calls.push('create');const value=input as {fields:{title:string;goal:string;scope:string}};return task={...value.fields,groupId:null,skills:[],id:taskId,ownerId:'owner',version:1,state:'ready',assigneeRoleId:roleId,assigneeRoleVersion:1,createdAt:request.createdAt,updatedAt:request.createdAt}}},
  link:async()=>{calls.push('link')},runs:async()=>run?[run]:[],
  run:async(endpoint)=>{calls.push(endpoint);if(endpoint==='task-runs/prepare')return run={id:runId,taskId,roleId,taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'task-run-'+workRequestChildId(stored.requestId,'run',roleId),nativeRequestId:stored.requestId,state:'prepared',evidence:null,stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'private',createdAt:request.createdAt};if(endpoint==='task-runs/start'){run={...run!,state:'accepted'};if(sendFailure)throw new WorkError('teloa/execution-pending','需要核对');return run}if(endpoint==='task-runs/withdraw')return run={...run!,state:'withdrawn'};if(endpoint==='task-runs/stop')return run={...run!,stopRequestedAt:stored.stoppedAt};return run!},
  result:async()=> '真实最终回复',publish:async()=>{calls.push('publish')},now:()=>request.createdAt,
 }
 ports.boundTasks={request:async identity=>{assert.deepEqual(identity,{sessionId:stored.sessionId,requestId:stored.requestId,roleId:stored.targets[0]!.roleId});return task},create:async identity=>{assert.deepEqual(identity,{sessionId:stored.sessionId,requestId:stored.requestId,roleId:stored.targets[0]!.roleId});calls.push('create');return task={title:stored.title,goal:stored.goal,scope:stored.scope,groupId:null,skills:[],id:taskId,ownerId:'owner',version:1,state:'ready',assigneeRoleId:roleId,assigneeRoleVersion:1,createdAt:request.createdAt,updatedAt:request.createdAt}}}
 const dispatch=new ConversationWorkDispatch(ports)
 return {dispatch,calls,ports,get stored(){return stored},setRequest:(value:ConversationWorkRequest)=>{stored=value},setRun:(value:TaskRun)=>{run=value},get run(){return run},failSend:()=>{sendFailure=true}}
}
test('明确交办创建并关联真实 Task/Run；同请求重试先核对且不重发',async()=>{
 const f=fixture(),signal=new AbortController().signal
 const a=await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
 assert.equal(a.members[0]?.status,'waiting');assert.equal(a.members[0]?.task?.id,taskId)
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
 assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(f.calls.filter(x=>x==='task-runs/start').length,1)
 assert.ok(f.calls.includes('task-runs/reconcile'));assert.ok(!JSON.stringify(a).includes('private'))
})
test('父交办准备与启动仅向内部 Run 端口传固定父身份',async()=>{
 const f=fixture(),seen:unknown[]=[],original=f.ports.run
 f.ports.run=async(endpoint,payload,signal,identity)=>{if(endpoint==='task-runs/prepare'||endpoint==='task-runs/start')seen.push(identity);return original(endpoint,payload,signal,identity)}
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
 assert.deepEqual(seen,[{sessionId:'origin',requestId,roleId},{sessionId:'origin',requestId,roleId}])
})
test('同请求三种terminal恢复保留固定子Run，不另准备或切到同Task后续Run',async()=>{
 for(const state of ['ended','withdrawn','configuration_failed']){
  const f=fixture(),signal=new AbortController().signal
  await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
  const original={...f.run!,state,...(state==='ended'?{evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:5,reason:'completed' as const}}:{})}
  f.setRun(original)
  // 同一Task另起的运行即便更新，也不属于原交办的固定执行会话。
  const later={...original,id:'55555555-5555-4555-8555-555555555555',sessionId:'task-run-another-request',state:'ended',evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:5,reason:'completed' as const}}
  f.ports.runs=async()=>[later,original]
  let replay:unknown
  f.ports.requests.reserve=async(_owner,input)=>{replay=input;return f.stored}
  f.calls.length=0
  const result=await f.dispatch.resume('origin',requestId,signal)
  assert.equal((replay as {requestId:string}).requestId,requestId)
  assert.equal(result.members[0]?.run?.id,runId,state)
  assert.equal(result.members[0]?.run?.sessionId,'task-run-'+workRequestChildId(requestId,'run',roleId),state)
  assert.equal(result.members[0]?.task?.id,taskId,state)
  assert.equal(f.calls.filter(call=>call==='create'||call==='task-runs/prepare'||call==='task-runs/start'||call==='task-runs/reconcile').length,0,state)
 }
})
test('发送响应丢失保留真实运行，核对不重派；终态回复与失败返回原会话',async()=>{
 const f=fixture();f.failSend()
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
 assert.equal(f.calls.filter(x=>x==='task-runs/start').length,1)
 f.setRun({...f.run!,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:5,reason:'completed'}})
 const result=await f.dispatch.status('origin',requestId)
 assert.equal(result.members[0]?.result,'真实最终回复');assert.equal(result.counts.received,1)
 assert.equal(result.members[0]?.reason,undefined,'真实完成后不再把历史丢回包的待核对原因当当前失败')
 await f.dispatch.deliver();assert.ok(f.calls.includes('publish'));assert.ok(f.calls.includes('notified'))
})
test('多同事中途停止：已经派发的保留，后续不得准备；暂停成员不冒充已回复',async()=>{
 const f=fixture(),other='55555555-5555-4555-8555-555555555555'
 f.setRequest({...request,kind:'report',targets:[...request.targets,{roleId:other,roleVersion:1,name:'另一同事',scope:'SOC',unavailable:'paused'}]})
 await f.dispatch.stop('origin',requestId,new AbortController().signal)
 const result=await f.dispatch.dispatch({...request,kind:'report'},new AbortController().signal)
 assert.equal(f.calls.filter(x=>x==='create').length,0);assert.equal(f.calls.filter(x=>x==='task-runs/start').length,0)
 assert.equal(result.counts.received,0);assert.equal(result.counts.stopped,1);assert.equal(result.counts.unavailable,1)
})
test('准备前取消不创建任务，准备之后的停止撤回而不是重新启动',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort()
 await assert.rejects(f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},controller.signal))
 assert.equal(f.calls.length,0)
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
 f.setRun({...f.run!,state:'prepared'})
 await f.dispatch.stop('origin',requestId,new AbortController().signal)
 assert.ok(f.calls.includes('task-runs/withdraw'));assert.equal(f.calls.filter(x=>x==='task-runs/start').length,1)
})
test('大写交办身份停止仍撤回固定 Run 并返回规范化回执',async()=>{
 const f=fixture(),signal=new AbortController().signal,hexRequestId='a1111111-1111-4111-8111-111111111111'
 f.setRequest({...request,requestId:hexRequestId})
 await f.dispatch.dispatch({...request,requestId:hexRequestId,roleId,expectedRoleVersion:1},signal)
 f.setRun({...f.run!,state:'prepared'})
 const status=await f.dispatch.stop('origin',hexRequestId.toUpperCase(),signal)
 assert.equal(f.calls.filter(call=>call==='task-runs/withdraw').length,1)
 assert.equal(status.requestId,hexRequestId)
})
test('跨新轮次续办复用原请求与任务，资料引用在prepare前走固定任务资料口',async()=>{
 const f=fixture(),reference={id:'77777777-7777-4777-8777-777777777777',version:2}
 f.setRequest({...request,sourceText:`调查 [[teloa-resource:${reference.id}@2]]`})
 f.ports.materials=async(_request,task,refs)=>{f.calls.push('materials');assert.deepEqual(refs,[reference]);return {...task,version:2}}
 await f.dispatch.resume('origin',requestId,new AbortController().signal)
 assert.ok(f.calls.indexOf('materials')<f.calls.indexOf('task-runs/prepare'))
 await f.dispatch.resume('origin',requestId,new AbortController().signal)
 assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(f.calls.filter(x=>x==='task-runs/start').length,1)
})
test('首个发起会话失效不阻断后续结果；取消主调用持久化停止防止迟到新派发',async()=>{
 const f=fixture(),second={...request,requestId:'88888888-8888-4888-8888-888888888888',targets:request.targets.map(t=>({...t,unavailable:'paused' as const}))}
 f.ports.requests.pendingNotifications=async()=>[request,second]
 f.ports.requests.get=async(_owner,input)=>{if((input as {requestId:string}).requestId===requestId)throw new WorkError('teloa/session-unavailable','原会话不可用');return second}
 await f.dispatch.deliver();assert.ok(f.calls.includes('publish'))
 const aborted=fixture(),controller=new AbortController(),original=aborted.ports.link
 aborted.ports.link=async input=>{await original(input);controller.abort()}
 await assert.rejects(aborted.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},controller.signal))
 assert.ok(aborted.stored.stoppedAt);assert.equal(aborted.calls.filter(x=>x==='task-runs/prepare').length,0)
})

test('对象任务透传已确认通用标题，恢复仅透传原责任快照',async()=>{
 const f=fixture(),responsibility={version:4,roleId:null},reference={scope:'SOC',type:'customer',id:'a',version:1,snapshotHash:'a'.repeat(64)}
 f.setRequest({...request,title:'客户核对',responsibility,reference})
 let reserved:unknown,created:unknown
 f.ports.requests.reserve=async(_owner,input)=>{reserved=input;return f.stored}
 const original=f.ports.boundTasks.create;f.ports.boundTasks.create=async identity=>{created=identity;return original(identity)}
 await f.dispatch.resume('origin',requestId,new AbortController().signal)
 assert.deepEqual((reserved as {responsibility:unknown}).responsibility,responsibility)
 assert.deepEqual(created,{sessionId:'origin',requestId,roleId})
})
test('prepare等待后核验失败不start，原请求和已prepare运行保留',async()=>{
 const f=fixture()
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal,async()=>{if(f.run?.state==='prepared')throw new WorkError('teloa/forbidden','授权已撤回')})
 assert.equal(f.calls.filter(x=>x==='task-runs/start').length,0);assert.equal(f.run?.state,'prepared');assert.ok(f.stored.failures[roleId])
 const status=await f.dispatch.status('origin',requestId)
 assert.equal(status.members[0]?.status,'waiting','非岗位重验的授权失败仍需核对，不能代替确定的岗位终态')
 await f.dispatch.deliver();assert.equal(f.calls.includes('publish'),false)
})
test('prepare落盘后岗位暂停或变版：不start，原身份转需本人处理并回流，resume不重派',async()=>{
 const f=fixture(),signal=new AbortController().signal
 f.ports.revalidate=async()=>{if(f.run?.state==='prepared')throw new WorkError('teloa/version-conflict','原接手同事的状态、版本或业务授权已变化，请先核对原交办。')}
 const first=await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
 assert.equal(f.calls.filter(x=>x==='task-runs/start').length,0)
 assert.equal(f.run?.state,'prepared')
 assert.equal(first.members[0]?.status,'failed')
 assert.match(first.members[0]?.reason??'',/本人.*核对|本人.*重新安排/)
 assert.equal(first.requestId,requestId)
 assert.equal(first.members[0]?.task?.id,taskId)
 assert.equal(first.members[0]?.run?.id,runId)
 await f.dispatch.deliver()
 assert.deepEqual(f.calls.slice(-2),['publish','notified'])
 assert.equal((await f.dispatch.status('origin',requestId)).members[0]?.status,'failed')
 f.calls.length=0
 const resumed=await f.dispatch.resume('origin',requestId,signal)
 assert.equal(resumed.members[0]?.status,'failed')
 assert.equal(resumed.members[0]?.run?.id,runId)
 assert.equal(f.calls.some(call=>call==='create'||call==='task-runs/prepare'||call==='task-runs/start'),false)
})
test('start事务前岗位变化的竞争被再次核对；仅确定岗位变化收口',async()=>{
 for(const code of ['teloa/conflict','teloa/forbidden'] as const){
  const f=fixture(),signal=new AbortController().signal,originalRun=f.ports.run
  let roleChanged=false
  f.ports.revalidate=async()=>{if(roleChanged)throw new WorkError('teloa/version-conflict','原接手同事的状态、版本或业务授权已变化，请先核对原交办。')}
  f.ports.run=async(endpoint,payload,runSignal,identity)=>{if(endpoint==='task-runs/start'){roleChanged=true;throw new WorkError(code,'当前任务或同事不能准备执行。')}return originalRun(endpoint,payload,runSignal,identity)}
  const status=await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
  assert.equal(status.members[0]?.status,'failed',code)
  assert.equal(status.members[0]?.run?.id,runId,code)
  assert.equal(f.run?.state,'prepared',code)
  await f.dispatch.deliver();assert.ok(f.calls.includes('notified'),code)
 }
})
test('旧岗位变更失败记录随已准备的Run恢复为可回流状态',async()=>{
 for(const message of ['原接手同事的状态、版本或业务授权已变化，请先核对原交办。','原接手员工的状态、版本或业务授权已变化，请先核对原交办。']){
  const f=fixture()
  await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
  f.setRun({...f.run!,state:'prepared'})
  f.stored.failures[roleId]={code:'teloa/version-conflict',message}
  const status=await f.dispatch.status('origin',requestId)
  assert.equal(status.members[0]?.status,'failed',message)
  assert.match(status.members[0]?.reason??'',/本人核对/)
  await f.dispatch.deliver();assert.ok(f.calls.includes('notified'),message)
 }
})
test('prepare后启动响应未知仍保持等待，不提前回流失败',async()=>{
 const f=fixture(),originalRun=f.ports.run
 f.ports.run=async(endpoint,payload,signal,identity)=>{if(endpoint==='task-runs/start'){f.calls.push(endpoint);throw new WorkError('teloa/execution-pending','发送状态未知，请核对。')}return originalRun(endpoint,payload,signal,identity)}
 const status=await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
 assert.equal(status.members[0]?.status,'waiting')
 assert.equal(f.run?.state,'prepared')
 await f.dispatch.deliver()
 assert.equal(f.calls.includes('publish'),false)
 assert.equal(f.calls.includes('notified'),false)
})
test('start冲突但岗位重验仍有效时保留等待，不把未证冲突误判为岗位终态',async()=>{
 for(const code of ['teloa/conflict','teloa/forbidden'] as const){
  const f=fixture(),originalRun=f.ports.run
  f.ports.revalidate=async()=>{}
  f.ports.run=async(endpoint,payload,signal,identity)=>{if(endpoint==='task-runs/start'){f.calls.push(endpoint);throw new WorkError(code,'执行暂不能领取')}return originalRun(endpoint,payload,signal,identity)}
  const status=await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal)
  assert.equal(status.members[0]?.status,'waiting',code)
  await f.dispatch.deliver()
  assert.equal(f.calls.includes('publish'),false,code)
 }
})
test('reserve或dispatch锁等待期间授权变化，不继续创建任务；请求仍可核对',async()=>{
 const f=fixture()
 await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal,async()=>{throw new WorkError('teloa/forbidden','会话授权已变化')})
 assert.equal(f.calls.filter(x=>x==='create').length,0);assert.equal(f.run,null);assert.ok(f.stored.failures[roleId])
})
test('回流被当前业务授权拒绝时不标notified，后续恢复可重试',async()=>{
 const f=fixture();f.setRequest({...request,targets:request.targets.map(x=>({...x,unavailable:'paused' as const}))})
 f.ports.publish=async()=>{throw new WorkError('teloa/forbidden','业务已撤权')};await f.dispatch.deliver();assert.equal(f.calls.includes('notified'),false)
 f.ports.publish=async()=>{f.calls.push('publish')};await f.dispatch.deliver();assert.deepEqual(f.calls,['publish','notified'])
})
test('新报告resume只带已持久确认名单；旧无名单字段请求维持原spec兼容',async()=>{
 for(const modern of [true,false]){
  const f=fixture(),targets=request.targets
  f.setRequest({...request,kind:'report',...(modern?{expectedReportTargets:targets}:{})})
  let input:unknown;f.ports.requests.reserve=async(_owner,value)=>{input=value;return f.stored}
  await f.dispatch.resume('origin',requestId,new AbortController().signal)
  assert.deepEqual((input as {expectedReportTargets?:unknown}).expectedReportTargets,modern?targets:undefined)
 }
})
test('跨业务结果按原成员scope即时授权，general不能让已撤权正文可见或被标已通知',async()=>{
 const f=fixture();f.setRequest({...request,kind:'report',scope:'general',allBusinesses:true})
 await f.dispatch.dispatch({...request,kind:'report',scope:'general',allBusinesses:true},new AbortController().signal)
 f.setRun({...f.run!,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:5,reason:'completed'}})
 let allowed=['general'],resultReads=0
 f.ports.authorize=async scopes=>{assert.deepEqual(new Set(scopes),new Set(['general','SOC']));if(scopes.some(scope=>!allowed.includes(scope)))throw new WorkError('teloa/forbidden','成员业务已撤权')}
 f.ports.result=async()=>{resultReads++;return '成员私有结果'}
 await assert.rejects(f.dispatch.status('origin',requestId),{code:'teloa/forbidden'})
 await assert.rejects(f.dispatch.list('origin'),{code:'teloa/forbidden'})
 await f.dispatch.deliver();assert.equal(resultReads,0);assert.equal(f.calls.includes('notified'),false);assert.equal(f.calls.includes('publish'),false)
 allowed=['general','SOC'];await f.dispatch.deliver();assert.ok(f.calls.includes('publish'));assert.ok(f.calls.includes('notified'));assert.equal(resultReads,1)
})
test('结果读取等待期间成员scope撤权，返回status前再次拒绝',async()=>{
 const f=fixture();f.setRequest({...request,kind:'report',scope:'general',allBusinesses:true})
 await f.dispatch.dispatch({...request,kind:'report',scope:'general',allBusinesses:true},new AbortController().signal)
 f.setRun({...f.run!,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:5,reason:'completed'}})
 let allowed=true
 f.ports.authorize=async()=>{if(!allowed)throw new WorkError('teloa/forbidden','成员已撤权')}
 f.ports.result=async()=>{allowed=false;return '不得返回的结果'}
 await assert.rejects(f.dispatch.status('origin',requestId),{code:'teloa/forbidden'})
})
test('交办锁连接在任务关联后失效，不得继续准备或启动原生运行',async()=>{
 const f=fixture(),lock=new AbortController(),original=f.ports.link
 f.ports.requests.withDispatchLock=async(_owner,_request,op)=>op(lock.signal)
 f.ports.link=async input=>{await original(input);lock.abort(new WorkError('teloa/storage-unavailable','锁已失效'))}
 await assert.rejects(f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal),{code:'teloa/storage-unavailable'})
 assert.equal(f.calls.filter(value=>value==='task-runs/prepare'||value==='task-runs/start').length,0)
 assert.equal(f.stored.stoppedAt,null,'锁故障并非本人停止请求')
})
test('回流锁失效时不得发布结果或标记已通知',async()=>{
 const f=fixture(),lock=new AbortController()
 f.setRequest({...request,targets:request.targets.map(target=>({...target,unavailable:'paused' as const}))})
 f.ports.requests.withDispatchLock=async(_owner,_request,op)=>{lock.abort(new WorkError('teloa/storage-unavailable','锁已失效'));return op(lock.signal)}
 await f.dispatch.deliver()
 assert.equal(f.calls.includes('publish'),false)
 assert.equal(f.calls.includes('notified'),false)
})
test('交办锁在读取已有运行时失效，不得再关联任务或准备运行',async()=>{
 const f=fixture(),lock=new AbortController()
 f.ports.requests.withDispatchLock=async(_owner,_request,op)=>op(lock.signal)
 f.ports.runs=async()=>{lock.abort(new WorkError('teloa/storage-unavailable','锁已失效'));return []}
 await assert.rejects(f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},new AbortController().signal),{code:'teloa/storage-unavailable'})
 assert.equal(f.calls.includes('link'),false)
 assert.equal(f.calls.includes('task-runs/prepare'),false)
})

 test('R3 task 的 dispatch/status/stop/resume 只使用固定父身份，不借普通回执或同字节创建',async()=>{
  const f=fixture(),signal=new AbortController().signal
  f.ports.tasks={request:async()=>{throw Error('普通request不能读取父任务')},create:async()=>{throw Error('普通create不能创建父任务')}}
  await f.dispatch.dispatch({...request,roleId,expectedRoleVersion:1},signal)
  assert.equal(f.calls.filter(x=>x==='create').length,1)
  assert.equal((await f.dispatch.status('origin',requestId)).members[0]?.task?.id,taskId)
  await f.dispatch.resume('origin',requestId,signal)
  await f.dispatch.stop('origin',requestId,signal)
  assert.equal(f.calls.filter(x=>x==='create').length,1)
 })
