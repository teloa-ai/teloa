import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {Context} from '@deepseek-ai/cordis'
import {WorkError,groupRelayStopRequestId,groupRoutedReactionRequestId,groupRoutedTaskRequestId,groupRoutingOutputSchema,type GroupReactionEmoji,type GroupTaskCreateInput} from '@teloa/contract'
import {CollaborationService,GroupReactionService,GroupRoutingDecisionService,RoleLifecycleService,RoleService,RoleToolGrantService,groupRelayStopText,groupRoutedTaskGoal,groupRunConfigFailedText,initializeCollaboration,initializeGroupAgentGrants,initializeGroupReactions,initializeGroupRoutingDecisions,initializeResources,initializeRoleLifecycle,initializeRoleToolGrants,initializeRoles,initializeTasks,openResourceDatabase} from '@teloa/backend'
import {teloaAgentPresetId} from '../src/composition-safety.ts'
import {createTaskRunGroupPublisher} from '../src/task-run-group-publisher.ts'
import type {GroupRoutingCandidate} from '../src/group-routing.ts'
import {dispatchGroupRouting,readRoutingCandidates,readRoutingGroup,readRoutingMessage,readRoutingTopic,type GroupRoutingDispatchPorts} from '../src/group-routing-dispatch.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

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
 await initializeGroupReactions(pool);await initializeGroupRoutingDecisions(pool)
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

type ModelOptions={answer?:string;broken?:boolean;onPrompt?:()=>void}
/** 只桩原生会话面：路由通道本身（T8）照真跑，模型输出仍要过 `groupRoutingOutput` 的封闭集合判据。 */
function modelHarness(options:ModelOptions){
 const calls={prompt:[] as Record<string,unknown>[],warn:[] as string[]}
 let events:unknown[]=[]
 const session={id:'routing',header:{},snapshotEvents:()=>events}
 const ctx={
  logger:{warn:(message:string)=>{calls.warn.push(message)}},
  agentPresets:{resolve:async(id?:string)=>({id:id??teloaAgentPresetId})},
  sessionController:{
   inspect:async(id:unknown)=>({meta:{id:String(id),agentPreset:teloaAgentPresetId}}),
   create:async(request:{sessionId:string})=>({sessionId:request.sessionId}),
   prompt:async(request:Record<string,unknown>)=>{
    calls.prompt.push(request)
    options.onPrompt?.()
    if(options.broken)throw Error('模型通道不可用')
    events=endedTurn(String(request.requestId),options.answer??'')
    return {accepted:true as const}
   },
   resolveAgent:async()=>({agent:{session}}),
  },
 } as unknown as Context
 return {ctx,calls}
}

const output=(respond:readonly string[],reaction:readonly {roleId:string;emoji:GroupReactionEmoji}[]=[])=>JSON.stringify({schema:groupRoutingOutputSchema,respond:[...respond],reactions:reaction.map(item=>({...item}))})

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
  group:(actor,groupId,db)=>readRoutingGroup(actor,groupId,db),
  message:(actor,messageId)=>readRoutingMessage(actor,messageId,pool),
  candidates:async(actor,groupId,db)=>typeof options.candidates==='function'?options.candidates():options.candidates??readRoutingCandidates(actor,groupId,db),
  topic:(actor,groupId,rootId,db)=>readRoutingTopic(actor,groupId,rootId,db),
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

test('模型不可用且有 mentions：退化按 mentions∩候选集；无 mentions：不回',async()=>{
 const f=await fixture()
 const mentioned=await f.self('@售后 @物流 看一下。',[{roleId:f.a.id,expectedVersion:f.a.version},{roleId:f.b.id,expectedVersion:f.b.version}])
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const broken=modelHarness({broken:true})
 await dispatchGroupRouting(broken.ctx,f.owner,mentioned.id,ports,signal())
 const degraded=await readDecision(f.owner,mentioned.id)
 assert.equal(degraded?.kind,'degraded')
 assert.deepEqual(degraded?.respond,[f.a.id])
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
 const {ports,recorded}=makePorts(f.owner,{candidates:[candidateOf(f.a.id,f.a.version,'售后')]})
 const {ctx,calls}=modelHarness({answer:output([f.a.id])})
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
 const afterSelf=await colleagueMessage(f.owner,f.group.id,f.root.id,f.a.id,'本人插话之后的第一跳。')
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

test('候选 SQL：不把本人那一行当同事（M15），分身、未授权与范围不匹配的都不入候选',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=(name:string,kind:'employee'|'twin',scopes:string[])=>roles.create(owner,{requestId:randomUUID(),fields:{name,kind,scopes,duty:'照看订单',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const a=await role('售后','employee',['SOC']),b=await role('物流','employee',['SOC'])
 const twin=await role('分身','twin',['SOC']),outsider=await role('外场','employee',['CRM'])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'路由群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[a.id,b.id,twin.id,outsider.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'话题根。'})
 // 范围不匹配的那位手工签一版 active 授权：判据必须由候选读口自己拒掉，不能只靠默认签发跳过。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[group.id,owner,outsider.id,group.version,outsider.version,randomUUID(),identity.now()])
 // 分身同样手工签一版：kind 这一条判据必须在读口里成立（默认签发跳过它，但库里可以有行）。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[group.id,owner,twin.id,group.version,twin.version,randomUUID(),identity.now()])
 // 物流那位关掉发言权：只有 canAutoRun 的同事会在回帖时被挡住，候选集必须提前把他排除（J1）。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,2,$4,$5,'active','[]'::jsonb,false,true,$6,'{}'::jsonb,$7)`,[group.id,owner,b.id,group.version,b.version,randomUUID(),identity.now()])
 const client=await pool.connect()
 let listed:GroupRoutingCandidate[]
 try{listed=await readRoutingCandidates(owner,group.id,client)}finally{client.release()}
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
 const ok=createTaskRunGroupPublisher({post:async()=>({id:messageId}),route:id=>{routed.push(id)},report:()=>{}})
 await ok(publisherRun as never,'回帖正文。')
 assert.deepEqual(routed,[messageId])
 const blocked:string[]=[]
 const denied=createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/forbidden','x')},route:id=>{blocked.push(id)},report:()=>{}})
 await denied(publisherRun as never,'回帖正文。')
 assert.deepEqual(blocked,[])
})

test('触发点异常不外冒：回帖已确认写入，观察循环不为路由重试',async()=>{
 const publisher=createTaskRunGroupPublisher({post:async()=>({id:randomUUID()}),route:()=>{throw Error('路由端口坏了')},report:()=>{}})
 await assert.doesNotReject(()=>publisher(publisherRun as never,'回帖正文。'))
})
