import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {homedir} from 'node:os'
import test from 'node:test'
import {host,type RpcHandler} from './fixtures/production-host.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {createSecurityEndpointIsolateDefinition,initializePlanOccurrences,initializeResources,initializeRoles,initializeTaskRuns,initializeTasks,openResourceDatabase,SecurityApprovalService,SecurityActionExecutionService,SecurityRequestJournal} from '@teloa/backend'
import {apply} from '../src/index.ts'
import {readSecurityActionPanel} from '@teloa/contract'

const ownerId='local:teloa-owner'
const principal={ownerId,approverId:ownerId,scopeIds:['SOC']}

function page(){
  const item={
    scope:'SOC',type:'alert',id:'evt-production-wiring',version:1,title:'prod-03 异常脚本',source:'EDR',
    observedAt:'2026-09-13T01:00:00.000Z',receivedAt:'2026-09-13T01:00:01.000Z',quality:'complete',summary:'调查异常外联。',
    fields:[{label:'资产',value:'prod-03'}],
  }
  return {schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:'2026-09-13T01:00:02.000Z',items:[item]}
}

async function source(){
  const server=createServer((_request,response)=>{
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify(page()))
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const address=server.address()
  assert.ok(address&&typeof address==='object')
  return {
    url:`http://127.0.0.1:${address.port}/alerts`,
    close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))},
  }
}


async function call(rpc:RpcHandler,endpoint:string,payload:unknown){
  const reply=await rpc(endpoint,payload,new AbortController().signal)
  assert.equal(reply.ok,true,`RPC ${endpoint} 失败：${JSON.stringify(reply.error)}`)
  if(reply.receipt){
    assert.equal(reply.receipt.requestId,Reflect.get(payload as object,'requestId').toLowerCase())
    const ack=await rpc('requests/pending/ack',{requestId:reply.receipt.requestId},new AbortController().signal)
    assert.equal(ack.ok,true,'只有收到业务成功回包后才确认目录')
    assert.equal(ack.receipt,undefined,'确认请求不能再要求递归确认')
  }
  return reply.value
}

async function action(rpc:RpcHandler,task:{id:string;version:number}){
  const proposalRequestId=randomUUID()
  const lostProposal=await rpc('security-actions/propose',{requestId:proposalRequestId,taskId:task.id,expectedTaskVersion:task.version,title:'隔离 prod-03',goal:'阻断异常外联',tool:'security.endpoint.isolate',targetSet:['prod-03'],params:{reason:'已核对异常进程'}},new AbortController().signal)
  assert.equal(lostProposal.ok,true)
  assert.deepEqual(lostProposal.receipt,{requestId:proposalRequestId})
  // 提案写入已成功但未把响应交给第一浏览器，第二浏览器必须还能列出原请求。
  const pending=await call(rpc,'requests/pending/list',{}) as Array<{requestId:string;endpoint:string}>
  assert.ok(pending.some(row=>row.requestId===proposalRequestId&&row.endpoint==='security-actions/propose'))
  const recovered=await rpc('requests/pending/recover',{requestId:proposalRequestId},new AbortController().signal)
  assert.equal(recovered.ok,true)
  assert.equal(recovered.receipt,undefined)
  assert.deepEqual(recovered.value,lostProposal.value)
  const proposed=recovered.value as {id:string;version:number}
  const proposals=readSecurityActionPanel(await call(rpc,'security-actions/list',{taskId:task.id}))
  assert.equal(proposals.actions.length,1,'恢复安全提案不能新增第二条提案')
  assert.equal(proposals.actions[0]?.id,proposed.id)
  await call(rpc,'requests/pending/ack',{requestId:proposalRequestId})
  assert.equal((await call(rpc,'requests/pending/list',{}) as Array<{requestId:string}>).some(row=>row.requestId===proposalRequestId),false)
  const submitted=await call(rpc,'security-actions/submit',{requestId:randomUUID(),actionId:proposed.id,expectedActionVersion:proposed.version}) as {id:string;version:number}
  await call(rpc,'security-actions/decide',{requestId:randomUUID(),actionId:submitted.id,expectedActionVersion:submitted.version,decision:'approved',reason:'已核对生产影响',impactConfirmed:true})
  return call(rpc,'security-actions/get',{actionId:proposed.id}) as Promise<{id:string;version:number}>
}

test('production apply 以真实 Context、临时 PG 与实际 /teloa handler 接通安全动作，未配置执行零写且二次初始化幂等',{timeout:180_000},async t=>{
  const previousUrl=process.env.TELOA_SECURITY_ACTION_URL,previousToken=process.env.TELOA_SECURITY_ACTION_TOKEN
  delete process.env.TELOA_SECURITY_ACTION_URL;delete process.env.TELOA_SECURITY_ACTION_TOKEN
  // apply() 的装配期复验现在还核对 TELOA_PROJECT_ROOT 真正解析到哪个 Agent 预设根
  // （见 composition-safety.ts 的 pinnedPresetRoot）；真实启动器总会注入它，这里直接调用
  // apply() 绕过了启动器，补上同一个变量，值与本仓库检出一致（本测试用的临时 projectRoot
  // 只影响运行目录与 profile 清单，预设根仍固定指向仓库内那一份）。
  const previousProjectRoot=process.env.TELOA_PROJECT_ROOT
  process.env.TELOA_PROJECT_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..')
  t.after(()=>{
    if(previousUrl===undefined)delete process.env.TELOA_SECURITY_ACTION_URL;else process.env.TELOA_SECURITY_ACTION_URL=previousUrl
    if(previousToken===undefined)delete process.env.TELOA_SECURITY_ACTION_TOKEN;else process.env.TELOA_SECURITY_ACTION_TOKEN=previousToken
    if(previousProjectRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousProjectRoot
  })
  // 受管目录逐层拒绝符号链接；macOS 的 /var/tmp 恰有系统链接，临时根放在工作树内。
  const root=await mkdtemp(join(process.cwd(),'.tmp-security-wiring-'))
  // testcontainers 不读取 docker context；本机 OrbStack 的 CLI socket 需要显式给它。
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
  const connectionString=container.getConnectionUri(),alerts=await source(),runtime=host()
  await mkdir(join(root,'.runtime/teloa'),{recursive:true,mode:0o700})
  const config=join(root,'.runtime/teloa/database.json')
  await writeFile(config,JSON.stringify({connectionString}),{mode:0o600})
  await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true,mode:0o700})
  const database=await openResourceDatabase(config,{id:randomUUID,now:()=> '2026-09-13T01:00:00.000Z'}),db=database.pool
  // 宿主既有岗位生命周期依赖 tasks；功能验证 的 production 接线从这份既有数据库基线继续。
  await initializeRoles(db)
  await initializeTasks(db)
  await initializeResources(db)
  await initializePlanOccurrences(db)
  await initializeTaskRuns(db)
  t.after(async()=>{
    await runtime.ctx.fiber.dispose()
    await alerts.close()
    await db.end()
    await container.stop()
    await rm(root,{recursive:true,force:true})
  })
  await writeFile(join(root,'.runtime/teloa/security-alert-source.json'),JSON.stringify({url:alerts.url}),{mode:0o600})
  // 装配期的组合安全钉复验还要读 profile 清单里的 patchReload；测试根下建一份最小清单。
  await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true,mode:0o700})
  await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}),{mode:0o600})

  // 目标 API：测试根不能碰开发宿主的 .runtime，且重复挂载必须重用同一份持久初始化。
  await runtime.ready(join(root,'.runtime/dsh'))
  await apply(runtime.ctx,{projectRoot:root})
  await apply(runtime.ctx,{projectRoot:root})
  const rpc=runtime.rpc
  assert.ok(runtime.tools.length>0,'production apply 必须实际调用 tools.register')
  assert.equal(runtime.tools.some(value=>Reflect.get(value as object,'name')==='teloa_security_execute_approved_action'),false)

  // 工作区设置仍可登记仓库根，但拿它开会话会把沙箱写范围与原生终端一起放回仓库里。
  const repositoryWorkspace=await runtime.ctx.workspaceRegistry.create(root,'仓库根')
  const rejected=await rpc('conversations/create',{requestId:randomUUID(),title:'不该建起来的会话',workspaceId:repositoryWorkspace.id},new AbortController().signal)
  assert.equal(rejected.ok,false,'覆盖仓库的工作区不能用于新建会话')
  assert.equal(rejected.error?.code,'teloa/forbidden')
  // 专用工作区照旧可用：收敛的是仓库根及其祖先，不是整个工作区设置。
  const ordinary=await call(rpc,'conversations/create',{requestId:randomUUID(),title:'专用工作区会话'}) as {status:string}
  assert.equal(ordinary.status,'ready')

  const data=await call(rpc,'business-data/query',{scope:'SOC',limit:1}) as {items:Array<Record<string,unknown>>}
  const item=data.items[0]
  assert.ok(item)
  // 实际 handler 已提交，但第一浏览器丢弃成功回包而不发送 ack；第二浏览器仅凭目录 requestId 恢复。
  // 两条都走真实事务和幂等账本，不连接外部模型或厂商。
  for(const [endpoint,body] of [
    ['tasks/create',{fields:{title:'普通任务回包恢复',goal:'验证固定请求只创建一次',scope:'general'}}],
    ['business-tasks/create',{reference:{scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash},goal:'验证业务依据任务回包恢复'}],
  ] as const){
    const requestId=randomUUID(),payload={requestId,...body}
    const lostReply=await rpc(endpoint,payload,new AbortController().signal)
    assert.equal(lostReply.ok,true)
    assert.deepEqual(lostReply.receipt,{requestId})
    const secondBrowserList=await call(rpc,'requests/pending/list',{}) as Array<{requestId:string;endpoint:string}>
    assert.deepEqual(secondBrowserList.map(row=>[row.requestId,row.endpoint]),[[requestId,endpoint]])
    const recoveredReply=await rpc('requests/pending/recover',{requestId},new AbortController().signal)
    assert.equal(recoveredReply.ok,true)
    assert.equal(recoveredReply.receipt,undefined,'恢复入口沿用显式确认，不和自动 transport 确认重复')
    assert.deepEqual(recoveredReply.value,lostReply.value)
    const count=await db.query('select count(*)::int count from teloa_tasks where owner_id=$1 and request_id=$2',[ownerId,requestId])
    assert.equal(count.rows[0]?.count,1,'跨浏览器重放不能重复创建任务')
    // 第一次 ack 在服务端完成但回包丢失，重复同一 ack 仍成功。
    const lostAck=await rpc('requests/pending/ack',{requestId},new AbortController().signal)
    assert.equal(lostAck.ok,true)
    await call(rpc,'requests/pending/ack',{requestId})
    assert.deepEqual(await call(rpc,'requests/pending/list',{}),[])
  }

  const taskRecord=await call(rpc,'business-tasks/create',{
    requestId:randomUUID(),
    reference:{scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash},
    goal:'核对生产资产风险',
  }) as {task:{id:string;version:number}}

  const panel=readSecurityActionPanel(await call(rpc,'security-actions/list',{taskId:taskRecord.task.id}))
  assert.deepEqual(panel.proposal.tools,[{tool:'security.endpoint.isolate',allowedTargets:['prod-03']}])
  assert.deepEqual(await call(rpc,'security-actions/attention',{}),[])

  const approved=await action(rpc,taskRecord.task)
  const before=await db.query("select (select count(*) from teloa_security_action_executions where owner_id=$1) as executions, (select count(*) from teloa_security_action_execution_audit where owner_id=$1) as audit",[ownerId])
  const executeRequestId=randomUUID(),execute=await rpc('security-actions/execute',{requestId:executeRequestId,actionId:approved.id,expectedActionVersion:approved.version},new AbortController().signal)
  assert.equal(execute.ok,false)
  assert.equal(execute.error?.code,'teloa/dependency-unavailable')
  // 服务端已收到、但执行依赖尚不可用的命令必须能跨浏览器列出；目录不泄露原始 actionId 或参数。
  const pending=await call(rpc,'requests/pending/list',{}) as Array<Record<string,unknown>>
  assert.deepEqual(pending.map(row=>Object.keys(row).sort()),[['createdAt','endpoint','requestId','updatedAt']])
  assert.equal(pending[0]?.requestId,executeRequestId)
  assert.equal(pending[0]?.endpoint,'security-actions/execute')
  const forgedRecover=await rpc('requests/pending/recover',{requestId:executeRequestId,endpoint:'roles/create'},new AbortController().signal)
  assert.equal(forgedRecover.ok,false)
  assert.equal(forgedRecover.error?.code,'teloa/invalid-input')
  const recovered=await rpc('requests/pending/recover',{requestId:executeRequestId},new AbortController().signal)
  assert.equal(recovered.ok,false)
  assert.equal(recovered.error?.code,'teloa/dependency-unavailable')
  assert.equal((await call(rpc,'requests/pending/list',{} ) as unknown[]).length,1)
  const after=await db.query("select (select count(*) from teloa_security_action_executions where owner_id=$1) as executions, (select count(*) from teloa_security_action_execution_audit where owner_id=$1) as audit",[ownerId])
  assert.deepEqual(after.rows,before.rows,'默认未配置 adapter 必须在 claim 前退出，执行与审计均不得写入')

  const catalog={require(tool:string){if(tool!=='security.endpoint.isolate')throw Error('unexpected tool');return createSecurityEndpointIsolateDefinition()}}
  const identity={id:randomUUID,now:()=>new Date().toISOString()},journal=new SecurityRequestJournal(db),approvals=new SecurityApprovalService(db,identity,catalog,journal),executions=new SecurityActionExecutionService(db,identity,approvals,journal)
  const claimed=await executions.claim(principal,{requestId:randomUUID(),actionId:approved.id,expectedActionVersion:approved.version})
  await executions.recordEffect(principal,{operationId:claimed.execution.operationId,receipt:{status:'failed',receiptId:'failed-in-wiring',detail:'目标隔离失败',observedAt:identity.now(),targets:[{target:'prod-03',state:'failed'}]}})
  assert.deepEqual(await call(rpc,'security-actions/attention',{}),[{taskId:taskRecord.task.id,actionId:approved.id,kind:'security-action',reason:'execution-failed'}])
  const failed=await call(rpc,'security-actions/get',{actionId:approved.id}) as {id:string;version:number;state:string}
  assert.equal(failed.state,'failed')
  assert.deepEqual(await call(rpc,'security-actions/acknowledge-failure',{requestId:randomUUID(),actionId:failed.id,expectedActionVersion:failed.version}),failed)
  assert.deepEqual(await call(rpc,'security-actions/attention',{}),[])

  await runtime.ctx.fiber.dispose()
  const restarted=host()
  try{
    await restarted.ready(join(root,'.runtime/dsh'))
    await apply(restarted.ctx,{projectRoot:root})
    const restored=readSecurityActionPanel(await call(restarted.rpc,'security-actions/list',{taskId:taskRecord.task.id}))
    assert.equal(restored.actions.length,1);assert.equal(restored.actions[0]?.id,failed.id);assert.equal(restored.actions[0]?.state,'failed')
    assert.deepEqual(await call(restarted.rpc,'security-actions/attention',{}),[])
    assert.equal(restarted.tools.some(value=>Reflect.get(value as object,'name')==='teloa_security_execute_approved_action'),false)
  }finally{await restarted.ctx.fiber.dispose()}

  // 装配处的业务依据闭包：`general` 必须在问业务服务之前就按"没有业务依据"收口。
  // 业务身份闸明确拒绝 general，直接把 scopeIds:[task.scope] 交给业务服务会让整次执行准备
  // 以 teloa/forbidden 中断——隔离宿主上表现为计划到点建了任务却永远产生不出 Run。
  // 这一段必须走真实装配：只测抽出来的判据函数，接线改回旧写法时不会变红。
  const runtimeHost=host({agents:true})
  try{
    await runtimeHost.ready(join(root,'.runtime/dsh'))
    await apply(runtimeHost.ctx,{projectRoot:root})
    const rpc2=runtimeHost.rpc
    const role=await call(rpc2,'roles/create',{requestId:randomUUID(),fields:{
      name:'通用调查岗',kind:'employee',scopes:['general'],duty:'查证据并代拟',dataScope:'只读',executionScope:'代拟',
      skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},
      runtimeConfig:{agentPresetId:'general-analyst'},
    }}) as {id:string}
    // 岗位要在效才能承接执行；生命周期接口之外的最短路径就是直接落库，与后端用例同一做法。
    await db.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
    const task=await call(rpc2,'tasks/create',{requestId:randomUUID(),fields:{title:'通用调查',goal:'核对一份材料',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}}) as {id:string;version:number}
    // 使用正式的一键准备入口，让固定预设在新建专属会话时写入；不能原地改写普通会话的预设。
    const run=await call(rpc2,'task-runs/prepare',{
      requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,
    }) as {state:string;inputText:string}
    assert.equal(run.state,'prepared','通用工作范围的任务必须能准备出执行记录')
    assert.equal(Object.hasOwn(JSON.parse(run.inputText),'businessContext'),false,'通用工作的执行输入不得带业务对象依据')
  }finally{await runtimeHost.ctx.fiber.dispose()}
})
