import test from 'node:test'
import assert from 'node:assert/strict'
import type {ISessions,SessionBinding,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import type {IJobs} from '@deepseek-ai/dsh-api-job-controller/client'
import type {ToolResourceUseSnapshot} from '@teloa/contract'
import {createConversationOverviewSession} from '../src/client/conversation-overview-session.ts'

function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},set:(next:T)=>{value=next;for(const listener of [...listeners])listener()},size:()=>listeners.size}}
const event=(seq:number,type:string,data:unknown)=>({type:'event',event:{seq,type,data,time:seq*100,...(type==='user/message'?{surfaceOp:'append'}:{})}}) as SessionEventLikeEntry
const human=(seq:number)=>event(seq,'user/message',{id:'human',source:{kind:'user'},content:[]})
const base={running:false,removed:false,openState:'open' as const,lastAgentError:null,promptError:null,awaitingFirstTurn:false,subagent:null as null|{address:{parentSessionId:string;childSessionId:string;mode:'one-shot'}}}
function binding(id:string,rest:Partial<typeof base>={}){
 const state=source({...base,...rest}),events=source({entries:[] as readonly SessionEventLikeEntry[]}),catalog=source<unknown>([]),timing=source<unknown>(null),identity=source<unknown>(null),todos=source<unknown>([]),goal=source<unknown>(null)
 let cancelCalls=0,cancel=async():Promise<unknown>=>({ok:true,value:{accepted:true}})
 const value={sessionId:id,eventSource:events,session:{...state,sessionId:id,projections:{faceOf:(key:string)=>({subagentCatalog:catalog,subagentTiming:timing,subagent:identity,todos,goal}[key]??source(undefined))},cancel:()=>{cancelCalls++;return cancel()}}} as unknown as SessionBinding
 return {value,state,events,catalog,timing,identity,cancelCalls:()=>cancelCalls,setCancel:(next:typeof cancel)=>{cancel=next}}
}
function fixture(){
 const parent=binding('main',{running:true}),child=binding('child',{running:true,subagent:{address:{parentSessionId:'main',childSessionId:'child',mode:'one-shot'}}})
 const connection=source('connected'),retention=source({referenceCount:1,retainedBy:{}}),list=source({}),bindings=new Map<string,SessionBinding>([['main',parent.value],['child',child.value]])
 const rows=source({rows:{main:[] as readonly {id:string;kind:string;label:string;owner?:string;status:string;startedAt:number}[]},observed:{}})
 let watchCount=0,watchReleases=0,releases=0,refreshes=0,killCalls=0;const retained:unknown[]=[],used:unknown[]=[],projectionRefreshes:string[]=[]
 let ready:Promise<SessionBinding>=Promise.resolve(child.value),kill=async():Promise<unknown>=>({ok:true,value:{killed:true}}),onRetain=()=>{}
 const reference=()=>{let released=false;return {sessionId:'child',get binding(){if(released)throw Error('released');return child.value},ready,release:()=>{if(!released){released=true;releases++}}}}
 const sessions={binding:(id:string)=>bindings.get(id),list,retainInfo:()=>retention,retain:(target:unknown,options:unknown)=>{retained.push({target,options});onRetain();return reference()},using:async(target:unknown,options:unknown,operation:(ref:ReturnType<typeof reference>)=>unknown)=>{used.push({target,options});const ref=reference();try{await ref.ready;return await operation(ref)}finally{ref.release()}},refresh:async()=>{refreshes++},refreshProjections:async(id:string)=>{projectionRefreshes.push(id)},subagentAddress:()=>child.state.getSnapshot().subagent?.address} as unknown as ISessions
 const jobs={state:rows,watchRows:()=>{watchCount++;return()=>{watchReleases++}},kill:async(..._args:unknown[])=>{killCalls++;return await kill()}} as unknown as IJobs
 const resourceUseSnapshots=source<readonly ToolResourceUseSnapshot[]>([])
 const service=createConversationOverviewSession({binding:parent.value,sessions,jobs,connection,resourceUseSnapshots})
 const catalog=()=>parent.catalog.set([{id:'child',mode:'one-shot',label:'Research',createdAt:200}])
 return {parent,child,connection,retention,bindings,list,rows,service,catalog,retained,used,projectionRefreshes,resourceUseSnapshots,onRetain:(next:()=>void)=>{onRetain=next},setReady:(next:typeof ready)=>{ready=next},setKill:(next:typeof kill)=>{kill=next},counts:()=>({watchCount,watchReleases,releases,refreshes,killCalls})}
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
const job=(owner='main',status='running')=>({id:'job',kind:'bash',label:'Build',owner,status,startedAt:100})

test('挂载共享当前会话名册并保留带地址的真实子会话，移除及dispose释放全部订阅',async()=>{
 const f=fixture(),off=f.service.attach(),off2=f.service.attach();f.catalog();await tick()
 assert.equal(f.counts().watchCount,1)
 assert.deepEqual(f.retained,[{target:{parentSessionId:'main',childSessionId:'child',mode:'one-shot'},options:{source:'workOverview'}}])
 assert.equal(f.service.getSnapshot().running[0]?.status,'running');assert.ok(f.child.events.size()>0);assert.ok(f.child.timing.size()>0)
 f.child.events.set({entries:[event(3,'turn/start',{turn:1}),event(4,'turn/end',{turn:1,reason:{kind:'aborted'}})]});f.child.state.set({...f.child.state.getSnapshot(),running:false})
 assert.equal(f.service.getSnapshot().ended[0]?.status,'stopped')
 f.parent.catalog.set([]);assert.equal(f.counts().releases,1);assert.equal(f.child.events.size(),0)
 off();assert.equal(f.counts().watchReleases,0);off2();assert.equal(f.counts().watchReleases,1)
 f.service.dispose();assert.equal(f.parent.state.size(),0);assert.equal(f.connection.size(),0);assert.equal(f.retention.size(),0)
})

test('未完成的子引用在卸载后释放，迟到ready不重建订阅',async()=>{
 const f=fixture();let resolve!:(binding:SessionBinding)=>void
 f.setReady(new Promise(done=>{resolve=done}));f.service.attach();f.catalog();f.service.dispose()
 const snapshot=f.service.getSnapshot();resolve(f.child.value);await tick()
 assert.equal(f.service.getSnapshot(),snapshot);assert.equal(f.counts().releases,1);assert.equal(f.child.events.size(),0)
 assert.throws(()=>f.service.attach(),/disposed/)
})

test('retain同步目录通知不重复持有子会话，unknown目录通过真实地址解析后可停止',async()=>{
 const f=fixture();let notified=false
 f.onRetain(()=>{if(!notified){notified=true;f.list.set({})}});f.service.attach()
 f.parent.catalog.set([{id:'child',mode:'unknown',label:'Research',createdAt:200}]);await tick()
 assert.equal(f.retained.length,1);const work=f.service.getSnapshot().running[0]!;assert.equal(work.canStop,true)
 await f.service.stopWork(work);assert.equal(f.child.cancelCalls(),1)
 assert.deepEqual(f.used[0],{target:{parentSessionId:'main',childSessionId:'child',mode:'one-shot'},options:{source:'controllerOperation'}});f.service.dispose();assert.equal(f.counts().releases,2)
})

test('只停止实时属于当前会话的job，接受时仍在停止中且终态由名册决定',async()=>{
 const f=fixture();f.service.attach();f.rows.set({rows:{main:[job()]},observed:{}})
 const work=f.service.getSnapshot().running[0]!;let resolve!:(value:unknown)=>void
 f.setKill(()=>new Promise(done=>{resolve=done}));const stop=f.service.stopWork(work)
 assert.equal(f.service.getSnapshot().running[0]?.status,'stopping');assert.equal(f.service.getSnapshot().running[0]?.canStop,false)
 await assert.rejects(f.service.stopWork(work),/stopping/);assert.equal(f.counts().killCalls,1)
 resolve({ok:true,value:{killed:true}});await stop;assert.equal(f.service.getSnapshot().running[0]?.status,'stopping')
 f.rows.set({rows:{main:[job('main','killed')]},observed:{}});assert.equal(f.service.getSnapshot().ended[0]?.status,'stopped')
 f.rows.set({rows:{main:[job('other')]},observed:{}});await assert.rejects(f.service.stopWork(work),/current|owner|工作/);assert.equal(f.counts().killCalls,1);f.service.dispose()
})

test('RemoteResult失败抛出且保留未知状态，重查只刷新事实',async()=>{
 const f=fixture();f.service.attach();f.rows.set({rows:{main:[job()]},observed:{}})
 const work=f.service.getSnapshot().running[0]!;f.setKill(async()=>({ok:false,error:{code:'denied',message:'Denied'}}))
 await assert.rejects(f.service.stopWork(work),/Denied/);assert.equal(f.service.getSnapshot().running[0]?.status,'unknown')
 await f.service.reconcileWork(work);assert.equal(f.counts().refreshes,1);assert.deepEqual(f.projectionRefreshes,['main']);assert.equal(f.counts().killCalls,1)
 assert.equal(f.service.getSnapshot().running[0]?.status,'running');f.service.dispose()
})

test('子会话停止通过精确地址using验证父子身份，不用子sessionId普通寻址',async()=>{
 const f=fixture();f.service.attach();f.catalog();await tick();const work=f.service.getSnapshot().running[0]!
 await f.service.stopWork(work)
 assert.deepEqual(f.used,[{target:{parentSessionId:'main',childSessionId:'child',mode:'one-shot'},options:{source:'controllerOperation'}}])
 assert.equal(f.child.cancelCalls(),1);assert.equal(f.service.getSnapshot().running[0]?.status,'stopping')
 f.child.events.set({entries:[event(1,'turn/start',{turn:1}),event(2,'turn/end',{turn:1,reason:{kind:'aborted'}})]});f.child.state.set({...f.child.state.getSnapshot(),running:false})
 assert.equal(f.service.getSnapshot().ended[0]?.status,'stopped');await f.service.reconcileWork(work);assert.deepEqual(f.projectionRefreshes,['main','child']);f.service.dispose()
})

test('失联和父绑定代际替换禁用停止，拒绝旧异步回执影响当前视图',async()=>{
 const f=fixture();f.service.attach();f.rows.set({rows:{main:[job()]},observed:{}});const work=f.service.getSnapshot().running[0]!
 f.connection.set('disconnected');assert.equal(f.service.getSnapshot().status,'unknown');assert.equal(f.service.getSnapshot().running[0]?.status,'unknown');await assert.rejects(f.service.stopWork(work),/connected|连接/)
 f.connection.set('connected');let resolve!:(value:unknown)=>void;f.setKill(()=>new Promise(done=>{resolve=done}));const stop=f.service.stopWork(work)
 f.bindings.set('main',binding('main').value);f.retention.set({referenceCount:2,retainedBy:{}});const snapshot=f.service.getSnapshot()
 resolve({ok:true,value:{killed:true}});await assert.rejects(stop,/generation|代际/);assert.equal(f.service.getSnapshot(),snapshot);assert.equal(snapshot.status,'unknown');f.service.dispose()
})

test('子地址不匹配时不发取消请求，服务dispose后不发重查',async()=>{
 const f=fixture();f.service.attach();f.catalog();await tick();const work=f.service.getSnapshot().running[0]!
 f.child.state.set({...f.child.state.getSnapshot(),subagent:{address:{parentSessionId:'foreign',childSessionId:'child',mode:'one-shot'}}})
 await assert.rejects(f.service.stopWork(work),/parent|父|current|工作/);assert.equal(f.child.cancelCalls(),0)
 f.service.dispose();await assert.rejects(f.service.reconcileWork(work),/disposed/);assert.equal(f.counts().refreshes,0)
})

test('资源只汇总当前轮次可证实的父子关系，忽略继承工具与旧轮目录',async()=>{
 const f=fixture();f.service.attach()
 const call=(seq:number,name:string)=>event(seq,'tool/call',{turn:1,step:1,callId:`call${seq}`,name,arguments:'{}'})
 const result=(seq:number,callSeq:number,name:string)=>event(seq,'tool/result',{turn:1,step:1,message:{role:'tool',toolCallId:`call${callSeq}`,content:[],isError:false},meta:{teloaResourceUse:{schema:'teloa.resource-use/v1',kind:'mcp',providerId:'test',name,toolName:name,state:'used'}}})
 f.parent.events.set({entries:[event(1,'turn/start',{turn:1}),human(2),event(3,'subagent/catalog',{version:0,childId:'child',childCreatedAt:200,mode:'one-shot'})]})
 f.child.events.set({entries:[call(1,'inherited'),result(2,1,'inherited'),event(3,'session/end-seed',{inherited:true}),event(4,'turn/start',{turn:1}),call(5,'child-tool'),result(6,5,'child-tool')]});f.catalog();await tick()
 assert.deepEqual(f.service.getSnapshot().usageGroups.map(group=>group.name),['child-tool']);assert.equal(f.service.getSnapshot().usageGroups[0]?.evidence[0]?.executorId,'child')
 f.parent.events.set({entries:[event(1,'turn/start',{turn:1}),event(2,'subagent/catalog',{version:0,childId:'child',childCreatedAt:200,mode:'one-shot'}),human(3),human(7)]})
 assert.deepEqual(f.service.getSnapshot().usageGroups,[]);f.service.dispose()
})

test('独立来源snapshot按父子session分配，outer失败后仍保留成功nested的原生结算证据',async()=>{
 const f=fixture();f.service.attach();f.catalog();await tick()
 const native=(start:number)=>[event(start,'tool/call',{turn:1,step:1,callId:'outer',name:'run_code',arguments:'{}'}),event(start+1,'tool/ptc-dispatch-start',{rootCallId:'outer',parentCallId:'outer',subCallId:'nested',name:'mcp_search'}),event(start+2,'tool/ptc-dispatch',{rootCallId:'outer',parentCallId:'outer',subCallId:'nested',name:'mcp_search',isError:false}),event(start+3,'tool/result',{turn:1,step:1,message:{role:'tool',toolCallId:'outer',content:[],isError:true}})]
 const saved=(sessionId:string,start:number,name:string):ToolResourceUseSnapshot=>({schema:'teloa.resource-use-snapshot/v1',sessionId,parentCallSeq:start,startSeq:start+1,parentCallId:'outer',use:{schema:'teloa.resource-use/v1',kind:'mcp',providerId:'server',name,toolName:'mcp_search',state:'used',callId:'nested',rootCallId:'outer'}})
 f.parent.events.set({entries:[event(1,'turn/start',{turn:1}),human(2),event(3,'subagent/catalog',{version:0,childId:'child',childCreatedAt:200,mode:'one-shot'}),...native(4)]})
 f.child.events.set({entries:[event(3,'session/end-seed',{inherited:true}),event(4,'turn/start',{turn:1}),...native(5)]})
 f.resourceUseSnapshots.set([saved('main',4,'Parent tool'),saved('child',5,'Child tool'),saved('foreign',4,'Foreign tool')])
 assert.deepEqual(f.service.getSnapshot().usageGroups.map(group=>group.name),['Parent tool','Child tool'])
 assert.deepEqual(f.service.getSnapshot().usageGroups.map(group=>group.evidence[0]?.executorId),['main','child'])
 f.service.dispose();assert.equal(f.resourceUseSnapshots.size(),0)
})
