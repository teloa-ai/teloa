/**
 * 群内直接回应与表情一期 功能验证：真 PostgreSQL ＋ 真 `/teloa` RPC handler ＋ 真守卫的跨四包全链路（26 步）。
 *
 * 这条用例守的是「接缝」——逐任务评审各看自己的包，跨包的错位只有真实宿主才暴露。因此：
 * - 数据库是 testcontainers 起的真 PostgreSQL，建表由 `apply()` 自己的 `initializeTeloaDatabase` 完成；
 * - 端点一律经 `apply()` 注册在 `/teloa` 上的那一个 handler（`ok/value/error` 回包），不直接调服务类；
 * - 工具调用经真 `ToolRuntime` 的 `tools/pre-execute` 链，因此 `registerGroupRoutingGuard` 与
 *   `registerTaskToolGuard` 是真的按 `index.ts` 的注册顺序跑的；
 * - 路由编排、话题锁、决策表、候选 SQL、表情表、群任务与运行全部是生产代码。
 *
 * **模型侧为桩（全文唯一的桩）**：`sessionController` 是替身——
 * - 路由会话的 `prompt` 按触发正文查一张预置答案表，把「一整轮」（turn/start → user/message →
 *   assistant/message → turn/end）追加进真实会话日志，于是 `askGroupRouting` 读回的是预置 JSON；
 * - 运行会话的 `prompt` 只追加 turn/start ＋ user/message，终轮由用例在想让同事回帖时自己补。
 * 真实模型的覆盖在 T16 的浏览器验收里补。逐步标注见本任务报告。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry,type AgentHandle} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,groupRelayStopText,groupTopicNotice,runGroupContextHash,type RunGroupContext} from '@teloa/backend'
import {groupRelayStopRequestId,groupRoutedReactionRequestId,groupRoutedTaskRequestId,groupRoutingOutput,groupRoutingOutputSchema,groupRoutingRequestId,workErrorCodes} from '@teloa/contract'
import {apply} from '../src/index.ts'
import {teloaAgentPresetId} from '../src/composition-safety.ts'
import {isRoutingSession} from '../src/group-routing.ts'
import {groupRoutingDenyReason} from '../src/group-routing-guard.ts'
import {reactGroupOnlyReason,reactPostReason,reactTopicReason,groupReactToolName} from '../src/group-react-tool.ts'
import {compositionEntries} from './fixtures/production-host.ts'
import {installNativeHostServices,ControlledPromptModel,controlTaskQueue} from './fixtures/native-host-services.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..')
const owner='local:teloa-owner'
const wait=(ms:number)=>new Promise<void>(done=>{const timer=setTimeout(done,ms);timer.unref?.()})

/** 八个正式码；其余只允许 `workErrorCodes` 里已登记的既有位置码。 */
const officialCodes=['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict','teloa/dependency-unavailable','teloa/storage-corrupt','teloa/source-unavailable','teloa/invalid-host-response']
/** 既有位置码，逐字照抄 `contract/src/work-error.ts:11-39`；显式写出才有区分力，不能拿 `workErrorCodes` 顶替。 */
const positionCodes=['teloa/storage-unavailable','teloa/not-found','teloa/run-configuration-failed','teloa/binding-pending','teloa/cancelled','teloa/copy-in-progress','teloa/copy-lineage-mismatch','teloa/copy-result-unknown','teloa/execution-pending','teloa/file-changed','teloa/file-scope','teloa/file-too-large','teloa/file-unavailable','teloa/flow-not-required','teloa/host-unavailable','teloa/invalid-reference','teloa/not-bound','teloa/preset-unavailable','teloa/resource-withdrawn','teloa/session-not-adoptable','teloa/session-unavailable','teloa/skill-unavailable','teloa/snapshot-conflict','teloa/source-conflict','teloa/source-invalid','teloa/unavailable','teloa/workspace-unavailable']

/** T5 的默认签发身份，测试里按同式重算（不新增导出符号）；派生公式一改本用例立刻红。 */
const shape=(parts:readonly string[]):string=>{
 const digest=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
const defaultGrantRequestId=(groupId:string,roleId:string)=>shape(['teloa/group-member-default-grant/v1',owner,groupId,roleId])
const renewedGrantRequestId=(groupId:string,roleId:string,groupVersion:number)=>shape(['teloa/group-member-grant-renewal/v1',owner,groupId,roleId,String(groupVersion)])

type RpcReply={ok:boolean;value?:unknown;receipt?:{requestId:string};error?:{code?:string;message?:string;details?:unknown}}
type RpcHandler=(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<RpcReply>
type Role={id:string;version:number;state:string;kind?:string}
type Group={id:string;version:number}
type Message={id:string;groupId:string;rootId:string|null;authorId:string;text:string;taskId?:string|null;runId?:string|null}
type Run={id:string;taskId:string;sessionId:string;nativeRequestId:string;state:string;groupContext?:RunGroupContext;inputText?:string}
type Decision={kind:string;respond:string[];reactions:{roleId:string;emoji:string}[];hops:number;candidateIds:string[];truncatedCandidates:boolean;stopMessageId:string|null;at:string}

const answerOf=(respond:string[],reactions:{roleId:string;emoji:string}[]=[])=>JSON.stringify({schema:groupRoutingOutputSchema,respond,reactions})
const emptyAnswer=answerOf([])

test('群内直接回应从路由到接力停下与表情：真库、真端点、真守卫的跨四包全链路（模型侧为桩）',{timeout:1_800_000},async t=>{
 // ════════════════════ 装配 ════════════════════
 const previousProjectRoot=process.env.TELOA_PROJECT_ROOT
 process.env.TELOA_PROJECT_ROOT=repositoryRoot
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 // 受管目录逐层拒绝符号链接；macOS 的 /var/tmp 恰有系统链接，临时根放在工作树内（照 production-wiring）。
 const root=await mkdtemp(join(repositoryRoot,'.tmp-群内直接回应-'))
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 // 容器起来的下一行就挂清理：装配中途任意一步抛错也不留一个跑着的 postgres。
 // 清理内容随装配进度逐步补全（见 `:200` 的赋值），入口只有这一个，且只跑一次。
 let teardown=async():Promise<void>=>{await container.stop()}
 let tornDown=false
 t.after(async()=>{if(tornDown)return;tornDown=true;await teardown()})
 const config=join(root,'.runtime/teloa/database.json')
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true,mode:0o700})
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true,mode:0o700})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}),{mode:0o600})

 const ctx=new Context()
 ctx.provide('loader',compositionEntries())
 await ctx.plugin(LlmRuntime)
 ctx.llm.registerAdapter(['test'],new ControlledPromptModel())
 await ctx.plugin(SessionStore)
 await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt)
 await ctx.plugin(ToolRuntime)
 await ctx.plugin(AgentRegistry)
 await ctx.plugin(AgentLoop,{agents:[]})
 await installNativeHostServices(ctx,join(root,'.runtime/dsh'))

 const workspaces=new Map<string,{id:string;path:string}>()
 ctx.provide('workspaceRegistry',{
  create:async(path:string)=>{
   const found=[...workspaces.values()].find(entry=>entry.path===path)
   if(found)return found
   const entry={id:'group-routing-workspace-'+String(workspaces.size+1),path}
   workspaces.set(entry.id,entry);return entry
  },
  get:(id:string)=>workspaces.get(id),
  list:()=>[...workspaces.values()],
 })

 // ───── 模型侧的唯一一处桩 ─────
 /** 触发正文 → 路由模型这一轮要说的话。没登记的一律回「谁都不用回」。 */
 const answers=new Map<string,string>()
 const agents=new Map<string,AgentHandle>()
 const presets=new Map<string,string|undefined>()
 const creates:{sessionId:string;agentPreset?:string}[]=[]
 const prompts:{sessionId:string;requestId:string;text:string}[]=[]
 /** 每条会话当前开着的那一轮；运行会话的终轮由用例自己补。 */
 const openTurn=new Map<string,number>()
 const turnSeq=new Map<string,number>()
 /** 真实 `AgentRegistry` 的建会话口；`meta` 的子 Agent 三键在类型上不是公开面，按 unknown 下发。 */
 const createAgent=async(sessionId:string,meta:Record<string,unknown>):Promise<AgentHandle>=>
  await (ctx.agents.create as unknown as (input:unknown)=>Promise<AgentHandle>)({sessionId:SessionId(sessionId),meta,agentOptions:{provider:'test',model:'test'}})
 type AppendableSession={append:(...args:never[])=>unknown}
 const appendEvent=(session:AppendableSession,type:string,data:unknown,options?:unknown):void=>{
  (session.append as unknown as (t:string,d:unknown,o?:unknown)=>unknown)(type,data,options)
 }
 const sessionOf=(sessionId:string):AppendableSession=>{
  const handle=agents.get(sessionId)
  assert.ok(handle,`会话 ${sessionId} 尚未建立`)
  return handle.agent.session as unknown as AppendableSession
 }
 /**
  * 运行会话的轮次在 `prompt` 桩被调到时才开：`start` 先把运行记成 `submitting` 并提交，
  * 之后才经核对、技能与后台登记走到 `prompt`，所以「运行已离开 prepared」不等于「轮次已开」。
  * 按会话登记等待者，`prompt` 桩开轮时唤醒，不靠固定时长赌这段间隔。
  */
 const turnWaiters=new Map<string,(()=>void)[]>()
 const awaitOpenTurn=async(sessionId:string,timeoutMs=90_000):Promise<number>=>{
  if(!openTurn.has(sessionId))await new Promise<void>((done,fail)=>{
   const timer=setTimeout(()=>fail(new Error(`运行会话 ${sessionId} 还没有开着的轮次`)),timeoutMs);timer.unref?.()
   turnWaiters.set(sessionId,[...(turnWaiters.get(sessionId)??[]),()=>{clearTimeout(timer);done()}])
  })
  return openTurn.get(sessionId)!
 }
 /** 同事这一轮说完了：等到轮次开着，再补上助手正文与终轮，`readTaskRunGroupResult` 这才取得回正文。 */
 const finishRun=async(sessionId:string,text:string):Promise<void>=>{
  const turn=await awaitOpenTurn(sessionId)
  const session=sessionOf(sessionId)
  appendEvent(session,'assistant/message',{turn,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text}]}),stream:[]},{surfaceOp:'append'})
  appendEvent(session,'turn/end',{turn,reason:{kind:'completed'}})
  openTurn.delete(sessionId)
 }
 ctx.provide('sessionController',{
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{
   const sessionId=input.sessionId??randomUUID()
   if(agents.has(sessionId))throw Error('session already exists')
   creates.push({sessionId,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})})
   presets.set(sessionId,input.agentPreset)
   const path=(input.workspaceId===undefined?undefined:workspaces.get(input.workspaceId)?.path)??[...workspaces.values()][0]?.path??'/'
   const handle=await createAgent(sessionId,{cwd:path,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})})
   controlTaskQueue(ctx,handle.agent)
   agents.set(sessionId,handle)
   return {sessionId,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})}
  },
  fork:async()=>({sessionId:randomUUID()}),
  inspect:async(sessionId:unknown)=>({meta:{id:String(sessionId),...(presets.get(String(sessionId))===undefined?{}:{agentPreset:presets.get(String(sessionId))})}}),
  resolveAgent:async(sessionId:unknown)=>{
   const handle=agents.get(String(sessionId))
   return handle?{agent:handle.agent}:{error:'not-found'}
  },
  modelCatalog:async()=>({default:{provider:'test',model:'test'}}),
  cancel:()=>({accepted:true}),
  prompt:(request:{sessionId:string;requestId:string;content?:{type?:string;text?:string}[]})=>{
   const sessionId=String(request.sessionId),requestId=String(request.requestId)
   const text=(request.content??[]).filter(part=>part.type==='text').map(part=>String(part.text)).join('\n')
   prompts.push({sessionId,requestId,text})
   const session=sessionOf(sessionId)
   const turn=(turnSeq.get(sessionId)??-1)+1
   turnSeq.set(sessionId,turn)
   openTurn.set(sessionId,turn)
   appendEvent(session,'turn/start',{turn})
   appendEvent(session,'user/message',createUserMessage({content:[{type:'text',text:'执行'}],source:{kind:'user',rpcId:brandString<SessionRequestId>(requestId)}}),{surfaceOp:'append'})
   for(const wake of turnWaiters.get(sessionId)??[])wake()
   turnWaiters.delete(sessionId)
   if(isRoutingSession(sessionId)){
    // 路由这一轮当场说完：判断是秒级的，用例也要能立刻观察到决策行。
    const input=JSON.parse(text) as {trigger:{text:string}}
    const answer=answers.get(input.trigger.text)??emptyAnswer
    appendEvent(session,'assistant/message',{turn,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:answer}]}),stream:[]},{surfaceOp:'append'})
    appendEvent(session,'turn/end',{turn,reason:{kind:'completed'}})
    openTurn.delete(sessionId)
   }
   return {accepted:true as const}
  },
 })
 ctx.provide('skills',{
  list:async()=>[],
  registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{factory({invalidate:()=>{},signal:new AbortController().signal});return ()=>{}},
 })
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??teloaAgentPresetId})})
 ctx.provide('fs',{})
 ctx.provide('fileReferences',{})
 let registered:RpcHandler|undefined
 ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(path:string,handler:RpcHandler)=>{assert.equal(path,'/teloa');registered=handler;return ()=>{registered=undefined}}}})
 await apply(ctx,{projectRoot:root})
 assert.ok(registered,'/teloa handler 尚未注册')
 const rpc=registered
 const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 const pool=database.pool
 teardown=async()=>{
  if(previousProjectRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousProjectRoot
  await pool.end().catch(()=>{})
  await ctx.fiber.dispose().catch(()=>{})
  await container.stop()
  await rm(root,{recursive:true,force:true})
 }

 // ───── 生产两处触发点吞异常的那条通道（`index.ts:613`/`:786` 的 `.catch(…ctx.logger.warn(…))`）─────
 /**
  * 负向断言的假绿通道：路由整条抛掉时，异常只会变成一行 `Teloa 群内路由未完成：…` 警告，
  * 「没有决策行」于是既可能是「闸按规矩关着」，也可能是「这一趟崩了」。装一个只读探针把两者分开。
  * 回帖被授权判据挡住时的那一行（`index.ts:614` 的 `群内回传未写入`）同样从这里读。
  */
 const warnings:string[]=[]
 // `levels` 不能省：`logger.ts:153` 没配时按 `LoggerLevel.INFO`(1) 比，而 warn 是 2，1<2 会被整条跳过，
 // 探针就成了一个永远数到 0 的摆设（内置那个 buffer 导出器也因此收不到任何一行 warn）。
 ctx.logger.exporter({levels:{default:2},export:message=>{if(message.type==='warn')warnings.push(message.args.map(arg=>String(arg)).join(' '))}})
 const routingFailures=()=>warnings.filter(line=>line.includes('Teloa 群内路由未完成')).length
 const postRefusals=()=>warnings.filter(line=>line.includes('Teloa 同事群内回传未写入'))
 // 探针本身的自检在 M4 那一条：它要求这里真的收到两行 `群内回传未写入`。
 // 那一条绿，`routingFailures()` 的两处零断言才不是空转。

 // ───── RPC 调用与错误账本 ─────
 const failures:{endpoint:string;code:string;message:string;details:unknown}[]=[]
 const call=async(endpoint:string,payload:unknown):Promise<unknown>=>{
  const reply=await rpc(endpoint,payload,new AbortController().signal)
  if(reply.ok!==true){
   const error=reply.error??{}
   failures.push({endpoint,code:String(error.code),message:String(error.message),details:error.details})
   throw Object.assign(new Error(`${endpoint} → ${String(error.code)}：${String(error.message)}`),{code:error.code})
  }
  if(reply.receipt)await rpc('requests/pending/ack',{requestId:reply.receipt.requestId},new AbortController().signal)
  return reply.value
 }
 const refuse=async(endpoint:string,payload:unknown):Promise<{code:string;message:string;details:unknown}>=>{
  try{await call(endpoint,payload)}
  catch(error){
   assert.equal(typeof (error as {code?:unknown}).code,'string',`${endpoint} 应当回一个 WorkError`)
   return failures[failures.length-1]!
  }
  throw new Error(`${endpoint} 本应被拒绝却成功了`)
 }

 // ───── 库面读口 ─────
 const countOf=async(table:string):Promise<number>=>Number((await pool.query(`select count(*)::int as count from ${table} where owner_id=$1`,[owner])).rows[0].count)
 const counts=async()=>({decisions:await countOf('teloa_group_routing_decisions'),sources:await countOf('teloa_group_task_sources'),tasks:await countOf('teloa_tasks'),messages:await countOf('teloa_group_messages')})
 const decisionRow=async(messageId:string):Promise<Decision|undefined>=>{
  const row=(await pool.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,messageId])).rows[0]
  return row===undefined?undefined:row.decision as Decision
 }
 /** 触发点一律 fire-and-forget，决策行是唯一可观察的真源：轮询到它出现为止。 */
 const awaitDecision=async(messageId:string,timeoutMs=90_000):Promise<Decision>=>{
  const deadline=Date.now()+timeoutMs
  for(;;){
   const found=await decisionRow(messageId)
   if(found)return found
   if(Date.now()>=deadline)throw new Error(`等不到消息 ${messageId} 的路由决策`)
   await wait(50)
  }
 }
 /**
  * 段 D（建任务 → prepare → start）在决策行落库之后才跑，因此决策出现不代表运行已经起来：
  * 按确定性身份轮询到「来源行 ＋ 已启动的运行」都在为止。
  */
 const awaitRoutedRun=async(messageId:string,roleId:string,timeoutMs=90_000):Promise<{taskId:string;runId:string;sessionId:string;requestId:string}>=>{
  const requestId=groupRoutedTaskRequestId(owner,groupA.id,messageId,roleId)
  const deadline=Date.now()+timeoutMs
  for(;;){
   const source=(await pool.query('select task_id from teloa_group_task_sources where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
   if(source){
    const run=(await pool.query('select id,session_id,state from teloa_task_runs where owner_id=$1 and task_id=$2',[owner,source.task_id])).rows[0]
    if(run&&String(run.state)!=='prepared')return {taskId:String(source.task_id),runId:String(run.id),sessionId:String(run.session_id),requestId}
   }
   if(Date.now()>=deadline)throw new Error(`等不到消息 ${messageId} 派给 ${roleId} 的那一次运行`)
   await wait(50)
  }
 }
 const topicRows=async(rootId:string)=>(await pool.query('select id,author_id,text,task_id,run_id,mention_snapshot,request_id from teloa_group_messages where owner_id=$1 and (id=$2 or root_id=$2) order by (id=$2) desc,created_at,id',[owner,rootId])).rows
 const runsOfTask=async(taskId:string)=>await call('task-runs/list',{taskId}) as Run[]
 const routingPrompts=()=>prompts.filter(entry=>isRoutingSession(entry.sessionId))

 // ════════════════════ 夹具：六位同事 ════════════════════
 const hire=async(name:string,scope:string):Promise<Role>=>await call('roles/create',{requestId:randomUUID(),fields:{
  name,kind:'employee' as const,scopes:[scope],duty:`${name}的岗位使命`,dataScope:'群内消息',executionScope:'只做回答与说明',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:teloaAgentPresetId},
 }}) as Role
 const roleA=await hire('售后一号','SOC')
 const roleB=await hire('物流二号','SOC')
 const roleNoAuto=await hire('不自动三号','SOC')
 const roleNoPost=await hire('不发言四号','SOC')
 // 分身不能新建（`roles/create` 逐字回「分身随个人空间默认提供，无需创建。」）：个人空间自带一位，直接取它。
 const twin=((await call('roles/list',{})) as Role[]).find(role=>role.kind==='twin')
 assert.ok(twin,'个人空间必须自带一位分身')
 // 入群要求成员在岗；分身默认状态不一定是在岗，这一步是**夹具前置**，不走端点（同口径先例见群附件链路用例）。
 await pool.query("update teloa_roles set state='active' where owner_id=$1 and id=$2",[owner,twin.id])
 const roleOffScope=await hire('跨范围六号','general')
 const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
 const groupA=await call('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{
  name:'直接回应验收群',scope:'SOC',announcement:'本群用于验收群内直接回应。',rules,memberRoleIds:[roleA.id,roleB.id,roleNoAuto.id,roleNoPost.id,twin.id,roleOffScope.id],
 }}) as Group

 // ════════════════════ I1 ════════════════════
 const grantOf=async(groupId:string,roleId:string)=>await call('groups/agent-grants/get',{groupId,roleId}) as {status:string;groupVersion:number;grant:{state:string;grantVersion:number;groupVersion:number;canPost:boolean;canAutoRun:boolean;resources:unknown[]}|null}
 const grantA=await grantOf(groupA.id,roleA.id),grantB=await grantOf(groupA.id,roleB.id)
 await t.test('I1 建群拉两位在岗同事：C1 默认签发当场生效，两位都能自动开始并发言',()=>{
  assert.deepEqual(
   [grantA,grantB].map(read=>[read.status,read.grant?.state,read.grant?.grantVersion,read.grant?.canAutoRun,read.grant?.canPost,read.grant?.resources]),
   [['active','active',1,true,true,[]],['active','active',1,true,true,[]]],
  )
  assert.equal(grantA.grant?.groupVersion,groupA.version,'默认那版挂的是建群之后的群版本')
 })

 // ════════════════════ I2 ════════════════════
 const keepRole=await hire('保留授权','SOC')
 const revokedRole=await hire('已撤销','SOC')
 const movedRole=await hire('移出再拉回','SOC')
 const addedRole=await hire('后加入','SOC')
 const groupTwo=await call('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'授权分支群',scope:'SOC',announcement:'验收三分支。',rules,memberRoleIds:[keepRole.id,revokedRole.id,movedRole.id]}}) as Group
 // 本人亲手改过的那一版：关掉自动开始，保留发言。
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupTwo.id,roleId:keepRole.id,expectedGroupVersion:groupTwo.version,expectedRoleVersion:keepRole.version,action:'save',resources:[],canPost:true,canAutoRun:false})
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupTwo.id,roleId:revokedRole.id,expectedGroupVersion:groupTwo.version,expectedRoleVersion:revokedRole.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const changeMembers=async(group:Group,memberRoleIds:string[],name:string):Promise<Group>=>await call('groups/change',{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,fields:{name,announcement:'验收三分支。',rules,memberRoleIds,pinned:false,archived:false}}) as Group
 const groupTwoV2=await changeMembers(groupTwo,[keepRole.id,revokedRole.id,addedRole.id],'授权分支群')
 const groupTwoV3=await changeMembers(groupTwoV2,[keepRole.id,revokedRole.id,addedRole.id,movedRole.id],'授权分支群改名一次')
 const grantRows=async(groupId:string,roleId:string)=>(await pool.query('select grant_version,group_version,state,can_post,can_auto_run,request_id from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version',[owner,groupId,roleId])).rows
 const keepRows=await grantRows(groupTwo.id,keepRole.id),revokedRows=await grantRows(groupTwo.id,revokedRole.id)
 const addedRows=await grantRows(groupTwo.id,addedRole.id),movedRows=await grantRows(groupTwo.id,movedRole.id)
 const keepRead=await grantOf(groupTwo.id,keepRole.id),revokedRead=await grantOf(groupTwo.id,revokedRole.id),addedRead=await grantOf(groupTwo.id,addedRole.id)
 await t.test('I2 三分支：新成员签一版默认、已撤销不复活、本人改过的不被覆盖、移出再拉回不重新签发',()=>{
  // ① 新加入的那位：恰一版默认，身份是默认派生式（与 ④ 同口径：按默认派生身份数行，不数总行数）。
  assert.equal(addedRows.filter(row=>String(row.request_id)===defaultGrantRequestId(groupTwo.id,addedRole.id)).length,1,'新加入的那位只许签一版默认')
  assert.equal(addedRows[0]!.grant_version,1)
  assert.equal(String(addedRows[0]!.request_id),defaultGrantRequestId(groupTwo.id,addedRole.id))
  assert.equal(addedRead.status,'active')
  // ② 已撤销的那位：两次群编辑之后仍是 revoked，行集一字未增。
  assert.equal(revokedRead.status,'revoked')
  assert.equal(revokedRows.at(-1)!.state,'revoked')
  assert.equal(revokedRows.filter(row=>row.state==='active').length,1,'撤销之后不得再出现 active 版本')
  // ③ 本人改过的那位：三项逐字沿用，两次群编辑之后 status 仍 active（T5b）。
  assert.equal(keepRead.status,'active','任意次群编辑之后 status 仍是 active')
  assert.deepEqual([keepRead.grant?.canPost,keepRead.grant?.canAutoRun],[true,false],'续签逐字沿用本人的两个开关')
  assert.equal(keepRead.grant?.groupVersion,groupTwoV3.version)
  // grantVersion 计入编辑次数：默认 1 → 本人保存 2 → 两次群编辑各续一版 = 4。
  assert.equal(keepRead.grant?.grantVersion,4)
  assert.equal(String(keepRows.at(-1)!.request_id),renewedGrantRequestId(groupTwo.id,keepRole.id,groupTwoV3.version))
  // ④ 移出又拉回的：只有一条默认行，回来那一笔不重新签发（只按新群版本续签）。
  assert.equal(movedRows.filter(row=>String(row.request_id)===defaultGrantRequestId(groupTwo.id,movedRole.id)).length,1,'移出再拉回不得再签一版默认')
  assert.equal(movedRows[0]!.grant_version,1)
 })

 // ════════════════════ 候选面的三条反例（I19 / I20 / I21 的前置） ════════════════════
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:roleNoAuto.id,expectedGroupVersion:groupA.version,expectedRoleVersion:roleNoAuto.version,action:'save',resources:[],canPost:true,canAutoRun:false})
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:roleNoPost.id,expectedGroupVersion:groupA.version,expectedRoleVersion:roleNoPost.version,action:'save',resources:[],canPost:false,canAutoRun:true})
 // 分身与跨范围那两位按 C1 本来就签不出授权行（`grantMembers` 的四项判据先跳过），
 // 于是候选 SQL 的 join 就已经把它们滤掉了，JS 侧那两条判据得不到检验。这里**直写一版 active 授权**，
 // 让它们真的走到 `readRoutingCandidates` 的 JS 判据（`kind==='employee'`、`roleSupportsScope(scopes,scope)`）上。
 const forceGrant=async(roleId:string,roleVersion:number)=>{
  const spec=JSON.stringify({groupId:groupA.id,roleId,expectedGroupVersion:groupA.version,expectedRoleVersion:roleVersion,action:'save',resources:[],canPost:true,canAutoRun:true})
  await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
   values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,$7,$8) on conflict(group_id,role_id,grant_version) do nothing`,
   [groupA.id,owner,roleId,groupA.version,roleVersion,randomUUID(),spec,new Date().toISOString()])
 }
 await forceGrant(twin.id,twin.version)
 await forceGrant(roleOffScope.id,roleOffScope.version)

 // ════════════════════ I3 ＋ I4 ＋ I5 ════════════════════
 const firstText='这一单要怎么处理？'
 answers.set(firstText,answerOf([roleA.id]))
 const firstRequestId=randomUUID()
 const startedAt=Date.now()
 const rootMessage=await call('groups/messages/send',{requestId:firstRequestId,groupId:groupA.id,expectedVersion:groupA.version,text:firstText}) as Message
 const firstDecision=await awaitDecision(rootMessage.id)
 const routingDuration=Date.now()-startedAt
 const rootId=rootMessage.id
 const rootRow=(await pool.query('select mention_snapshot from teloa_group_messages where owner_id=$1 and id=$2',[owner,rootMessage.id])).rows[0]
 await t.test('I3 本人发一条不带 @ 的消息：mention_snapshot 落空数组',()=>{
  assert.deepEqual(rootRow.mention_snapshot,[])
 })
 await t.test('I4 不 @ 也回：kind=routed、hops=0、候选恰两位，一次触发恰问模型一次（M12）',()=>{
  assert.equal(firstDecision.kind,'routed')
  assert.equal(firstDecision.hops,0)
  assert.deepEqual(firstDecision.respond,[roleA.id])
  assert.deepEqual([...firstDecision.candidateIds].sort(),[roleA.id,roleB.id].sort())
  assert.equal(firstDecision.truncatedCandidates,false)
  const asked=routingPrompts().filter(entry=>entry.requestId===groupRoutingRequestId(owner,groupA.id,rootMessage.id))
  assert.equal(asked.length,1,'同一条触发消息只许问模型一次')
  t.diagnostic(`I4 从 groups/messages/send 返回到决策行落库的真实耗时：${String(routingDuration)}ms（模型侧为桩）`)
 })
 const firstRouted=await awaitRoutedRun(rootMessage.id,roleA.id)
 const firstTaskId=firstRouted.taskId
 const allSources=(await pool.query('select task_id,request_id from teloa_group_task_sources where owner_id=$1',[owner])).rows
 const firstStoredSource=await call('groups/tasks/source',{taskId:firstTaskId}) as {trigger:string}
 await t.test('I5 来源快照 trigger=routed，任务身份逐字等于 groupRoutedTaskRequestId',()=>{
  assert.equal(allSources.length,1,'第一轮路由应当恰建一条群任务来源')
  assert.equal(firstStoredSource.trigger,'routed')
  assert.equal(String(allSources[0]!.request_id),groupRoutedTaskRequestId(owner,groupA.id,rootMessage.id,roleA.id))
  assert.equal(String(allSources[0]!.task_id),firstTaskId)
 })

 // ════════════════════ I8 ＋ I10（回帖之前先看运行快照） ════════════════════
 const firstRuns=await runsOfTask(firstTaskId)
 assert.equal(firstRuns.length,1,'段 D 应当恰起一次运行')
 const firstRun=firstRuns.find(run=>run.id===firstRouted.runId)!
 const runRowOf=async(runId:string)=>(await pool.query('select input_text,group_context_hash,state from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0]
 const firstRunRow=await runRowOf(firstRun.id)
 const firstInput=JSON.parse(String(firstRunRow.input_text)) as Record<string,unknown>
 await t.test('I8 input_text 顶层带 groupTopic：≤20 条、升序、每项恰 5 键、notice 逐字',()=>{
  const topic=firstInput.groupTopic as {notice:string;messages:Record<string,unknown>[]}
  assert.ok(topic,'群任务的执行输入必须带 groupTopic')
  assert.equal(topic.notice,groupTopicNotice)
  assert.ok(topic.messages.length>=1&&topic.messages.length<=20)
  for(const message of topic.messages)assert.deepEqual(Object.keys(message).sort(),['authorId','authorKind','authorName','createdAt','text'])
  const stamps=topic.messages.map(message=>Date.parse(String(message.createdAt)))
  assert.deepEqual(stamps,[...stamps].sort((left,right)=>left-right),'话题按时间升序')
  assert.equal('groupTopic' in (firstInput.groupContext as Record<string,unknown>),false,'groupTopic 不进 groupContext')
 })
 await t.test('I10 RunGroupContext 键数与 runGroupContextHash 逐字不变',()=>{
  const context=firstRun.groupContext!
  // 键名逐字钉住（比只数个数更有区分力）：`task-run-group-context.ts:12` 的九键，`files` 必须排在最后。
  assert.deepEqual(Object.keys(context),['taskId','groupId','groupVersion','roleId','roleVersion','grantVersion','source','materials','files'])
  assert.deepEqual(Object.keys(context.source),['messageId','rootId','createdAt','text'])
  assert.equal(String(firstRunRow.group_context_hash),runGroupContextHash(context))
 })

 // ════════════════════ I9：运行期间本人再发一条，然后让运行回帖 ════════════════════
 const midText='补一句：请尽快。'
 const midMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:midText,rootId}) as Message
 await awaitDecision(midMessage.id)
 const relayText='收到，这件事要请 @物流二号 接着看一下。'
 answers.set(relayText,answerOf([roleB.id]))
 await finishRun(firstRun.sessionId,relayText)
 await call('task-runs/reconcile',{runId:firstRun.id})
 const topicAfterFirst=await topicRows(rootId)
 const firstReply=topicAfterFirst.find(row=>String(row.author_id)===roleA.id)
 await t.test('I9 运行期间本人插话之后，这次运行照样回帖成功（本期最关键的一条）',()=>{
  assert.ok(firstReply,'同事的回帖必须真的落在群里')
  assert.equal(String(firstReply!.text),relayText)
  // 「话题变长不改写已冻结 input_text」不在这里验：这一段里两次读 input_text 都在 claim 之后，
  //  生产又没有任何 UPDATE 写入点，怎么比都不可能红。真正的危险窗口在 prepare 与 start 之间，
  //  见下文「M11 真危险窗口」那一段。
 })
 await t.test('I6 回帖归属：author_id 是那位同事，task_id/run_id 都非空',()=>{
  assert.equal(String(firstReply!.author_id),roleA.id)
  assert.equal(String(firstReply!.task_id),firstTaskId)
  assert.equal(String(firstReply!.run_id),firstRun.id)
 })

 // ════════════════════ I12：同事回帖触发接力 ════════════════════
 const relayDecision=await awaitDecision(firstReply!.id as string)
 const relayRouted=await awaitRoutedRun(String(firstReply!.id),roleB.id)
 const relayTasks=(await pool.query('select task_id from teloa_group_task_sources where owner_id=$1 and request_id=$2',[owner,relayRouted.requestId])).rows
 const relayRuns=await runsOfTask(relayRouted.taskId)
 const colleagueRows=async()=>(await pool.query("select mention_snapshot from teloa_group_messages where owner_id=$1 and author_id<>'self'",[owner])).rows
 await t.test('I12 同事回帖触发接力：正文里的 @ 由路由模型读到，B 的任务与运行成立；同事行从不写 mention_snapshot',async()=>{
  assert.equal(relayDecision.kind,'routed')
  assert.equal(relayDecision.hops,1)
  assert.deepEqual(relayDecision.respond,[roleB.id])
  assert.equal(relayTasks.length,1,'接力必须真的建出 B 的群任务')
  assert.equal(relayRuns.length,1,'接力必须真的起一次运行')
  for(const row of await colleagueRows())assert.deepEqual(row.mention_snapshot,[],'服务端绝不把 @ 写进同事消息行')
 })

 // ════════════════════ 接力链：把话题推到第 6 跳 ════════════════════
 /** 手工建一条群任务并让它回帖：跳数与停下闸只关心 author 序列，中间几跳不必都由路由挑人。 */
 const driveColleagueReply=async(role:Role,sourceMessageId:string,text:string):Promise<string>=>{
  const created=await call('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:sourceMessageId,expectedGroupVersion:groupA.version,goal:'在群里回应这条消息。',assignee:{roleId:role.id,expectedVersion:role.version}}) as {task:{id:string;version:number}}
  const run=await call('task-runs/prepare',{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version}) as Run
  await call('task-runs/start',{runId:run.id})
  await finishRun(run.sessionId,text)
  await call('task-runs/reconcile',{runId:run.id})
  const posted=(await topicRows(rootId)).find(row=>String(row.text)===text)
  assert.ok(posted,`同事回帖「${text}」必须真的落在群里`)
  return String(posted!.id)
 }

 // ════════════════════ I7：同一条触发消息重放 ════════════════════
 // 重放那一次照样 fire-and-forget 地派发一趟路由（`index.ts:786` 不区分是不是幂等回执）。
 // 屏障不能用「本人再说一句」——那会把接力闸清零，后面就推不到第 6 跳了；改用本话题里
 // **下一条本来就要发的同事回帖**：它的决策落库意味着同一把话题锁上的后来者已经跑完一轮，
 // 重放那一趟若真要多写一行，只能写在它之前。
 const beforeReplay=await counts()
 const warnsBeforeReplay=routingFailures()
 const replayed=await call('groups/messages/send',{requestId:firstRequestId,groupId:groupA.id,expectedVersion:groupA.version,text:firstText}) as Message
 const secondText='我看了物流侧，没有异常。'
 await finishRun(relayRuns[0]!.sessionId,secondText)
 await call('task-runs/reconcile',{runId:relayRuns[0]!.id})
 const secondMessageId=String((await topicRows(rootId)).find(row=>String(row.text)===secondText)!.id)
 await awaitDecision(secondMessageId)
 const afterReplay=await counts()
 await t.test('I7 同一条触发消息重放：决策、群任务来源、任务三张表都只随屏障那一条增长',()=>{
  assert.equal(replayed.id,rootMessage.id,'同一 requestId 重发得同一条消息')
  // 屏障那一条同事回帖：新增一条群消息与它自己的一行决策（它的答案是「谁都不用回」，不建任务）；
  // 群任务来源与 teloa_tasks 两张表一条都不许多——重放若真的再派一次人，多出来的就在这两张表上。
  assert.deepEqual(afterReplay,{decisions:beforeReplay.decisions+1,sources:beforeReplay.sources,tasks:beforeReplay.tasks,messages:beforeReplay.messages+1})
  assert.equal(routingFailures(),warnsBeforeReplay,'这一段里不许有任何一趟路由被吞掉的失败')
 })
 const hopMessageIds=[String(firstReply!.id),secondMessageId]
 for(const [index,role] of [roleA,roleB,roleA,roleB].entries()){
  const text=`接力第 ${String(index+3)} 跳。`
  const id=await driveColleagueReply(role,rootId,text)
  hopMessageIds.push(id)
  if(index<3)await awaitDecision(id)
 }
 const stoppedMessageId=hopMessageIds.at(-1)!
 const stopDecision=await awaitDecision(stoppedMessageId)
 const stopMessageRow=stopDecision.stopMessageId===null?undefined:(await pool.query('select id,author_id,text,request_id,root_id from teloa_group_messages where owner_id=$1 and id=$2',[owner,stopDecision.stopMessageId])).rows[0]
 const hopAuthors=(await pool.query('select id,author_id from teloa_group_messages where owner_id=$1 and id=any($2::uuid[])',[owner,hopMessageIds])).rows
 await t.test('I13 互 @ 到第 6 跳：relay-stopped、hops=6、群里多一条 self 固定文案，停下身份带轮次分量',()=>{
  // 跳数只认 author 序列：这六条必须是 A/B 交替、中间一条 self 都没有，hops=6 才是这条链挣来的。
  assert.equal(hopMessageIds.length,6)
  assert.deepEqual(hopMessageIds.map(id=>String(hopAuthors.find(row=>String(row.id)===id)!.author_id)),[roleA.id,roleB.id,roleA.id,roleB.id,roleA.id,roleB.id])
  assert.equal(stopDecision.kind,'relay-stopped')
  assert.equal(stopDecision.hops,6)
  assert.ok(stopDecision.stopMessageId,'停下决策必须指向那条停下消息')
  assert.ok(stopMessageRow,'停下消息必须真的落在群里')
  assert.equal(String(stopMessageRow!.author_id),'self')
  assert.equal(String(stopMessageRow!.text),groupRelayStopText)
  assert.equal(String(stopMessageRow!.text),'我先停一下，等你确认再继续。')
  assert.equal(String(stopMessageRow!.root_id),rootId)
  assert.equal(String(stopMessageRow!.request_id),groupRelayStopRequestId(owner,groupA.id,rootId,1))
 })
 // ════════════════════ I14 ＋ I15 ＋ I16：两段负向窗口共用 I16 的插话作屏障 ════════════════════
 // 两条负向断言（停下消息不触发、闸关着时整条跳过）都是「什么都不该发生」，没有可以等的正向信号；
 // 静置一段时间等于赌。这里改用屏障：I16 本人那一句必然产生决策，它落库就说明同一把话题锁上
 // 排在停下消息与被跳过那条**之后**的一趟已经跑完——那两条若还要写决策，写的时刻只能在它之前。
 // 另一条假绿通道是 `index.ts:613`/`:786` 把异常吞成一行警告；`routingFailures()` 探针把它堵上。
 const promptsAfterStop=routingPrompts().length
 const warnsAfterStop=routingFailures()
 const beforeSkipped=await counts()
 const skippedMessageId=await driveColleagueReply(roleA,rootId,'停下之后又说了一句。')
 const promptsBeforeResume=routingPrompts().length
 const resumeText='我来说一句，接着聊。'
 const resumeMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:resumeText,rootId}) as Message
 const resumeDecision=await awaitDecision(resumeMessage.id)
 const afterSkipped=await counts()
 const warnsAfterResume=routingFailures()
 await t.test('I14 停下消息本身不触发新一轮路由',async()=>{
  assert.equal(await decisionRow(String(stopDecision.stopMessageId)),undefined,'停下消息不得有决策行')
  assert.equal(promptsBeforeResume,promptsAfterStop,'停下消息与被跳过那条都不得再问模型一次')
  assert.equal(warnsAfterResume,warnsAfterStop,'这两段里一趟被吞掉的路由都不许有——否则「没有决策行」是假绿')
 })
 await t.test('I15 停下之后本人没插话：整条跳过，不写决策、不问模型',async()=>{
  assert.equal(await decisionRow(skippedMessageId),undefined,'闸关着时一行决策都不该写')
  assert.equal(routingPrompts().length,promptsBeforeResume+1,'闸关着时一次模型都不该问；多出来的那一次是屏障那条本人消息')
  assert.equal(afterSkipped.decisions,beforeSkipped.decisions+1,'这一段里只许多出屏障那一条的决策')
 })
 await t.test('I16 本人插话之后闸放开：hops 归零、kind 回到 routed',()=>{
  assert.equal(resumeDecision.kind,'routed')
  assert.equal(resumeDecision.hops,0)
 })

 // ════════════════════ I17：再次触顶 ════════════════════
 let secondRoundId=''
 for(const [index,role] of [roleA,roleB,roleA,roleB,roleA,roleB].entries()){
  secondRoundId=await driveColleagueReply(role,rootId,`第二轮接力第 ${String(index+1)} 跳。`)
  if(index<5)await awaitDecision(secondRoundId)
 }
 const secondStop=await awaitDecision(secondRoundId)
 const secondStopRow=secondStop.stopMessageId===null?undefined:(await pool.query('select request_id,text from teloa_group_messages where owner_id=$1 and id=$2',[owner,secondStop.stopMessageId])).rows[0]
 await t.test('I17 再次触顶：第二条停下消息写入，requestId 的轮次分量是 2',()=>{
  assert.equal(secondStop.kind,'relay-stopped')
  assert.equal(secondStop.hops,6)
  assert.ok(secondStopRow,'第二条停下消息必须真的落库')
  assert.equal(String(secondStopRow!.text),groupRelayStopText)
  assert.equal(String(secondStopRow!.request_id),groupRelayStopRequestId(owner,groupA.id,rootId,2))
 })

 // ════════════════════ I18：路由 JSON 的四种坏法 ════════════════════
 const badAnswers=[
  {label:'非 JSON',text:'我觉得应该让售后一号来回。',mention:true},
  {label:'多一键',text:JSON.stringify({schema:groupRoutingOutputSchema,respond:[],reactions:[],note:'多一键'}),mention:false},
  {label:'roleId 不在候选集',text:answerOf([randomUUID()]),mention:false},
  {label:'emoji 不在十二枚',text:JSON.stringify({schema:groupRoutingOutputSchema,respond:[],reactions:[{roleId:roleA.id,emoji:'🍌'}]}),mention:false},
 ]
 const badResults:{label:string;decision:Decision}[]=[]
 for(const bad of badAnswers){
  const text=`坏 JSON 验收：${bad.label}`
  answers.set(text,bad.text)
  const sent=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text,...(bad.mention?{mentions:[{roleId:roleA.id,expectedVersion:roleA.version}]}:{})}) as Message
  badResults.push({label:bad.label,decision:await awaitDecision(sent.id)})
 }
 await t.test('I18 四种坏 JSON 都判 parse-failed：有 @ 时退化到 mentions ∩ 候选，没有 @ 就一个字不回',()=>{
  assert.deepEqual(badResults.map(item=>[item.label,item.decision.kind]),badAnswers.map(bad=>[bad.label,'parse-failed']))
  assert.deepEqual(badResults[0]!.decision.respond,[roleA.id],'有 @ 时退化到被 @ 且在候选集里的那位')
  for(const item of badResults.slice(1))assert.deepEqual(item.decision.respond,[],'没有 @ 就不回')
  for(const item of badResults)assert.deepEqual(item.decision.reactions,[],'退化时一个表情都不落')
 })

 // ════════════════════ I19 / I20 / I21：候选集的三条反例 ════════════════════
 const memberRows=(await pool.query('select member_key,role_id from teloa_group_members where owner_id=$1 and group_id=$2',[owner,groupA.id])).rows
 const twinAnswerText='分身验收：模型硬返回分身。'
 answers.set(twinAnswerText,answerOf([twin.id]))
 const twinMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:twinAnswerText}) as Message
 const twinDecision=await awaitDecision(twinMessage.id)
 // 「不在候选集」这条判据对三类人是同一条：`firstDecision.candidateIds` 不含它们只是读口的结论，
 // 真正要验的是「模型硬把它塞回来也过不去」。分身那条在 I21，没有发言权那位在 I26（一），
 // 关掉自动开始的这一位补在这里。
 const noAutoAnswerText='不自动验收：模型硬返回关掉自动开始的那位。'
 answers.set(noAutoAnswerText,answerOf([roleNoAuto.id]))
 const noAutoMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:noAutoAnswerText}) as Message
 const noAutoDecision=await awaitDecision(noAutoMessage.id)
 const noAutoSources=(await pool.query('select 1 from teloa_group_task_sources where owner_id=$1 and request_id=$2',[owner,groupRoutedTaskRequestId(owner,groupA.id,noAutoMessage.id,roleNoAuto.id)])).rows
 await t.test('I19 canAutoRun 为假的同事不进候选；模型硬返回它也整条 parse-failed，一条群任务都不建',()=>{
  assert.equal(firstDecision.candidateIds.includes(roleNoAuto.id),false)
  assert.equal(noAutoDecision.candidateIds.includes(roleNoAuto.id),false)
  assert.throws(()=>groupRoutingOutput(answerOf([roleNoAuto.id]),noAutoDecision.candidateIds),{code:'teloa/invalid-input'})
  assert.equal(noAutoDecision.kind,'parse-failed')
  assert.deepEqual(noAutoDecision.respond,[])
  assert.deepEqual(noAutoSources,[],'被拒的那一轮一条群任务来源都不许落表')
 })
 await t.test('I20 canAutoRun 为真但 canPost 为假的同事也不进候选（J1）',()=>{
  assert.equal(firstDecision.candidateIds.includes(roleNoPost.id),false)
 })
 await t.test('I21 分身与跨范围都不进候选；模型硬返回分身即 teloa/invalid-input；member_key=self 那行不是候选（M15）',()=>{
  assert.equal(firstDecision.candidateIds.includes(twin.id),false,'分身即使手工签了一版 active 授权也不入候选')
  assert.equal(firstDecision.candidateIds.includes(roleOffScope.id),false,'业务范围不匹配的同事不入候选')
  assert.throws(()=>groupRoutingOutput(answerOf([twin.id]),twinDecision.candidateIds),{code:'teloa/invalid-input'})
  assert.equal(twinDecision.kind,'parse-failed','硬返回分身的那一轮整条判解析失败')
  assert.deepEqual(twinDecision.respond,[])
  const selfRow=memberRows.find(row=>String(row.member_key)==='self')
  assert.ok(selfRow,'成员表里必须有 member_key=self 那一行')
  assert.equal(selfRow!.role_id,null)
  assert.equal(twinDecision.candidateIds.includes('self'),false)
 })

 // ════════════════════ I22：路由会话里任何工具都被拒 ════════════════════
 // 会话身份从桩账本里现取，不按 `(owner,groupId,今天)` 重算：重算那一式在跨 UTC 零点的那一次运行里
 // 会算出第二条身份，把一条真实的接线断言变成看日历的抽奖。`isRoutingSession` 是生产判据，仍然真跑。
 const routingSessionId=creates.find(entry=>isRoutingSession(entry.sessionId))!.sessionId
 const routingAgent=agents.get(routingSessionId)
 assert.ok(routingAgent,'路由会话必须已经由真实装配建起来')
 const childId='sub-of-routing-'+randomUUID()
 const childHandle=await createAgent(childId,{cwd:'/',origin:'subagent',parentSession:routingSessionId,delegationDepth:1})
 const orphanId='sub-orphan-'+randomUUID()
 const orphanHandle=await createAgent(orphanId,{cwd:'/',origin:'subagent',parentSession:'never-existed-'+randomUUID(),delegationDepth:1})
 let callSeq=0
 const runTool=async(agent:AgentHandle['agent'],name:string,args:Record<string,unknown>):Promise<{isError:boolean}>=>
  await ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('chain-'+String(++callSeq)),signal:AbortSignal.timeout(20_000)}) as unknown as {isError:boolean}
 const deniedRouting=await runTool(routingAgent.agent,groupReactToolName,{messageId:rootId,emoji:'👍'})
 const deniedChild=await runTool(childHandle.agent,groupReactToolName,{messageId:rootId,emoji:'👍'})
 const deniedOrphan=await runTool(orphanHandle.agent,groupReactToolName,{messageId:rootId,emoji:'👍'})
 const reactionsOfRoot=async()=>(await pool.query('select actor_kind,actor_id,emoji,run_id,request_id,withdrawn_at from teloa_group_reactions where owner_id=$1 and message_id=$2 order by created_at',[owner,rootId])).rows
 const afterDeny=await reactionsOfRoot()
 await t.test('I22 路由会话与它的子 Agent 调任何工具都被拒，理由逐字且不泄身份；谱系断链另一条理由',()=>{
  for(const [label,result] of [['路由会话',deniedRouting],['子 Agent',deniedChild]] as const){
   assert.equal(result.isError,true,`${label}的工具调用必须被拒`)
   const body=JSON.stringify(result)
   assert.ok(body.includes(groupRoutingDenyReason),`${label}应逐字回「${groupRoutingDenyReason}」，实得 ${body}`)
   for(const leak of [routingSessionId,childId,groupReactToolName,rootId])assert.equal(body.includes(leak),false,`${label}的理由泄了 ${leak}`)
  }
  assert.equal(deniedOrphan.isError,true)
  const orphanBody=JSON.stringify(deniedOrphan)
  assert.ok(orphanBody.includes('无法核对任务执行权限，请先恢复授权服务。'))
  for(const leak of [orphanId,routingSessionId,groupReactToolName,rootId])assert.equal(orphanBody.includes(leak),false)
  // 这一刻没有任何一次路由在途，闸照样拒——它判的是会话 id 的结构，不是「有没有在跑」。
  // 「超时之后闸仍然在」那一条另有专用用例（`group-routing-channel.test.ts:239`），本用例不重复它。
  // 根消息上此刻恰有一行：路由给被选中的 A 按下的那枚「收到」（run_id 为空）。被拒的三次调用一行都不许落表。
  assert.deepEqual(afterDeny.map(row=>[String(row.actor_kind),String(row.actor_id),String(row.emoji),row.run_id]),[['role',roleA.id,'👀',null]],'被拒的调用一行表情都不许落表')
 })

 // ════════════════════ I23：路由会话的预设与复用 ════════════════════
 await t.test('I23 路由会话的预设逐字是 teloaAgentPresetId，同群同日只建一条会话（H3/H6）',()=>{
  const routingCreates=creates.filter(entry=>isRoutingSession(entry.sessionId))
  assert.equal(routingCreates.length,1,'同群同日每一次路由都必须复用同一条会话')
  assert.equal(routingCreates[0]!.agentPreset,teloaAgentPresetId)
  assert.equal(routingCreates[0]!.agentPreset,'teloa-standard')
  assert.ok(routingPrompts().filter(entry=>entry.sessionId===routingSessionId).length>=5,'本用例确实在这条会话上问过多次')
 })

 // ════════════════════ M11 的真危险窗口：prepare 与 start 之间话题真的变长 ════════════════════
 // 「话题冻结一次、claim 绝不重算」这条只有在**冻结之后、领取之前话题确实变了**的那一刻才验得到：
 // `claim()` 从落库行原样取回 `groupTopic` 再重拼执行输入去比对（`task-runs.ts:364-367`），
 // 若它改为现读话题，这一段立刻拿 `teloa/version-conflict`，整个运行再也起不来。
 const windowTask=await call('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:rootId,expectedGroupVersion:groupA.version,goal:'验收 prepare 与 start 之间的话题增长。',assignee:{roleId:roleA.id,expectedVersion:roleA.version}}) as {task:{id:string;version:number}}
 const windowRun=await call('task-runs/prepare',{requestId:randomUUID(),taskId:windowTask.task.id,expectedTaskVersion:windowTask.task.version}) as Run
 const windowInputAtPrepare=String((await runRowOf(windowRun.id)).input_text)
 const windowMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'窗口验收：prepare 之后、start 之前本人又说了一句。',rootId}) as Message
 await awaitDecision(windowMessage.id)
 const windowTopicCount=(await topicRows(rootId)).length
 const windowStarted=await call('task-runs/start',{runId:windowRun.id}) as Run
 const windowInputAfterStart=String((await runRowOf(windowRun.id)).input_text)
 await t.test('M11 prepare 与 start 之间话题多了一条：claim 照样领取成功，落库的执行输入一个字不变',()=>{
  const frozen=(JSON.parse(windowInputAtPrepare) as {groupTopic:{messages:unknown[]}}).groupTopic
  assert.ok(frozen,'前置：冻结那一刻这一行是带 groupTopic 的')
  assert.equal(frozen.messages.length<windowTopicCount,true,`前置：窗口里话题必须真的变长（冻结 ${String(frozen.messages.length)} 条 / 当下 ${String(windowTopicCount)} 条）`)
  assert.equal(['accepted','active'].includes(windowStarted.state),true,`话题增长不得把领取判成版本冲突，实得 ${windowStarted.state}`)
  assert.equal(windowInputAfterStart,windowInputAtPrepare,'claim 不重算话题：落库的执行输入与冻结时逐字相同')
 })

 // ════════════════════ I11：手工删掉 groupTopic 之后 claim 仍成功 ════════════════════
 const legacyTask=await call('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:rootId,expectedGroupVersion:groupA.version,goal:'验收旧形状执行输入。',assignee:{roleId:roleA.id,expectedVersion:roleA.version}}) as {task:{id:string;version:number}}
 const legacyRun=await call('task-runs/prepare',{requestId:randomUUID(),taskId:legacyTask.task.id,expectedTaskVersion:legacyTask.task.version}) as Run
 const legacyInput=JSON.parse(String((await runRowOf(legacyRun.id)).input_text)) as Record<string,unknown>
 assert.ok('groupTopic' in legacyInput,'前置：这一行本来是带 groupTopic 的')
 // 投影恰好覆盖话题的全部消息，满 20 条就截到 20（`group-topic.ts:31` 的 `slice(-20)`）：
 // 少一条就是丢消息，多一条就是越界。这里按当下真实行数算上限，不写死一个会随夹具漂移的数。
 const legacyTopicCount=(await topicRows(rootId)).length
 assert.equal((legacyInput.groupTopic as {messages:unknown[]}).messages.length,Math.min(20,legacyTopicCount),'话题投影必须恰好是最近 20 条（不足 20 时是全部）')
 delete legacyInput.groupTopic
 await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[owner,legacyRun.id,JSON.stringify(legacyInput)])
 const legacyStarted=await call('task-runs/start',{runId:legacyRun.id}) as Run
 await t.test('I11 把 input_text 里的 groupTopic 整键删掉，claim() 仍然成功（在途旧行不被判损坏）',()=>{
  // 两态都算成功且都不是本条的被测面：`record()` 写的是 `mergeRunEvidence(已有证据,{state:'accepted'})`，
  // 而 `task-run-evidence.ts:19` 规定「新证据是 accepted 就保留旧的」——这一刻若运行观察循环已经
  // 把这条会话记成 `active`，回包就是 `active`。被测的是「没被判 storage-corrupt / version-conflict」。
  assert.equal(['accepted','active'].includes(legacyStarted.state),true,`旧形状的执行输入应当照常启动，实得 ${legacyStarted.state}`)
 })

 // ════════════════════ I25：teloa_group_react 的四道闸 ════════════════════
 const reactRun=legacyStarted
 const otherRoot=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'另一个话题的根消息。'}) as Message
 await awaitDecision(otherRoot.id)
 const reactAgent=agents.get(reactRun.sessionId)!
 const crossTopic=await runTool(reactAgent.agent,groupReactToolName,{messageId:otherRoot.id,emoji:'👍'})
 const beforeBadEmoji=await countOf('teloa_group_reactions')
 // 上游 `defineTool` 的参数表可能直接抛，也可能由本工具的 `authorize()` 回 isError——两条路都算「被拒」，
 // 但两条路的**理由**都必须落在入参/表情校验上：裸 catch 会把「装配坏了」也吞成一条绿。
 let badEmojiRejected=false,badEmojiReason=''
 try{
  const denied=await runTool(reactAgent.agent,groupReactToolName,{messageId:rootId,emoji:'🍌'})
  badEmojiRejected=denied.isError
  badEmojiReason=JSON.stringify(denied)
 }catch(error){badEmojiRejected=true;badEmojiReason=String((error as Error).message)}
 const afterBadEmoji=await countOf('teloa_group_reactions')
 // 合法调用不能再用 👀：路由已经替 A 在根消息上按下这一枚「收到」，
 // 而表情行的唯一键是 `(owner,message,actor_kind,actor_id,emoji)`，同一枚会被 do nothing 吞成重放，
 // 「同事的表情行带本次运行」那一条就验不到了。换一枚本话题里没人用过的。
 const good=await runTool(reactAgent.agent,groupReactToolName,{messageId:rootId,emoji:'🙏'})
 const goodRow=(await reactionsOfRoot()).find(row=>String(row.actor_id)===roleA.id&&String(row.emoji)==='🙏')
 // canPost 为假那一位：给他手工起一次群运行（准备与启动都不看 canPost，发言权在 post 与本工具这一层判）。
 const noPostTask=await call('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:rootId,expectedGroupVersion:groupA.version,goal:'验收无发言授权。',assignee:{roleId:roleNoPost.id,expectedVersion:roleNoPost.version}}) as {task:{id:string;version:number}}
 const noPostRun=await call('task-runs/prepare',{requestId:randomUUID(),taskId:noPostTask.task.id,expectedTaskVersion:noPostTask.task.version}) as Run
 await call('task-runs/start',{runId:noPostRun.id})
 const noPostDenied=await runTool(agents.get(noPostRun.sessionId)!.agent,groupReactToolName,{messageId:rootId,emoji:'👍'})
 // 第一道闸（不是群任务的运行）：要用一条**有 Run 作用域但没有 groupContext** 的普通任务运行。
 // 普通会话没有 Run 作用域，会先被任务闸按自授权那一条（「当前会话没有可核验的运行工具授权。」）拒掉，
 // 根本走不到本工具的 authorize()——那验的是任务闸，不是这一道。
 const plainTask=await call('tasks/create',{requestId:randomUUID(),fields:{title:'不是群任务','goal':'验收第一道闸',scope:'SOC'},assignee:{roleId:roleA.id,expectedVersion:roleA.version}}) as {id:string;version:number}
 const plainRun=await call('task-runs/prepare',{requestId:randomUUID(),taskId:plainTask.id,expectedTaskVersion:plainTask.version}) as Run
 await call('task-runs/start',{runId:plainRun.id})
 const ordinaryDenied=await runTool(agents.get(plainRun.sessionId)!.agent,groupReactToolName,{messageId:rootId,emoji:'👍'})
 await t.test('I25 teloa_group_react 四道闸各走一次：群运行、canPost、入参、本话题',()=>{
  assert.equal(ordinaryDenied.isError,true)
  assert.ok(JSON.stringify(ordinaryDenied).includes(reactGroupOnlyReason),`第一道闸实得 ${JSON.stringify(ordinaryDenied)}`)
  assert.equal(noPostDenied.isError,true)
  assert.ok(JSON.stringify(noPostDenied).includes(reactPostReason),`canPost 闸实得 ${JSON.stringify(noPostDenied)}`)
  assert.equal(crossTopic.isError,true)
  assert.ok(JSON.stringify(crossTopic).includes(reactTopicReason),`本话题闸实得 ${JSON.stringify(crossTopic)}`)
  assert.equal(badEmojiRejected,true,'十二枚之外的表情必须被拒')
  // 理由逐字照抄 `group-react-tool.ts:35`：只认入参/表情校验那一句，别的拒绝理由都不算这道闸过了。
  assert.match(badEmojiReason,/加表情只接受本话题里的一条群消息 id 与十二个固定表情之一。/)
  assert.equal(afterBadEmoji,beforeBadEmoji,'非法表情一行都不许打到服务端')
  assert.equal(good.isError,false,'合法调用必须放行')
  assert.ok(goodRow,'合法调用必须落一行表情')
  assert.equal(String(goodRow!.run_id),reactRun.id,'同事的表情行带本次运行')
  assert.equal(String(goodRow!.request_id),groupRoutedReactionRequestId(owner,rootId,roleA.id,'🙏'))
 })

 // ════════════════════ I24：本人 toggle 的幂等切换与聚合 ════════════════════
 const toggle=async(messageId:string,emoji:string,requestId=randomUUID())=>await call('groups/reactions/toggle',{requestId,groupId:groupA.id,messageId,emoji}) as {messageId:string;items:{emoji:string;count:number;mine:boolean;actors:{actorKind:string;actorId:string}[]}[]}
 const onceOn=await toggle(rootId,'👍')
 const offAgain=await toggle(rootId,'👍')
 const thirdRequestId=randomUUID()
 const onAgain=await toggle(rootId,'👍',thirdRequestId)
 const replayToggle=await toggle(rootId,'👍',thirdRequestId)
 const listed=await call('groups/reactions/list',{groupId:groupA.id,messageIds:[rootId]}) as {items:{emoji:string;count:number;mine:boolean;actors:{actorKind:string;actorId:string}[]}[]}
 type Summary={emoji:string;count:number;mine:boolean;actors:{actorKind:string;actorId:string}[]}
 const thumbOf=(items:Summary[])=>items.find(item=>item.emoji==='👍')
 await t.test('I24 本人 toggle 三次往返是幂等切换，同 requestId 重放不翻面；聚合带 mine/count/actors',()=>{
  assert.deepEqual(Object.keys(onceOn).sort(),['items','messageId'])
  assert.equal(thumbOf(onceOn.items)?.mine,true)
  assert.equal(thumbOf(onceOn.items)?.count,1)
  assert.equal(thumbOf(offAgain.items),undefined,'取消之后这枚表情整条消失')
  assert.equal(thumbOf(onAgain.items)?.mine,true)
  assert.deepEqual(replayToggle,onAgain,'同一 requestId 重放原样回当前聚合，不再翻面')
  const thumb=thumbOf(listed.items)
  assert.equal(thumb?.mine,true)
  assert.equal(thumb?.count,1)
  assert.deepEqual(thumb?.actors,[{actorKind:'self',actorId:'self'}])
  const eyes=listed.items.find(item=>item.emoji==='👀')
  assert.equal(eyes?.mine,false,'同事那一枚不算本人')
  assert.deepEqual(eyes?.actors,[{actorKind:'role',actorId:roleA.id}])
 })

 // ════════════════════ I26：路由表情落表、决策表只追加、岗位会话、错误码 ════════════════════
 const reactionText='路由表情验收：只加表情不派人。'
 answers.set(reactionText,answerOf([],[{roleId:roleB.id,emoji:'🎉'}]))
 const reactionMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:reactionText}) as Message
 const reactionDecision=await awaitDecision(reactionMessage.id)
 const routedReaction=(await pool.query('select actor_kind,actor_id,emoji,run_id,request_id from teloa_group_reactions where owner_id=$1 and message_id=$2',[owner,reactionMessage.id])).rows
 const noPostReactionText='路由表情验收：模型硬给没有发言权的那位加表情。'
 answers.set(noPostReactionText,answerOf([],[{roleId:roleNoPost.id,emoji:'🎉'}]))
 const noPostReactionMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:noPostReactionText}) as Message
 const noPostReactionDecision=await awaitDecision(noPostReactionMessage.id)
 const noPostReactionRows=(await pool.query('select 1 from teloa_group_reactions where owner_id=$1 and message_id=$2',[owner,noPostReactionMessage.id])).rows
 await t.test('I26（一）路由 reactions 直接落表：run_id 为空；不在候选集里的那位整条被拒',()=>{
  assert.deepEqual(reactionDecision.reactions,[{roleId:roleB.id,emoji:'🎉'}])
  assert.equal(routedReaction.length,1)
  assert.equal(String(routedReaction[0]!.actor_kind),'role')
  assert.equal(String(routedReaction[0]!.actor_id),roleB.id)
  assert.equal(routedReaction[0]!.run_id,null,'路由表情不绑任何一次运行')
  assert.equal(String(routedReaction[0]!.request_id),groupRoutedReactionRequestId(owner,reactionMessage.id,roleB.id,'🎉'))
  assert.equal(noPostReactionDecision.kind,'parse-failed','没有发言权的那位不在候选集，整条输出被拒')
  assert.deepEqual(noPostReactionRows,[],'被拒的那一轮一行表情都不许落表')
 })
 // 捕获之后要核错误内容：裸 catch 会把「连不上库」「表名写错」一并算成「被挡住了」。
 // 挡住它的是 `group-routing-decisions.ts:26` 那条 plpgsql 触发器，报文逐字带 `append-only`。
 let decisionUpdateError='',decisionDeleteError=''
 try{await pool.query('update teloa_group_routing_decisions set created_at=now() where owner_id=$1 and message_id=$2',[owner,rootId])}catch(error){decisionUpdateError=String((error as Error).message)}
 try{await pool.query('delete from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,rootId])}catch(error){decisionDeleteError=String((error as Error).message)}
 const decisionsAfterTamper=await countOf('teloa_group_routing_decisions')
 const decisionStillThere=await decisionRow(rootId)
 await t.test('I26（二）决策表只追加：update 与 delete 都被 DB 的 append-only 触发器挡住',()=>{
  assert.match(decisionUpdateError,/rows are append-only/)
  assert.match(decisionDeleteError,/rows are append-only/)
  assert.ok(decisionStillThere,'被挡住的那两条改写不许动到已落库的决策行')
  assert.equal(decisionsAfterTamper>0,true)
 })
 const routingView=await call('groups/routing/list',{groupId:groupA.id,messageIds:[rootId,reactionMessage.id]}) as {items:Record<string,unknown>[]}
 await t.test('I26（三）groups/routing/list 只回四键，不透 candidateIds / reactions / stopMessageId',()=>{
  assert.ok(routingView.items.length>=2)
  for(const item of routingView.items){
   assert.deepEqual(Object.keys(item).sort(),['hops','kind','messageId','respond'])
   assert.equal('candidateIds' in item,false)
   assert.equal('stopMessageId' in item,false)
   assert.equal('reactions' in item,false)
  }
 })
 const retired=await hire('已退役同事','SOC')
 await call('roles/lifecycle',{roleId:retired.id,expectedVersion:retired.version,action:'pause',reason:'准备退役'})
 const pausedRetired=((await call('roles/list',{})) as Role[]).find(item=>item.id===retired.id)!
 await call('roles/lifecycle',{roleId:pausedRetired.id,expectedVersion:pausedRetired.version,action:'retire',reason:'验收退役分支'})
 // 这一条的调用收在子用例里：`conversations/create` 的 roleId 支线若在宿主侧没有接线，
 // 只该红这一条，不该把它后面的错误码核对一起带走。
 await t.test('I26（四）conversations/create 带 roleId 的六条：用岗位预设、退役与非本人 forbidden、同 requestId 换岗位 conflict',async()=>{
  const sharedRequestId=randomUUID()
  const badUuid=await refuse('conversations/create',{requestId:randomUUID(),title:'岗位会话',roleId:'not-a-uuid'})
  const unknownKey=await refuse('conversations/create',{requestId:randomUUID(),title:'岗位会话',presetId:teloaAgentPresetId})
  assert.equal(badUuid.code,'teloa/invalid-input')
  assert.equal(unknownKey.code,'teloa/invalid-input')
  const roleConversation=await call('conversations/create',{requestId:sharedRequestId,title:'岗位会话',roleId:roleA.id}) as {sessionId:string}
  assert.equal(presets.get(roleConversation.sessionId),teloaAgentPresetId,'带 roleId 的新建会话要用该岗位的运行配置')
  assert.equal('roleId' in roleConversation,false,'回包零新键')
  const swapped=await refuse('conversations/create',{requestId:sharedRequestId,title:'岗位会话',roleId:roleB.id})
  const retiredRefusal=await refuse('conversations/create',{requestId:randomUUID(),title:'岗位会话',roleId:retired.id})
  const strangerRefusal=await refuse('conversations/create',{requestId:randomUUID(),title:'岗位会话',roleId:randomUUID()})
  assert.equal(swapped.code,'teloa/conflict')
  assert.equal(retiredRefusal.code,'teloa/forbidden')
  assert.equal(strangerRefusal.code,'teloa/forbidden')
 })

 // ════════════════════ M4：群内回帖每次现读授权（group-run-messages.ts:167-171）════════════════════
 // 「能不能回帖」不是在 prepare/start 时一次性判完的：`post()` 每写一条群消息都重读一遍群上下文与授权行。
 // 两条都用**主链上真的跑着的那两次运行**收口，不另造替身。
 // 后台运行观察循环（每 2 秒一趟）也会 reconcile 在途运行：它若恰在「补终轮」与本用例的 reconcile 之间
 // 捡到这条运行，同一次回帖就会被两处各试一次、各留一行拒绝。所以不数总行数，而是逐段数：
 // 本用例自己那一次 reconcile 回 ended 就一定调过发布器（`task-run-driver.ts` 两条 ended 分支都发），
 // 这一段里至少多出一行拒绝、且每一行的码都落在授权/版本三码里。
 const refusalsBeforePost=postRefusals().length
 // (a) 从头就没有发言权的那位：I25 里已经准备并启动，这里让它把话说完再对账。
 const noPostReplyText='我来回一句。'
 await finishRun(noPostRun.sessionId,noPostReplyText)
 const noPostReconciled=await call('task-runs/reconcile',{runId:noPostRun.id}) as Run
 const noPostRefusals=postRefusals().slice(refusalsBeforePost)
 const noPostReplyRows=(await pool.query('select 1 from teloa_group_messages where owner_id=$1 and author_id=$2',[owner,roleNoPost.id])).rows
 // (b) 运行在途才被撤授权的那位：M11 那一段起的运行一直没结项，正好是一次真的在途运行。
 const revokedReplyText='授权撤掉之后我还想说一句。'
 await call('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:roleA.id,expectedGroupVersion:groupA.version,expectedRoleVersion:roleA.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const refusalsBeforeRevoked=postRefusals().length
 await finishRun(windowRun.sessionId,revokedReplyText)
 const revokedReconciled=await call('task-runs/reconcile',{runId:windowRun.id}) as Run
 const revokedRefusals=postRefusals().slice(refusalsBeforeRevoked)
 const revokedReplyRows=(await topicRows(rootId)).filter(row=>String(row.text)===revokedReplyText)
 await t.test('M4 回帖闸：没有发言权的那位与运行在途被撤授权的那位，都写不进一条群消息',()=>{
  assert.deepEqual(noPostReplyRows,[],'canPost 为假的岗位一条群消息都不许落库')
  assert.deepEqual(revokedReplyRows,[],'运行在途被撤授权之后，这一轮的回帖也发不出去')
  // 两次都必须走「授权判据挡住」那一支（`task-run-group-publisher.ts:35-38`）而不是静悄悄没跑：
  // 那一支会留一行 `Teloa 同事群内回传未写入：<码>`，码只允许是授权/版本那三个之一。
  assert.deepEqual([noPostReconciled.state,revokedReconciled.state],['ended','ended'],'两次 reconcile 都必须真的收口，发布器才一定被调到')
  for(const [label,refusals] of [['没有发言权的那位',noPostRefusals],['运行在途被撤授权的那位',revokedRefusals]] as const){
   assert.ok(refusals.length>=1,`${label}的回帖该留至少一行「群内回传未写入」，实得 ${JSON.stringify(refusals)}`)
   for(const line of refusals)assert.match(line,/teloa\/(forbidden|conflict|version-conflict)/)
  }
 })

 // ════════════════════ 通用范围任务里同事读岗位自己声明的知识（2026-09-21 裁定的接缝）════════════════════
 // 通用群不绑业务数据，岗位知识本就是岗位自身范围内已获准的资料，因此通用范围任务的主体范围取
 // 「general ∪ 岗位范围」。这条要同时守住 prepare 与 start：start 前的复核走的是另一条读口，
 // 它若还按任务范围读，准备得起来的运行会在 start 前被判 forbidden，群里同样静默。
 const sourceRefs=await call('resources/sources',{}) as {id:string;version:string}[]
 const knowledgeSource=sourceRefs[0]!
 const knowledgeDraft=await call('resources/create',{requestId:randomUUID(),title:'SOC 范围的岗位资料',sourceId:knowledgeSource.id,sourceVersion:knowledgeSource.version,scopeIds:['SOC']}) as {id:string;version:number}
 const scopedResource=await call('resources/apply',{draftId:knowledgeDraft.id,expectedVersion:knowledgeDraft.version}) as {id:string;version:number;scopeIds:string[]}
 const scopedRole=await call('roles/create',{requestId:randomUUID(),fields:{
  name:'通用群里的SOC同事',kind:'employee' as const,scopes:['SOC'],duty:'在通用群里按自己的资料回答',dataScope:'群内消息',executionScope:'只做回答与说明',skills:[],knowledge:[scopedResource.id],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:teloaAgentPresetId},
 }}) as Role
 const generalGroup=await call('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'通用工作群',scope:'general',announcement:'验收通用范围任务读岗位知识。',rules,memberRoleIds:[scopedRole.id]}}) as Group
 const generalMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:generalGroup.id,expectedVersion:generalGroup.version,text:'通用群里的一条消息。'}) as Message
 // 这条消息的路由答案没预置，按 emptyAnswer 判「谁都不用回」：本段要的是**手工建的**那条群任务，
 // 但仍要等它的决策行落库，免得 fire-and-forget 的那一趟拖到用例收尾之后。
 await awaitDecision(generalMessage.id)
 const generalTask=await call('groups/tasks/create',{requestId:randomUUID(),groupId:generalGroup.id,messageId:generalMessage.id,expectedGroupVersion:generalGroup.version,goal:'在通用群里读岗位资料后回应。',assignee:{roleId:scopedRole.id,expectedVersion:scopedRole.version}}) as {task:{id:string;version:number;scope:string}}
 const generalRun=await call('task-runs/prepare',{requestId:randomUUID(),taskId:generalTask.task.id,expectedTaskVersion:generalTask.task.version}) as Run&{knowledge:{id:string;scopeIds:string[]}[]}
 const generalStarted=await call('task-runs/start',{runId:generalRun.id}) as Run
 const scopedEndpoints=['resources/create','resources/apply','roles/create','groups/tasks/create','task-runs/prepare','task-runs/start'],failuresBefore=failures.length
 await t.test('通用范围群任务：SOC 岗位声明的 SOC 资料真的读得到，prepare 与 start 都不判 forbidden',()=>{
  assert.equal(generalTask.task.scope,'general','群任务的范围跟群走，这一条必须是通用范围')
  assert.deepEqual(scopedResource.scopeIds,['SOC'],'夹具资料必须是 SOC 范围，否则这条守不住任何东西')
  assert.deepEqual(generalRun.knowledge.map(item=>[item.id,item.scopeIds]),[[scopedResource.id,['SOC']]],'运行快照里必须固定这份 SOC 资料')
  assert.notEqual(generalStarted.state,'prepared','start 必须真的把运行推过 prepared')
  assert.deepEqual(failures.slice(failuresBefore).filter(failure=>scopedEndpoints.includes(failure.endpoint)),[],'这一段任何一个端点都不该被拒')
 })

 // ════════════════════ 错误码账本的跨端点取样（I26（五）的被测面）════════════════════
 // 账本只有在「主链上真的被拒过好几种请求」时才有区分力：这里在四个不同端点上各制造一次真实拒绝，
 // 四条都走真 handler、真服务、真库，不是为了凑数另起的假请求。
 const staleSend=await refuse('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version+1,text:'群版本过期的一条消息。'})
 const staleGrant=await refuse('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:roleB.id,expectedGroupVersion:groupA.version,expectedRoleVersion:roleB.version+1,action:'save',resources:[],canPost:true,canAutoRun:true})
 const badEmojiToggle=await refuse('groups/reactions/toggle',{requestId:randomUUID(),groupId:groupA.id,messageId:rootId,emoji:'🍌'})
 const foreignMessage=await call('groups/messages/send',{requestId:randomUUID(),groupId:groupTwo.id,expectedVersion:groupTwoV3.version,text:'别的群的一条消息。'}) as Message
 const crossGroupTask=await refuse('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:foreignMessage.id,expectedGroupVersion:groupA.version,goal:'指向别群的消息。',assignee:{roleId:roleB.id,expectedVersion:roleB.version}})
 await t.test('跨端点被拒取样：群版本过期、岗位版本过期、表情不在十二枚、群任务指向别群的消息',()=>{
  assert.equal(staleSend.code,'teloa/version-conflict')
  assert.equal(staleGrant.code,'teloa/version-conflict')
  assert.equal(badEmojiToggle.code,'teloa/invalid-input')
  assert.equal(crossGroupTask.code,'teloa/forbidden')
 })

 const finalColleagueRows=await colleagueRows()
 await t.test('I26（五）全程只用八个正式码加既有位置码，且没有一个带 details',t26=>{
  assert.ok(failures.length>0,'全链路必须至少观察到一个被拒请求')
  t26.diagnostic('全链路观察到的被拒请求：'+failures.map(failure=>`${failure.endpoint}=${failure.code}`).join('、'))
  for(const failure of failures){
   assert.ok((workErrorCodes as readonly string[]).includes(failure.code),`${failure.endpoint} 用了登记外的码 ${failure.code}`)
   // `details` 允许整键不在（`WorkError` 不带它时回包里就没有这个键）；带了就必须是空对象。
   assert.equal(failure.details===undefined||Object.keys(failure.details as object).length===0,true,`${failure.endpoint} 的 ${failure.code} 不得带 details`)
   assert.ok(officialCodes.includes(failure.code)||positionCodes.includes(failure.code),`不在正式码也不在既有位置码：${failure.code}`)
  }
  // 账本本身要有取样广度，否则「八个正式码」这条只是在一两个端点上打转。
  assert.ok(new Set(failures.map(failure=>failure.endpoint)).size>=5,`被拒端点太少：${[...new Set(failures.map(failure=>failure.endpoint))].join('、')}`)
  assert.ok(new Set(failures.map(failure=>failure.code)).size>=4,`被拒错误码太少：${[...new Set(failures.map(failure=>failure.code))].join('、')}`)
  // 全链路跑完再核一次：任何一条同事消息行都不许被写进 @ 快照（服务端不解析正文里的 @）。
  for(const row of finalColleagueRows)assert.deepEqual(row.mention_snapshot,[],'服务端绝不把 @ 写进同事消息行')
 })
})
