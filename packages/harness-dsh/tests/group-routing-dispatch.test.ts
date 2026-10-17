import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {Context} from '@deepseek-ai/cordis'
import {WorkError,groupRelayStopRequestId,groupRoutedReactionRequestId,groupRoutedTaskRequestId,groupRoutedAttemptTaskRequestId,groupRoutingAttemptRequestId,groupRoutingRequestId,groupRoutingSessionId,groupRoutingOutputV2Schema,groupRoutingCandidatesMax,type GroupReactionEmoji,type GroupTaskCreateInput} from '@teloa/contract'
import {CollaborationService,GroupAgentGrantService,GroupReactionService,GroupRoutingAttemptService,GroupRoutingDecisionService,initializeGroupRoutingAttempts,initializeGroupRoutingOutbox,readCurrentGroupRoutingAttempt,RoleDelegationService,RoleLifecycleService,RoleService,RoleToolGrantService,TwinExecutionConsentService,groupRelayStopText,groupRoutedTaskGoal,groupRunConfigFailedText,initializeCollaboration,initializeGroupAgentGrants,initializeGroupReactions,initializeGroupRoutingDecisions,initializeResources,initializeRoleLifecycle,initializeRoleToolGrants,initializeRoles,initializeTasks,initializeTaskRuns,initializeTaskRunSubagents,initializeTaskRunRuntimeLinks,initializeTaskRunFlows,openResourceDatabase} from '@teloa/backend'
import {teloaAgentPresetId} from '../src/composition-safety.ts'
import {createTaskRunGroupPublisher} from '../src/task-run-group-publisher.ts'
import type {GroupRoutingCandidate} from '../src/group-routing.ts'
import {dispatchGroupRouting,readRoutingCandidates,readRoutingGroup,readRoutingMessage,readRoutingTopic,type GroupRoutingDispatchPorts} from '../src/group-routing-dispatch.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {GroupRoutingOutboxPorts} from '../src/group-routing-outbox-driver.ts'
import type {GroupRoutingOutboxService} from '../../backend/src/work/group-routing-outbox.ts'

const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
/** 跳数与停下闸都按消息先后判定，测试时钟必须逐次前进。 */
let tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-09-21T09:00:00.000Z')+(tick++)*1000).toISOString()}
const signal=()=>AbortSignal.timeout(20000)

/** 宿主不依赖 `pg`（`business-definitions.ts:60` 的既有口径），连接池的类型从后端服务上取。 */
type RoutingPool=GroupRoutingDecisionService['pool']
let container:StartedPostgreSqlContainer,pool:RoutingPool,decisions:GroupRoutingDecisionService,reactions:GroupReactionService,temporary:string

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-group-routing-dispatch-'))
 const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,identity)).pool
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeRoleToolGrants(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeGroupReactions(pool);await initializeGroupRoutingDecisions(pool);await initializeGroupRoutingOutbox(pool);await initializeGroupRoutingAttempts(pool)
 await initializeTaskRuns(pool);await initializeTaskRunSubagents(pool);await initializeTaskRunRuntimeLinks(pool);await initializeTaskRunFlows(pool)
 decisions=new GroupRoutingDecisionService(pool,identity)
 reactions=new GroupReactionService(pool,identity)
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

/** 一条已结束的原生轮次：turn/start → 本次请求的 user/message → 助手正文 → turn/end。 */
const endedTurn=(requestId:string,text:string)=>[
 {seq:0,time:0,type:'turn/start',data:{turn:0}},
 {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:requestId},content:[],id:'ask',role:'user'}},
 {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,message:{content:[{type:'text',text}]}}},
 {seq:3,time:3,type:'turn/end',data:{turn:0,reason:{kind:'stop'}}},
]

type ModelOptions={answer?:string;broken?:boolean;onPrompt?:()=>void|Promise<void>;admissionMissing?:boolean}
/** 只桩原生会话面：路由通道本身（T8）照真跑，模型输出仍要过 `groupRoutingOutput` 的封闭集合判据。 */
function modelHarness(options:ModelOptions){
 const calls={prompt:[] as Record<string,unknown>[],warn:[] as string[],bound:[] as string[],released:[] as string[]},leases=new Map<string,string>()
 let events:unknown[]=[]
 const session={id:'routing',header:{},snapshotEvents:()=>events}
 const ctx={
  get:(name:string)=>name==='teloaResidentInputAdmission'&&!options.admissionMissing?{bindRouting:async(input:{sessionId:string;day:string;groupId:string;messageId:string;nativeRequestId:string})=>{
   // 原生模型面替身也必须核对真库消息来源，并在 prompt 生命周期内持有精确来源租约。
   const message=(await pool.query('select owner_id from teloa_group_messages where group_id=$1 and id=$2',[input.groupId,input.messageId])).rows[0];assert.ok(message)
   const attempt=await readCurrentGroupRoutingAttempt(pool as never,String(message.owner_id),input.messageId)
   assert.equal(input.nativeRequestId,groupRoutingAttemptRequestId(String(message.owner_id),input.groupId,input.messageId,attempt.attemptVersion));assert.equal(input.sessionId,groupRoutingSessionId(String(message.owner_id),input.groupId,input.day))
   assert.equal(leases.has(input.sessionId),false);leases.set(input.sessionId,input.nativeRequestId);calls.bound.push(input.nativeRequestId)
   return ()=>{assert.equal(leases.get(input.sessionId),input.nativeRequestId);leases.delete(input.sessionId);calls.released.push(input.nativeRequestId)}
  }}:undefined,
  logger:{warn:(message:string)=>{calls.warn.push(message)}},
  agentPresets:{resolve:async(id?:string)=>({id:id??teloaAgentPresetId})},
  sessionController:{
   inspect:async(id:unknown)=>({meta:{id:String(id),agentPreset:teloaAgentPresetId}}),
   create:async(request:{sessionId:string})=>({sessionId:request.sessionId}),
   prompt:async(request:Record<string,unknown>)=>{
    assert.equal(leases.get(String(request.sessionId)),request.requestId,'没有精确来源租约不能进入模型')
    calls.prompt.push(request)
    await options.onPrompt?.()
    if(options.broken)throw Error('模型通道不可用')
    events=endedTurn(String(request.requestId),options.answer??'')
    return {accepted:true as const}
   },
   resolveAgent:async()=>({agent:{session}}),
  },
 } as unknown as Context
 return {ctx,calls}
}

const output=(respond:readonly string[],reaction:readonly {roleId:string;emoji:GroupReactionEmoji}[]=[])=>JSON.stringify({schema:groupRoutingOutputV2Schema,intent:'reply',respond:[...respond],reactions:reaction.map(item=>({...item})),assignments:[],workTarget:null})

const candidateOf=(roleId:string,version:number,name:string):GroupRoutingCandidate=>({roleId,roleVersion:version,name,duty:'照看订单',...testRoleResponsibility})

/**
 * 数字员工回帖的真链路要走一整条运行（先例见 `group-tasks.test.ts` 的 `employeeReply`），
 * 跳数只关心 author_id 序列，因此这里按建表约束直接落行：author_id 是岗位 id 时 task_id/run_id 必须非空。
 */
async function colleagueMessage(owner:string,groupId:string,rootId:string,roleId:string,text:string):Promise<string>{
 const id=randomUUID()
 await pool.query('insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)',
  [id,owner,groupId,randomUUID(),'{}',rootId,roleId,text,'[]',identity.now(),randomUUID(),randomUUID()])
 return id
}

async function fixture(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=(name:string,kind:'employee'|'twin',scopes:string[])=>roles.create(owner,{requestId:randomUUID(),fields:{name,kind,scopes,duty:'照看订单',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const a=await role('售后','employee',['SOC']),b=await role('物流','employee',['SOC'])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'路由群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[a.id,b.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'话题根。'})
 const self=(text:string,mentions?:{roleId:string;expectedVersion:number}[])=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text,...(mentions?{mentions}:{})})
 return {owner,roles,groups,role,a,b,group,root,self}
}

type Recorded={createTask:GroupTaskCreateInput[];prepare:{requestId:string;taskId:string;expectedTaskVersion:number}[];start:string[];sendSystem:{requestId:string;text:string}[];lockedDuring:{prompt:boolean[];createTask:boolean[]}}

/** 段 A/段 C 的锁由真服务持有；这里只在回调进出时记一个计数，因此 `held>0` 恰好就是「此刻在锁内」。 */
function makePorts(owner:string,options:{candidates?:GroupRoutingCandidate[]|(()=>Promise<GroupRoutingCandidate[]>);createTaskFails?:Error;startState?:string}){
 const recorded:Recorded={createTask:[],prepare:[],start:[],sendSystem:[],lockedDuring:{prompt:[],createTask:[]}}
 const groups=new CollaborationService(pool,identity)
 let held=0
 const ports:GroupRoutingDispatchPorts={
  decisions:{
   identity,
   withTopicLock:(actor,groupId,rootId,fn)=>decisions.withTopicLock(actor,groupId,rootId,async db=>{held+=1;try{return await fn(db)}finally{held-=1}}),
   claimed:(db,actor,messageId)=>decisions.claimed(db,actor,messageId),
   isStopMessage:(db,actor,groupId,messageId)=>decisions.isStopMessage(db,actor,groupId,messageId),
   relayGateOpen:(db,actor,groupId,rootId,messageId)=>decisions.relayGateOpen(db,actor,groupId,rootId,messageId),
   relayStopRounds:(db,actor,groupId,rootId)=>decisions.relayStopRounds(db,actor,groupId,rootId),
   hops:(db,actor,groupId,rootId,messageId)=>decisions.hops(db,actor,groupId,rootId,messageId),
   record:(db,actor,params)=>decisions.record(db,actor,params),
  },
  attempts:new GroupRoutingAttemptService(pool,identity),
  group:(actor,groupId,db)=>readRoutingGroup(actor,groupId,db),
  message:(actor,messageId)=>readRoutingMessage(actor,messageId,pool),
  candidates:async(actor,groupId,db)=>typeof options.candidates==='function'?options.candidates():options.candidates??readRoutingCandidates(actor,groupId,db,pool),
  topic:(actor,groupId,rootId,db,messageId)=>readRoutingTopic(actor,groupId,rootId,db,messageId),
  createTask:async(_actor,input)=>{
   recorded.lockedDuring.createTask.push(held>0)
   recorded.createTask.push(input)
   if(options.createTaskFails)throw options.createTaskFails
   return {taskId:randomUUID()}
  },
  prepare:async(_actor,input)=>{recorded.prepare.push(input);return {runId:randomUUID()}},
  start:async(_actor,runId)=>{recorded.start.push(runId);return {state:options.startState??'active'}},
  sendSystem:async(actor,input)=>{
   recorded.sendSystem.push({requestId:input.requestId,text:input.text})
   const message=await groups.send(actor,{requestId:input.requestId,groupId:input.groupId,expectedVersion:input.expectedVersion,rootId:input.rootId,text:input.text})
   return {id:message.id}
  },
  applyReaction:(db,actor,params)=>reactions.applyRole(db,actor,{...params,runId:null}),
 }
 return {ports,recorded,promptLockProbe:()=>{recorded.lockedDuring.prompt.push(held>0)},owner}
}

async function readDecision(owner:string,messageId:string){
 const row=(await pool.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,messageId])).rows[0]
 return row?.decision as {kind:string;respond:string[];hops:number;candidateIds:string[];stopMessageId:string|null;truncatedCandidates:boolean}|undefined
}
const countDecisions=async(owner:string):Promise<number>=>(await pool.query('select count(*)::int c from teloa_group_routing_decisions where owner_id=$1',[owner])).rows[0].c as number

test('选中一位：写决策行、建任务带 trigger=routed、prepare 与 start 各一次',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx,calls}=modelHarness({answer:output([f.a.id])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.equal(calls.prompt.length,1)
 assert.deepEqual(calls.bound,calls.released);assert.equal(calls.bound.length,1)
 assert.equal(recorded.createTask.length,1)
 assert.equal(recorded.createTask[0]!.trigger,'routed')
 assert.equal(recorded.createTask[0]!.requestId,groupRoutedTaskRequestId(f.owner,f.group.id,message.id,f.a.id))
 assert.equal(recorded.createTask[0]!.goal,groupRoutedTaskGoal)
 assert.equal(recorded.createTask[0]!.expectedGroupVersion,f.group.version)
 assert.deepEqual(recorded.createTask[0]!.assignee,{roleId:f.a.id,expectedVersion:f.a.version})
 assert.equal(recorded.prepare.length,1)
 assert.equal(recorded.prepare[0]!.expectedTaskVersion,1)
 assert.equal(recorded.start.length,1)
 const decision=await readDecision(f.owner,message.id)
 assert.equal(decision?.kind,'routed')
 assert.deepEqual(decision?.respond,[f.a.id])
 assert.equal(decision?.hops,0)
})

test('四段顺序：锁不跨模型调用、不跨建任务',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const built=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:output([f.a.id]),onPrompt:built.promptLockProbe})
 await dispatchGroupRouting(ctx,f.owner,message.id,built.ports,signal())
 assert.deepEqual(built.recorded.lockedDuring.prompt,[false])
 assert.deepEqual(built.recorded.lockedDuring.createTask,[false])
})
test('来源租约缺失不进模型不交办；模型失败仍释放已核对的租约',async()=>{
 const f=await fixture(),message=await f.self('请核对本话题。'),built=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]}),missing=modelHarness({answer:output([f.a.id]),admissionMissing:true})
 await dispatchGroupRouting(missing.ctx,f.owner,message.id,built.ports,signal())
 assert.equal(missing.calls.prompt.length,0);assert.equal(built.recorded.createTask.length,0);assert.equal((await readDecision(f.owner,message.id))?.kind,'degraded')
 const another=await f.self('再核对本话题。'),broken=modelHarness({broken:true})
 await dispatchGroupRouting(broken.ctx,f.owner,another.id,built.ports,signal())
 assert.equal(broken.calls.prompt.length,1);assert.equal(broken.calls.bound.length,1);assert.deepEqual(broken.calls.released,broken.calls.bound);assert.equal(built.recorded.createTask.length,0)
})

test('同一条消息重放：不增决策行、不再建任务',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:output([f.a.id])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.equal(recorded.createTask.length,1)
 assert.equal(await countDecisions(f.owner),1)
})

test('并发两条同 messageId：都跑模型，只有一条 insert 成功且只建一次任务',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx,calls}=modelHarness({answer:output([f.a.id])})
 await Promise.all([dispatchGroupRouting(ctx,f.owner,message.id,ports,signal()),dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())])
 // 规格 §2.7 只承诺「可能都跑完段 B」：谁先拿到段 C 那把锁由调度决定，断言只钉住「至多一条决策、至多一次建任务」。
 assert.ok(calls.prompt.length>=1)
 assert.equal(await countDecisions(f.owner),1)
 assert.equal(recorded.createTask.length,1)
})

test('候选为空：不调模型、写 no-candidate；归档群写 archived',async()=>{
 const f=await fixture(),empty=await f.self('没人可选。')
 const blank=makePorts(f.owner,{candidates:[]})
 const first=modelHarness({answer:output([])})
 await dispatchGroupRouting(first.ctx,f.owner,empty.id,blank.ports,signal())
 assert.equal(first.calls.prompt.length,0)
 assert.equal((await readDecision(f.owner,empty.id))?.kind,'no-candidate')
 const archivedTrigger=await f.self('归档前最后一条。')
 await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{name:f.group.name,announcement:f.group.announcement,rules:openGroupRules,memberRoleIds:[f.a.id,f.b.id],pinned:false,archived:true}})
 const closed=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const second=modelHarness({answer:output([f.a.id])})
 await dispatchGroupRouting(second.ctx,f.owner,archivedTrigger.id,closed.ports,signal())
 assert.equal(second.calls.prompt.length,0)
 assert.equal((await readDecision(f.owner,archivedTrigger.id))?.kind,'archived')
})

test('员工回帖仅剩作者候选：宿主直接no-candidate，不问模型、不预留路由来源、不自回复',async()=>{
 const f=await fixture(),message=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'本轮结果已交付。')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 ports.workCandidates=async()=>{throw Error('员工回帖不能控制本人的原工作')}
 const model=modelHarness({answer:output([f.a.id])})
 await dispatchGroupRouting(model.ctx,f.owner,message,ports,signal())
 assert.equal(model.calls.prompt.length,0)
 assert.deepEqual(model.calls.bound,[]);assert.deepEqual(model.calls.released,[])
 const decision=await readDecision(f.owner,message)
 assert.equal(decision?.kind,'no-candidate');assert.deepEqual(decision?.candidateIds,[]);assert.deepEqual(decision?.respond,[])
 assert.deepEqual(recorded.createTask,[]);assert.deepEqual(recorded.prepare,[]);assert.deepEqual(recorded.start,[]);assert.deepEqual(recorded.sendSystem,[])
 assert.equal((await pool.query('select count(*)::int c from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,message])).rows[0].c,0)
})

test('员工回帖先排除作者再截候选：其他员工仍可回应，作者不占30位限额',async()=>{
 const f=await fixture(),message=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'@物流 请核对交接结果。')
 const others=[candidateOf(f.b.id,f.b.version,'物流'),...Array.from({length:groupRoutingCandidatesMax-1},(_,index)=>candidateOf(randomUUID(),1,'其他员工'+index))]
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'000作者'),...others]})
 const model=modelHarness({answer:output([f.b.id])})
 await dispatchGroupRouting(model.ctx,f.owner,message,ports,signal())
 assert.equal(model.calls.prompt.length,1);assert.deepEqual(model.calls.bound,model.calls.released)
 const input=JSON.parse((model.calls.prompt[0]!.content as {text:string}[])[0]!.text) as {trigger:{authorKind:string;authorId:string};candidates:{roleId:string}[];work:unknown[]}
 assert.deepEqual([input.trigger.authorKind,input.trigger.authorId],['role',f.a.id])
 assert.deepEqual(input.candidates.map(candidate=>candidate.roleId),others.map(candidate=>candidate.roleId));assert.deepEqual(input.work,[])
 const decision=await readDecision(f.owner,message)
 assert.equal(decision?.kind,'routed');assert.deepEqual(decision?.respond,[f.b.id]);assert.equal(decision?.truncatedCandidates,false)
 assert.deepEqual(decision?.candidateIds,others.map(candidate=>candidate.roleId))
 assert.deepEqual(recorded.createTask.map(task=>task.assignee?.roleId),[f.b.id]);assert.equal(recorded.prepare.length,1);assert.equal(recorded.start.length,1)
})

test('结构化 @ 由宿主直接选定接收者：模型只判断意图、不可用时仍回应；只派可回应者；无 @ 时模型不可用退化为不回',async()=>{
 const f=await fixture()
 const mentioned=await f.self('@售后 @物流 看一下。',[{roleId:f.a.id,expectedVersion:f.a.version},{roleId:f.b.id,expectedVersion:f.b.version}])
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const broken=modelHarness({broken:true})
 await dispatchGroupRouting(broken.ctx,f.owner,mentioned.id,ports,signal())
 const direct=await readDecision(f.owner,mentioned.id)
 assert.equal(broken.calls.prompt.length,1,'接收者已由宿主固定；模型只判断意图，不可用时仍按直接接收者回应')
 assert.equal(direct?.kind,'direct')
 assert.deepEqual(direct?.respond,[f.a.id],'不可回应的物流不被悄悄替换，也不进入派发')
 assert.equal(recorded.createTask.length,1)
 const plain=await f.self('没有点名。')
 await dispatchGroupRouting(modelHarness({broken:true}).ctx,f.owner,plain.id,ports,signal())
 const none=await readDecision(f.owner,plain.id)
 assert.equal(none?.kind,'degraded')
 assert.deepEqual(none?.respond,[])
})

test('模型有回但解析不过：写 parse-failed，不建任务',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:'我觉得应该让售后来回。'})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.equal((await readDecision(f.owner,message.id))?.kind,'parse-failed')
 assert.equal(recorded.createTask.length,0)
})

test('第六跳：不调模型、写 relay-stopped、发一条系统消息、stopMessageId 指向它、requestId 带轮次',async()=>{
 const f=await fixture()
 let last=''
 for(let index=0;index<6;index+=1)last=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'同事第'+index+'跳。')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.b.id,f.b.version,'物流')]})
 const {ctx,calls}=modelHarness({answer:output([f.b.id])})
 await dispatchGroupRouting(ctx,f.owner,last,ports,signal())
 assert.equal(calls.prompt.length,0)
 const decision=await readDecision(f.owner,last)
 assert.equal(decision?.kind,'relay-stopped')
 assert.equal(decision?.hops,6)
 assert.equal(recorded.sendSystem.length,1)
 assert.equal(recorded.sendSystem[0]!.text,groupRelayStopText)
 assert.equal(recorded.sendSystem[0]!.requestId,groupRelayStopRequestId(f.owner,f.group.id,f.root.id,1))
 const stop=(await pool.query('select id from teloa_group_messages where owner_id=$1 and request_id=$2',[f.owner,recorded.sendSystem[0]!.requestId])).rows[0]
 assert.equal(decision?.stopMessageId,stop.id)

 // 停下消息本身不触发新一轮路由。
 const before=await countDecisions(f.owner)
 await dispatchGroupRouting(ctx,f.owner,String(stop.id),ports,signal())
 assert.equal(await countDecisions(f.owner),before)

 // 停下之后本人未插话：整条跳过，不写决策、不调模型（H2）。
 const afterStop=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'停下后同事还想接。')
 await dispatchGroupRouting(ctx,f.owner,afterStop,ports,signal())
 assert.equal(await countDecisions(f.owner),before)
 assert.equal(calls.prompt.length,0)

 // 本人插话后恢复；再次触顶用轮次 2。
 await f.self('我来接着说。')
 const afterSelf=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'@物流 请补充本人插话之后的核对结果。')
 await dispatchGroupRouting(ctx,f.owner,afterSelf,ports,signal())
 assert.equal((await readDecision(f.owner,afterSelf))?.kind,'routed')
 let again=''
 for(let index=0;index<6;index+=1)again=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'再接第'+index+'跳。')
 await dispatchGroupRouting(ctx,f.owner,again,ports,signal())
 assert.equal((await readDecision(f.owner,again))?.kind,'relay-stopped')
 assert.equal(recorded.sendSystem.at(-1)!.requestId,groupRelayStopRequestId(f.owner,f.group.id,f.root.id,2))
})

test('建任务撞 conflict / version-conflict 都被吞掉，不重试、不抛；别的故障也不外冒',async()=>{
 const f=await fixture()
 for(const code of ['teloa/conflict','teloa/version-conflict','teloa/host-unavailable']){
  const message=await f.self('这单怎么处理？'+code)
  const failure=new WorkError(code as 'teloa/conflict','x')
  const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')],createTaskFails:failure})
  const {ctx}=modelHarness({answer:output([f.a.id])})
  await assert.doesNotReject(()=>dispatchGroupRouting(ctx,f.owner,message.id,ports,signal()))
  assert.equal(recorded.createTask.length,1)
  assert.equal(recorded.prepare.length,0)
 }
})

test('路由输出带 reactions：宿主直接落表，actor_kind=role、run_id 为空',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:output([],[{roleId:f.a.id,emoji:'👀'}])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 const rows=await pool.query('select actor_kind,actor_id,emoji,run_id from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,message.id])
 assert.deepEqual(rows.rows,[{actor_kind:'role',actor_id:f.a.id,emoji:'👀',run_id:null}])
})

test('被选中的同事先按一枚「收到」：与决策同事务落表、requestId 带 emoji 分量，重放不翻面',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:output([f.a.id])})
 const rows=async()=>(await pool.query('select actor_kind,actor_id,emoji,run_id,request_id,withdrawn_at from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 const expected=[{actor_kind:'role',actor_id:f.a.id,emoji:'👀',run_id:null,request_id:groupRoutedReactionRequestId(f.owner,message.id,f.a.id,'👀'),withdrawn_at:null}]
 assert.deepEqual(await rows(),expected)
 // 「收到」不写进决策行：决策行仍是模型那一次输出的逐字留痕。
 assert.deepEqual((await pool.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows[0].decision.reactions,[])
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.deepEqual(await rows(),expected,'重放不新增、不翻面')
})

test('模型已经为这一位选过表情：那一位不再补「收到」，没选到表情的那一位照补',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后'),candidateOf(f.b.id,f.b.version,'物流')]})
 const {ctx}=modelHarness({answer:output([f.a.id,f.b.id],[{roleId:f.a.id,emoji:'👍'}])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 const rows=(await pool.query('select actor_id,emoji from teloa_group_reactions where owner_id=$1 and message_id=$2 order by actor_id',[f.owner,message.id])).rows
 assert.deepEqual(rows.map(row=>[String(row.actor_id),String(row.emoji)]).sort(),[[f.a.id,'👍'],[f.b.id,'👀']].sort())
})

test('起运行回 configuration_failed：话题里多一条逐字提示，这条系统消息自己不产生决策行',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')],startState:'configuration_failed'})
 const {ctx}=modelHarness({answer:output([f.a.id])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.equal(recorded.start.length,1)
 assert.equal(recorded.sendSystem.length,1)
 // 逐字：既钉住常量本身，也钉住拼进去的岗位名。
 assert.equal(recorded.sendSystem[0]!.text,'售后 当前的运行配置不可用，这次没法回应。请到员工详情里检查运行配置。')
 assert.equal(recorded.sendSystem[0]!.text,groupRunConfigFailedText('售后'))
 // 身份复用这一位在本条触发消息上的任务身份：同一位对同一条触发消息至多一条提示。
 assert.equal(recorded.sendSystem[0]!.requestId,groupRoutedTaskRequestId(f.owner,f.group.id,message.id,f.a.id))
 const notice=(await pool.query('select text,root_id from teloa_group_messages where owner_id=$1 and request_id=$2',[f.owner,recorded.sendSystem[0]!.requestId])).rows[0]
 assert.equal(String(notice.text),groupRunConfigFailedText('售后'))
 assert.equal(String(notice.root_id),f.root.id,'提示落在触发消息所在的话题里')
 assert.equal(await countDecisions(f.owner),1,'提示只有触发消息那一条决策；系统消息自己不再引一轮路由')
})

test('输出里出现候选集外的 roleId：整条判 parse-failed，一个表情都不落表',async()=>{
 const f=await fixture(),message=await f.self('这单怎么处理？')
 const {ports}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx}=modelHarness({answer:output([],[{roleId:f.b.id,emoji:'👍'}])})
 await dispatchGroupRouting(ctx,f.owner,message.id,ports,signal())
 assert.equal((await readDecision(f.owner,message.id))?.kind,'parse-failed')
 assert.equal((await pool.query('select count(*)::int c from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows[0].c,0)
})

test('候选 SQL：不把本人那一行当同事（M15），未获本人执行许可的分身和范围不匹配岗位不入候选',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=(name:string,kind:'employee'|'twin',scopes:string[])=>roles.create(owner,{requestId:randomUUID(),fields:{name,kind,scopes,duty:'照看订单',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const a=await role('售后','employee',['SOC']),b=await role('物流','employee',['SOC'])
 const twin=await role('分身','twin',['SOC']),outsider=await role('外场','employee',['CRM'])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'路由群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[a.id,b.id,twin.id,outsider.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'话题根。'})
 // 范围不匹配的那位手工签一版 active 授权：判据必须由候选读口自己拒掉，不能只靠默认签发跳过。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[group.id,owner,outsider.id,group.version,outsider.version,randomUUID(),identity.now()])
 // 分身默认已有只读范围，手工追加自动Run；读口仍须核对本人委托与同意，不能只相信这一行。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,2,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[group.id,owner,twin.id,group.version,twin.version,randomUUID(),identity.now()])
 // 物流那位关掉发言权：只有 canAutoRun 的同事会在回帖时被挡住，候选集必须提前把他排除（J1）。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,2,$4,$5,'active','[]'::jsonb,false,true,$6,'{}'::jsonb,$7)`,[group.id,owner,b.id,group.version,b.version,randomUUID(),identity.now()])
 const client=await pool.connect()
 let listed:GroupRoutingCandidate[]
 try{listed=await readRoutingCandidates(owner,group.id,client,pool)}finally{client.release()}
 assert.deepEqual(listed.map(candidate=>candidate.roleId),[a.id])
 assert.equal(listed[0]!.roleVersion,a.version)
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text:'谁来接这一单？'})
 const {ports}=makePorts(owner,{})
 const {ctx}=modelHarness({answer:output([a.id])})
 await dispatchGroupRouting(ctx,owner,message.id,ports,signal())
 const decision=await readDecision(owner,message.id)
 assert.deepEqual(decision?.candidateIds,[a.id])
 assert.equal(decision?.candidateIds.includes('self'),false)
})

test('通用工作群的候选集含跨范围岗位：general 对任何在岗同事开放',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=(name:string,scopes:string[])=>roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee' as const,scopes,duty:'照看订单',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const soc=await role('安全运营',['SOC']),appsec=await role('应用安全',['AppSec'])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'通用工作群',scope:'general',announcement:'不绑业务数据。',rules:openGroupRules,memberRoleIds:[soc.id,appsec.id]}})
 const client=await pool.connect()
 let listed:GroupRoutingCandidate[]
 try{listed=await readRoutingCandidates(owner,group.id,client)}finally{client.release()}
 assert.deepEqual([...listed.map(candidate=>candidate.roleId)].sort(),[soc.id,appsec.id].sort())
})

/** 全部许可来自本人服务写口；测试不能靠一行 can_auto_run 冒充分身的执行同意。 */
async function twinFixture(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const initial=await roles.create(owner,{requestId:randomUUID(),fields:{name:'工作分身',kind:'twin',scopes:['SOC'],duty:'核验告警',dataScope:'群内固定证据',executionScope:'仅按本人委托执行',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await new RoleToolGrantService(pool,identity.now,async()=>{}).change(owner,{roleId:initial.id,expectedRoleVersion:initial.version,action:'save',rules:[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]})
 const role=(await roles.get(owner,initial.id))!
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'分身协作群',scope:'SOC',announcement:'仅处理明确授权的证据。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核验这条告警。'})
 const authority={authorize:async()=>({assertCurrent(){}})},grants=new GroupAgentGrantService(pool,identity.now),consents=new TwinExecutionConsentService(pool,identity,authority)
 const delegation=await new RoleDelegationService(pool,identity,authority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope:'SOC',allowedTools:['read_reference'],knowledgeIds:[],memoryViewId:null,groupIds:[group.id],safeRecovery:false}})
 const authorization={kind:'delegation' as const,delegationId:delegation.id,delegationVersion:delegation.version}
 const activate=async(canPost=true,canAutoRun=true)=>grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost,canAutoRun})
 const confirm=()=>consents.confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization})
 const candidates=async(withPool=true)=>{
  const db=await pool.connect()
  try{await db.query('begin');return await readRoutingCandidates(owner,group.id,db,withPool?pool:undefined)}finally{await db.query('rollback');db.release()}
 }
 return {owner,role,group,root,delegation,activate,confirm,candidates,consents}
}

test('Twin路由候选仅在本人当前委托、同意与群Run/发言授权均有效时出现',async()=>{
 const f=await twinFixture()
 assert.deepEqual(await f.candidates(),[])
 const consent=await f.confirm();await f.activate()
 assert.deepEqual((await f.candidates()).map(item=>[item.roleId,item.roleVersion]),[[f.role.id,f.role.version]])
 assert.deepEqual(await f.candidates(false),[])
 await f.activate(false,true);assert.deepEqual(await f.candidates(),[])
 await f.activate(true,false);assert.deepEqual(await f.candidates(),[])
 await f.activate();assert.equal((await f.candidates()).length,1)
 // 另一群即使有伪造的自动Run标记，也不能借用当前委托给原群的授权范围。
 const other=await new CollaborationService(pool,identity).create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'未被委托的群',scope:'SOC',announcement:'不能借用原群授权。',rules:openGroupRules,memberRoleIds:[f.role.id]}})
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,2,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[other.id,f.owner,f.role.id,other.version,f.role.version,randomUUID(),identity.now()])
 const db=await pool.connect()
 try{await db.query('begin');assert.deepEqual(await readRoutingCandidates(f.owner,other.id,db,pool),[])}finally{await db.query('rollback');db.release()}
 await f.consents.revoke(f.owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:consent.version})
 assert.deepEqual(await f.candidates(),[])
 assert.equal((await readRoutingMessage(f.owner,f.root.id,pool))?.text,'请核验这条告警。')
})

test('Twin群路由模型等待期间撤销同意，决策不接单、不加表情、不创建任务',async()=>{
 const f=await twinFixture(),consent=await f.confirm();await f.activate()
 const {ports,recorded}=makePorts(f.owner,{})
 const {ctx,calls}=modelHarness({answer:output([f.role.id],[{roleId:f.role.id,emoji:'👍'}]),onPrompt:async()=>{await f.consents.revoke(f.owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:consent.version})}})
 await dispatchGroupRouting(ctx,f.owner,f.root.id,ports,signal())
 assert.equal(calls.prompt.length,1)
 assert.deepEqual((await readDecision(f.owner,f.root.id))?.respond,[])
 assert.deepEqual((await reactions.list(f.owner,{groupId:f.group.id,messageIds:[f.root.id]})).items,[])
 assert.equal(recorded.createTask.length,0)
})

test('改使命（暂停→改定义→恢复在岗）之后候选集仍含他：岗位版本 +1 不再静默停掉直接回应',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),lifecycle=new RoleLifecycleService(pool,identity)
 const fields={name:'安全运营',kind:'employee' as const,scopes:['SOC'],duty:'照看告警',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}
 const role=await roles.create(owner,{requestId:randomUUID(),fields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'改使命也要能回话',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const listCandidates=async()=>{
  const client=await pool.connect()
  try{return await readRoutingCandidates(owner,group.id,client)}finally{client.release()}
 }
 assert.deepEqual((await listCandidates()).map(candidate=>candidate.roleId),[role.id])
 const paused=await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'改使命前暂停。'})
 const edited=await roles.edit(owner,{roleId:role.id,expectedVersion:paused.appliedVersion,fields:{...fields,duty:'改过的使命。'}})
 // 暂停期间本来就不该被选中：候选 SQL 的 roles.state='active' 这一条与续签无关，必须仍然生效。
 assert.deepEqual(await listCandidates(),[])
 const resumed=await lifecycle.change(owner,{roleId:role.id,expectedVersion:edited.version,action:'resume',reason:'改完恢复在岗。'})
 const listed=await listCandidates()
 assert.deepEqual(listed.map(candidate=>candidate.roleId),[role.id])
 assert.equal(listed[0]!.roleVersion,resumed.role.version)
 assert.equal(listed[0]!.duty,'改过的使命。')
})

test('在岗时撤一次工具授权：群授权按新岗位版本多一版 active，候选集仍含他',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 // 撤销不走能力目录校验（只有 save 走）：真被调到就让用例红，别让它悄悄变成一条新依赖。
 const toolGrants=new RoleToolGrantService(pool,identity.now,async()=>{throw Error('撤销不该校验工具范围')})
 const fields={name:'应用安全',kind:'employee' as const,scopes:['SOC'],duty:'看代码',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}
 const role=await roles.create(owner,{requestId:randomUUID(),fields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'撤工具也要能回话',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const listCandidates=async()=>{
  const client=await pool.connect()
  try{return await readRoutingCandidates(owner,group.id,client)}finally{client.release()}
 }
 const grantRows=async()=>(await pool.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version',[group.id,role.id])).rows
 assert.deepEqual((await listCandidates()).map(candidate=>candidate.roleId),[role.id])
 assert.equal((await grantRows()).length,1)
 // 撤销在岗时也能调，它同样把岗位版本 +1；不续签的话这一下就停掉他在所有群的直接回应。
 const revoked=await toolGrants.change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'revoke',rules:[]})
 assert.equal(revoked.state,'revoked')
 const rows=await grantRows()
 assert.equal(rows.length,2)
 assert.equal(rows[1].state,'active')
 assert.equal(rows[1].role_version,role.version+1)
 assert.equal(rows[1].can_post,true)
 assert.equal(rows[1].can_auto_run,true)
 const listed=await listCandidates()
 assert.deepEqual(listed.map(candidate=>candidate.roleId),[role.id])
 assert.equal(listed[0]!.roleVersion,role.version+1)
})

/** 同事回帖那一处触发点：回帖落库成功之后才发起，且它的失败绝不回到运行观察循环。 */
const publisherRun={id:randomUUID(),sessionId:'task-run-1',nativeRequestId:randomUUID()}

test('同事回帖成功后按新消息 id 触发一次路由；被授权判据挡住时不触发',async()=>{
 const routed:string[]=[],messageId=randomUUID()
 const ok=createTaskRunGroupPublisher({post:async()=>({id:messageId}),failure:async()=>{throw Error('成功消息不登记失败')},route:id=>{routed.push(id)},report:()=>{}})
 await ok(publisherRun as never,'回帖正文。')
 assert.deepEqual(routed,[messageId])
 const blocked:string[]=[],failures:string[]=[]
 const denied=createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/forbidden','x')},failure:async(run,code)=>{assert.equal(run.id,publisherRun.id);failures.push(code)},route:id=>{blocked.push(id)},report:()=>{}})
 await denied(publisherRun as never,'回帖正文。')
 assert.deepEqual(blocked,[]);assert.deepEqual(failures,['teloa/forbidden'])
})

test('触发点异常不外冒：回帖已确认写入，观察循环不为路由重试',async()=>{
 const publisher=createTaskRunGroupPublisher({post:async()=>({id:randomUUID()}),failure:async()=>{throw Error('成功消息不登记失败')},route:()=>{throw Error('路由端口坏了')},report:()=>{}})
 await assert.doesNotReject(()=>publisher(publisherRun as never,'回帖正文。'))
})

test('新宿主终态决策与outbox使用同连接；已claimed重入只恢复投递，不再询问路由模型',async()=>{
 const f=await fixture(),p=makePorts(f.owner,{candidates:[candidateOf(f.a.id,1,'售后')]}),model=modelHarness({answer:output([f.a.id])})
 let recorded=0,drained=0
 const outbox={recordRecipients:async(db:Parameters<GroupRoutingOutboxService['recordRecipients']>[0],owner:string,input:Parameters<GroupRoutingOutboxService['recordRecipients']>[2])=>{assert.equal(await decisions.claimed(db,owner,input.messageId),true);recorded++;return []},pending:async()=>{drained++;return []}} as unknown as GroupRoutingOutboxPorts['outbox']&Pick<GroupRoutingOutboxService,'recordRecipients'>
 p.ports.delivery={outbox,createTask:p.ports.createTask,prepare:p.ports.prepare,start:p.ports.start,readRun:async()=>{throw Error('没有待办不查Run')},reconcile:async()=>{throw Error('没有待办不查Run')},report:()=>{}}
 await dispatchGroupRouting(model.ctx,f.owner,f.root.id,p.ports,signal());await dispatchGroupRouting(model.ctx,f.owner,f.root.id,p.ports,signal())
 assert.equal(recorded,1);assert.equal(drained,2);assert.equal(model.calls.prompt.length,1);assert.equal(p.recorded.createTask.length,0)
})

test('引用员工消息：按宿主读出的原作者直接选定；显式 @ 覆盖引用；引用本人消息仍走语义选人',async()=>{
 const f=await fixture(),{ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后'),candidateOf(f.b.id,f.b.version,'物流')]})
 const answer=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'预算还剩 680 元。')
 const quoted=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'这个数怎么来的？',replyToMessageId:answer})
 const model=modelHarness({answer:output([f.b.id])})
 await dispatchGroupRouting(model.ctx,f.owner,quoted.id,ports,signal())
 assert.equal(model.calls.prompt.length,1)
 assert.deepEqual(await readDecision(f.owner,quoted.id).then(row=>[row?.kind,row?.respond]),['direct',[f.a.id]])
 const overridden=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'@物流 你来核对。',replyToMessageId:answer,mentions:[{roleId:f.b.id,expectedVersion:f.b.version}]})
 await dispatchGroupRouting(model.ctx,f.owner,overridden.id,ports,signal())
 assert.deepEqual(await readDecision(f.owner,overridden.id).then(row=>[row?.kind,row?.respond]),['direct',[f.b.id]])
 const anchored=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'接着上面说。',replyToMessageId:f.root.id})
 await dispatchGroupRouting(model.ctx,f.owner,anchored.id,ports,signal())
 assert.equal(model.calls.prompt.length,3,'引用本人消息只是上下文锚点，仍由语义选人')
 assert.deepEqual(recorded.createTask.map(item=>item.assignee?.roleId),[f.a.id,f.b.id,f.b.id])
})

test('结构化全员：群规则允许时每位候选直接回应；关闭时 blocked、不问模型、不建任务',async()=>{
 const f=await fixture(),{ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后'),candidateOf(f.b.id,f.b.version,'物流')]})
 const model=modelHarness({answer:output([f.a.id])})
 const all=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'@全员 各自说说进度。',mentionAll:true})
 await dispatchGroupRouting(model.ctx,f.owner,all.id,ports,signal())
 assert.deepEqual(await readDecision(f.owner,all.id).then(row=>[row?.kind,row?.respond]),['direct',[f.a.id,f.b.id]])
 const closed=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{name:f.group.name,announcement:f.group.announcement,rules:{...openGroupRules,mentionAllAllowed:false},memberRoleIds:[f.a.id,f.b.id],pinned:false,archived:false}})
 const denied=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:closed.version,rootId:f.root.id,text:'@全员 再说一次。',mentionAll:true})
 const before=recorded.createTask.length,asked=model.calls.prompt.length
 await dispatchGroupRouting(model.ctx,f.owner,denied.id,ports,signal())
 assert.equal(model.calls.prompt.length,asked,'全员未获允许时不问模型')
 assert.equal((await readDecision(f.owner,denied.id))?.kind,'blocked')
 assert.equal(recorded.createTask.length,before)
})

test('沿原消息重试：新尝试使用带版本的路由与任务身份，原决策保留，迟到重入不覆盖新尝试',async()=>{
 const f=await fixture(),message=await f.self('帮我看看这单。'),{ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 await dispatchGroupRouting(modelHarness({broken:true}).ctx,f.owner,message.id,ports,signal())
 assert.equal((await readDecision(f.owner,message.id))?.kind,'degraded')
 const attempts=new GroupRoutingAttemptService(pool,identity),retry={requestId:randomUUID(),groupId:f.group.id,messageId:message.id,expectedAttempt:1,expectedGroupVersion:f.group.version}
 assert.deepEqual(await attempts.retry(f.owner,retry),{messageId:message.id,attemptVersion:2})
 assert.deepEqual(await attempts.retry(f.owner,retry),{messageId:message.id,attemptVersion:2})
 const model=modelHarness({answer:output([f.a.id])})
 await Promise.all([dispatchGroupRouting(model.ctx,f.owner,message.id,ports,signal()),dispatchGroupRouting(model.ctx,f.owner,message.id,ports,signal())])
 assert.ok(model.calls.prompt.every(call=>call.requestId===groupRoutingAttemptRequestId(f.owner,f.group.id,message.id,2)))
 assert.notEqual(groupRoutingAttemptRequestId(f.owner,f.group.id,message.id,2),groupRoutingRequestId(f.owner,f.group.id,message.id))
 assert.deepEqual(recorded.createTask.map(item=>item.requestId),[groupRoutedAttemptTaskRequestId(f.owner,f.group.id,message.id,f.a.id,2)])
 assert.equal((await readDecision(f.owner,message.id))?.kind,'degraded','原决策行保留为旧审计')
 const settled=(await pool.query('select attempt_version,decision from teloa_group_routing_attempts where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows
 assert.deepEqual(settled.map(row=>[row.attempt_version,row.decision.kind,row.decision.respond]),[[2,'routed',[f.a.id]]])
 await dispatchGroupRouting(model.ctx,f.owner,message.id,ports,signal())
 assert.equal(recorded.createTask.length,1,'已定案的尝试重入不再问模型、不再派工')
 await assert.rejects(attempts.retry(f.owner,{...retry,requestId:randomUUID(),expectedAttempt:2}),{code:'teloa/conflict'})
})

const v2=(patch:Record<string,unknown>)=>JSON.stringify({schema:groupRoutingOutputV2Schema,intent:'reply',respond:[],reactions:[],assignments:[],workTarget:null,...patch})

test('依赖派工：模型等待期间撤销唯一前序接手者，后序一起失效，决策仍能落库且不会提前启动',async()=>{
 const f=await fixture(),text='先售后整理，再物流核对结果。',message=await f.self(text)
 let priorWithdrawn=false
 const {ports,recorded}=makePorts(f.owner,{candidates:async()=>[...(priorWithdrawn?[]:[candidateOf(f.a.id,f.a.version,'售后')]),candidateOf(f.b.id,f.b.version,'物流')]})
 const answer=v2({intent:'work',respond:[f.a.id,f.b.id],assignments:[{roleId:f.a.id,instructionRange:{start:0,end:text.length}},{roleId:f.b.id,instructionRange:{start:0,end:text.length},stage:2}]})
 await dispatchGroupRouting(modelHarness({answer,onPrompt:()=>{priorWithdrawn=true}}).ctx,f.owner,message.id,ports,signal())
 const decision=await readDecision(f.owner,message.id)
 assert.ok(decision,'失效仍应有持久决策，不得因阶段不连续导致事务回滚')
 assert.deepEqual(decision.respond,[]);assert.deepEqual((decision as {assignments?:unknown}).assignments,[])
 assert.deepEqual(new Set((decision as {withdrawn?:string[]}).withdrawn),new Set([f.a.id,f.b.id]));assert.equal(recorded.createTask.length,0)
})

test('固定接收者只限定身份：@员工的记录型消息（none）不开回复任务',async()=>{
 const f=await fixture(),{ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const noted=await f.self('@售后 只记一下，不用回复。',[{roleId:f.a.id,expectedVersion:f.a.version}])
 await dispatchGroupRouting(modelHarness({answer:v2({intent:'none'})}).ctx,f.owner,noted.id,ports,signal())
 const decision=await readDecision(f.owner,noted.id)
 assert.deepEqual([decision?.kind,decision?.respond],['direct',[]]);assert.equal(recorded.createTask.length,0)
})

test('没有可回应员工时，本人对原工作的停止仍登记到原工作（不依赖新派工资格）',async()=>{
 const f=await fixture(),message=await f.self('停止那项整理。'),taskId=randomUUID(),reserved:unknown[]=[]
 const {ports}=makePorts(f.owner,{candidates:[]})
 ports.workCandidates=async()=>[{taskId,runId:null,title:'整理',state:'running',version:3}]
 ports.workInputs={reserveInTransaction:async(_db,_owner,input)=>{reserved.push(input);return {requestId:(input as {requestId:string}).requestId,taskId,taskVersion:3,runId:null,state:'reserved',nativeRequestId:null,acceptedSeq:null,operation:'stop'}}}
 await dispatchGroupRouting(modelHarness({answer:v2({intent:'stop',workTarget:{taskId,runId:null}})}).ctx,f.owner,message.id,ports,signal())
 assert.equal((await readDecision(f.owner,message.id))?.kind,'routed')
 assert.deepEqual(reserved.map(item=>(item as {operation:string;taskId:string}).operation),['stop'])
})

test('本群协调者进入真实路由输入，明确点名优先且不可用协调者不进入候选',async()=>{
 const f=await fixture(),group=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{name:f.group.name,announcement:f.group.announcement,rules:f.group.rules,memberRoleIds:[f.a.id,f.b.id],pinned:false,archived:false,coordinatorRoleId:f.a.id}})
 const {ports,recorded}=makePorts(f.owner,{})
 const message=(text:string,mentions?:{roleId:string;expectedVersion:number}[])=>f.groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text,...(mentions?{mentions}:{})})
 const semantic=modelHarness({answer:output([f.a.id])}),first=await message('请协调团队分工并汇总。')
 await dispatchGroupRouting(semantic.ctx,f.owner,first.id,ports,signal())
 const input=(call:Record<string,unknown>)=>JSON.parse((call.content as {text:string}[])[0]!.text) as {group:{coordinatorRoleId?:string};candidates:{roleId:string}[]}
 assert.equal(input(semantic.calls.prompt[0]!).group.coordinatorRoleId,f.a.id);assert.equal(recorded.createTask[0]!.assignee?.roleId,f.a.id)
 const direct=modelHarness({answer:output([f.a.id])}),second=await message('请物流核对。',[{roleId:f.b.id,expectedVersion:f.b.version}])
 await dispatchGroupRouting(direct.ctx,f.owner,second.id,ports,signal())
 assert.deepEqual(input(direct.calls.prompt[0]!).candidates.map(row=>row.roleId),[f.b.id]);assert.equal(input(direct.calls.prompt[0]!).group.coordinatorRoleId,undefined)
 assert.equal(recorded.createTask.at(-1)!.assignee?.roleId,f.b.id)
 await new RoleLifecycleService(pool,identity).change(f.owner,{roleId:f.a.id,expectedVersion:f.a.version,action:'pause',reason:'本人暂停'})
 const afterPause=modelHarness({answer:output([f.b.id])}),third=await message('请汇总当前情况。')
 await dispatchGroupRouting(afterPause.ctx,f.owner,third.id,ports,signal())
 assert.equal(input(afterPause.calls.prompt[0]!).group.coordinatorRoleId,undefined)
 assert.equal((await f.groups.get(f.owner,{groupId:group.id})).group.coordinatorRoleId,f.a.id,'不可用不抹掉群原配置')
})

test('协调者等待模型期间失去资格仍受段C重核，原工作stop不被协调者改派',async()=>{
 const f=await fixture(),group=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{name:f.group.name,announcement:f.group.announcement,rules:f.group.rules,memberRoleIds:[f.a.id,f.b.id],pinned:false,archived:false,coordinatorRoleId:f.a.id}})
 const message=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请协调分工。'}),{ports,recorded}=makePorts(f.owner,{})
 let pausedVersion=f.a.version
 const model=modelHarness({answer:output([f.a.id]),onPrompt:async()=>{pausedVersion=(await new RoleLifecycleService(pool,identity).change(f.owner,{roleId:f.a.id,expectedVersion:f.a.version,action:'pause',reason:'本人暂停'})).role.version}})
 await dispatchGroupRouting(model.ctx,f.owner,message.id,ports,signal())
 assert.deepEqual((await readDecision(f.owner,message.id))?.respond,[]);assert.equal(recorded.createTask.length,0)
 await new RoleLifecycleService(pool,identity).change(f.owner,{roleId:f.a.id,expectedVersion:pausedVersion,action:'resume',reason:'本人明确恢复'})
 const stop=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'停止原来的整理工作。'}),taskId=randomUUID(),reserved:unknown[]=[]
 ports.workCandidates=async()=>[{taskId,runId:null,title:'原整理工作',state:'running',version:3}]
 ports.workInputs={reserveInTransaction:async(_db,_owner,input)=>{reserved.push(input);return {requestId:(input as {requestId:string}).requestId,taskId,taskVersion:3,runId:null,state:'reserved',nativeRequestId:null,acceptedSeq:null,operation:'stop'}}}
 const stopModel=modelHarness({answer:v2({intent:'stop',workTarget:{taskId,runId:null}})})
 await dispatchGroupRouting(stopModel.ctx,f.owner,stop.id,ports,signal())
 assert.equal(JSON.parse((stopModel.calls.prompt[0]!.content as {text:string}[])[0]!.text).group.coordinatorRoleId,f.a.id)
 assert.equal(reserved.length,1);assert.equal(recorded.createTask.length,0)
})
