import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from './runtime/native-runtime.mjs'
import {prepareRuntimeProfile} from './runtime/profile.mjs'

// 群聊连续协作真实路径（规格 §9）：隔离 PG、原生宿主子进程、本人私有 BYOK、无头浏览器；不向既有实例发请求，不输出凭据。
// 骨架与 验收业务行动草稿.mjs 相同。群任务只可使用本轮受限业务草稿授权，不能扩大本人业务权限，
// 群发起工作的原生审批走原 Run 会话里的官方 approval：本人从群消息状态进入原工作，允许一次或拒绝，结果回到原群。
const options={}
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i]
 if(!['--credentials-file','--output','--playwright-module','--from-step'].includes(key)||!process.argv[i+1]||options[key])throw Error('参数：--credentials-file <本人私有JSON> --output <证据目录> [--playwright-module <已有模块package.json>]')
 options[key]=process.argv[++i]
}
if(!options['--credentials-file']||!options['--output'])throw Error('须明确提供本人私有凭据和证据目录。')
const fromStep=Number(options['--from-step']??1)
if(![1,8,9,10,11].includes(fromStep))throw Error('--from-step 仅支持 1（完整路径）、8（审批、交接与恢复）、9（业务修改审批）、10（文件交接、预览与恢复）或 11（强退与冷重启）。')
const credentialFile=resolve(options['--credentials-file']),info=await lstat(credentialFile)
if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw Error('本人凭据须为私有普通文件。')
const credentials=JSON.parse(await readFile(credentialFile,'utf8'))
if(typeof credentials.deepseek!=='string'||!credentials.deepseek.trim())throw Error('未提供可用 DeepSeek 凭据。')
const secrets=Object.values(credentials).filter(value=>typeof value==='string'&&value.length>5)
const scrub=value=>{
 let text=String(value instanceof Error?value.message:value)
 for(const secret of secrets)text=text.split(secret).join('[凭据]')
 return text.replace(/([?&]token=)[^\s"']+/g,'$1[授权]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[隔离数据库]')
}
const programRoot=dirname(dirname(fileURLToPath(import.meta.url))),output=resolve(options['--output'])
await mkdir(output,{recursive:true,mode:0o700})
const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-group-continuity-')))
const layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'group-'+randomUUID()}
const result={status:'preparing',provider:'deepseek-official',fixtureModel:false,fromStep,checks:[],messages:{}}
const owner='local:teloa-owner'
const pushCheck=result.checks.push.bind(result.checks)
result.checks.push=(...checks)=>{console.log('已通过：'+checks.join('、'));return pushCheck(...checks)}
let pool,container,browser,page,worker,workerExited,failure
const until=async(label,read,ready,timeout=180000)=>{
 const deadline=Date.now()+timeout
 for(;;){const value=await read();if(ready(value))return value;if(Date.now()>deadline)throw Error(label+'超时');await new Promise(done=>setTimeout(done,500))}
}
const stopWorker=async()=>{
 if(!worker||worker.exitCode!==null||worker.signalCode!==null)return
 if(worker.connected)worker.send({kind:'stop'},()=>{})
 let timer
 const stopped=await Promise.race([workerExited,new Promise(done=>{timer=setTimeout(()=>done(false),15000)})]);clearTimeout(timer)
 if(stopped===false){worker.kill('SIGTERM');await workerExited}
}
try{
 for(const path of [layout.runtimeRoot,layout.workspaceRoot,layout.dshHome])await mkdir(path,{recursive:true,mode:0o700})
 Object.assign(process.env,{DSH_HOME:layout.dshHome,TELOA_DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot,TELOA_DSH_PROFILE:layout.profileName,TELOA_USAGE_STATS:'off',TELOA_MARKET_REMOTE:'off',TELOA_CREDENTIALS_STORE:'file',TELOA_CREDENTIALS_KEY_FILE:join(root,'credentials-key'),DEEPSEEK_API_KEY:credentials.deepseek})
 await writeFile(process.env.TELOA_CREDENTIALS_KEY_FILE,randomBytes(32).toString('hex')+'\n',{mode:0o600})
 if(process.platform==='darwin'&&!process.env.DOCKER_HOST){process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'}
 installNativeRuntime(await prepareNativeRuntime({programRoot,runtimeRoot:layout.runtimeRoot}))
 const require=createRequire(join(programRoot,'packages/backend/package.json')),{Pool}=require('pg'),{PostgreSqlContainer}=require('@testcontainers/postgresql')
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();pool=new Pool({connectionString:container.getConnectionUri()})
 const backend=await import('../packages/backend/src/index.ts'),identity={id:randomUUID,now:()=>new Date().toISOString()}
 await backend.initializeTeloaDatabase(pool,{businessSqlSecretPath:join(root,'sql-role')})
 await writeFile(join(layout.runtimeRoot,'database.json'),JSON.stringify({connectionString:container.getConnectionUri()})+'\n',{mode:0o600})
 await prepareRuntimeProfile(layout)
 const sdkRequire=createRequire(createRequire(join(programRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')),sdk=await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
 const profileDir=join(layout.dshHome,'profiles',layout.profileName),profile=sdk.loadProfileDirectory('dsh',profileDir,sdkRequire.resolve('@deepseek-ai/dsh/package.json'))
 const context={name:layout.profileName,dir:profile.dir,patchPath:profile.patchPath,installAnchor:sdkRequire.resolve('@deepseek-ai/dsh/package.json'),startedBundles:profile.layers.map(layer=>layer.packageName),cwd:layout.workspaceRoot,home:layout.dshHome,overlays:[],telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED},include=await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/cordis-plugin-include')).href)
 const flatten=rows=>rows.flatMap(row=>[row,...row.group&&Array.isArray(row.config)?flatten(row.config):[]]),route=flatten(include.applyEntryPatches([],sdk.readProfilePatches('dsh',context,profile),()=>{throw Error('官方profile未完整解析')})).find(row=>row.name==='@deepseek-ai/dsh-llm-deepseek-api-key'&&!row.disabled)
 await writeFile(join(profileDir,'cordis.patch.yml'),JSON.stringify([route?{id:route.id,name:route.name,config:{...route.config,maxTokens:8192}}:{insert:[{id:'business-deepseek',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{maxTokens:8192}}]}])+'\n',{mode:0o600})
 // 合成成员：两位职责明确的员工；预期数字逐字可核对（6800−6120=680）。
 const roles=new backend.RoleService(pool,identity),lifecycle=new backend.RoleLifecycleService(pool,identity),groups=new backend.CollaborationService(pool,identity),grants=new backend.GroupAgentGrantService(pool,identity.now),status=new backend.GroupRoutingStatusService(pool)
 const responsibility={triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
 const budget=await roles.create(owner,{requestId:randomUUID(),fields:{name:'预算员',kind:'employee',scopes:['general'],duty:'回答本群预算、开支与剩余金额问题，按群内已给出的数字计算。',dataScope:'本群消息',executionScope:'回答与整理',skills:[],knowledge:[],responsibility}})
 const follow=await roles.create(owner,{requestId:randomUUID(),fields:{name:'跟进员',kind:'employee',scopes:['general'],duty:'把群内已确认的信息整理成跟进表并贴回群里。',dataScope:'本群消息',executionScope:'整理文档',skills:[],knowledge:[],responsibility}})
 // 文件员：沿官方 PTC 预设执行脚本和受限工作目录写入（每次原生确认）；把文件贴回群的 teloa_group_attach 按群发言授权自带，不另授予。工具授权由宿主在 Run 准备时按能力目录复核，这里只登记本人选择。
 const filer=await roles.create(owner,{requestId:randomUUID(),fields:{name:'文件员',kind:'employee',runtimeConfig:{agentPresetId:'ptc'},scopes:['general'],duty:'按本人要求用脚本计算并生成文件，把文件贴回本群。',dataScope:'本群消息',executionScope:'脚本计算与生成文件',skills:[],knowledge:[],responsibility}})
 filer.version=(await lifecycle.change(owner,{roleId:filer.id,expectedVersion:filer.version,action:'pause',reason:'配置本轮验收工具'})).role.version
 const tools=new backend.RoleToolGrantService(pool,identity.now,async()=>{})
 await tools.change(owner,{roleId:filer.id,expectedRoleVersion:filer.version,action:'save',rules:[{name:'run_code',anyArguments:true,allowed:[]},{name:'write',workspaceFiles:'default-workspace',allowed:[]}]})
 filer.version=(await pool.query('select version from teloa_roles where id=$1',[filer.id])).rows[0].version
 filer.version=(await lifecycle.change(owner,{roleId:filer.id,expectedVersion:filer.version,action:'resume',reason:'工具配置完成'})).role.version
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'连续协作验收群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[budget.id,follow.id,filer.id]}})
 for(const role of [budget,follow,filer])await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 // 业务群：合成「客户」业务（与 验收业务行动草稿.mjs 同一配置路径），记录员获本人明确授予的业务修改草稿三项工具；采用每次仍经原生审批。
 const {BusinessDefinitionSourceReader}=await import('../packages/backend/src/work/business-definition-source.ts'),unavailable=async()=>{throw Error('本验收无外部业务来源')}
 const drafts=new backend.BusinessConfigurationDraftService(pool,identity),store=new backend.BusinessConfigurationStore(pool),definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const actor={ownerId:owner,scopeIds:[]},configuration=new backend.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new backend.BusinessRuntimeService(pool,identity),spaces:new backend.BusinessSpaceService(pool,identity)}),preview=new backend.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'群业务修改验收'})
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户核实',sourceId:draft.candidate.sources[0].sourceId,fields:[{name:'stage',label:'阶段',from:'阶段',type:'text',required:true},{name:'note',label:'备注',from:'备注',type:'text',required:true}]}}],upsertPages:[{id:'home',title:'客户记录',kind:'records',objectType:'customer',fields:['stage','note'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt});actor.scopeIds=[draft.scope]
 const records=new backend.BusinessRecordService(pool,identity,{definitions,warehouse:new backend.BusinessWarehouseService(pool,identity),references:new backend.BusinessSnapshotReferenceService(pool,identity)})
 const recorder=await roles.create(owner,{requestId:randomUUID(),fields:{name:'记录员',kind:'employee',scopes:[draft.scope],duty:'按本人在群里的明确交办准备客户记录修改，请本人审批后采用。',dataScope:'本群消息与客户记录',executionScope:'准备并请求采用记录修改',skills:[],knowledge:[],responsibility}})
 recorder.version=(await lifecycle.change(owner,{roleId:recorder.id,expectedVersion:recorder.version,action:'pause',reason:'配置本轮业务工具'})).role.version
 await tools.change(owner,{roleId:recorder.id,expectedRoleVersion:recorder.version,action:'save',rules:['teloa_business_change_prepare','teloa_business_change_read','teloa_business_change_apply'].map(name=>({name,anyArguments:true,allowed:[]}))})
 recorder.version=(await pool.query('select version from teloa_roles where id=$1',[recorder.id])).rows[0].version
 recorder.version=(await lifecycle.change(owner,{roleId:recorder.id,expectedVersion:recorder.version,action:'resume',reason:'业务工具配置完成'})).role.version
 const businessGroup=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'客户记录验收群',scope:draft.scope,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[recorder.id]}})
 await grants.change(owner,{requestId:randomUUID(),groupId:businessGroup.id,roleId:recorder.id,expectedGroupVersion:businessGroup.version,expectedRoleVersion:recorder.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 let active=group
 const launch=async()=>{
  worker=fork(join(programRoot,'scripts/验收同事分身常驻协作.mjs'),[],{cwd:layout.workspaceRoot,env:{...process.env,TELOA_RESIDENT_ACCEPTANCE_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']})
  workerExited=new Promise(done=>worker.once('exit',()=>done(true)))
  for(const stream of [worker.stdout,worker.stderr])stream.on('data',bytes=>{void writeFile(join(output,'host.log'),scrub(bytes.toString()),{flag:'a',mode:0o600})})
  return new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('原生宿主启动超时')),100000);worker.on('message',message=>{if(message.kind==='ready'){clearTimeout(timer);done(message)}else if(message.kind==='failed'){clearTimeout(timer);fail(Error(scrub(message.message)))}});worker.once('exit',()=>{clearTimeout(timer);fail(Error('原生宿主在就绪前退出'))});worker.send({kind:'start',layout})})
 }
 let ready=await launch()
 const {loadPlaywright,launchOptions}=await import('../packages/client/ui-workbench/tests/fixtures/load-playwright.mjs')
 const {chromium}=options['--playwright-module']?createRequire(resolve(options['--playwright-module']))('playwright'):await loadPlaywright()
 browser=await chromium.launch(options['--playwright-module']?{headless:true}:launchOptions())
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000)
 let origin='http://127.0.0.1:'+ready.port
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort())
 const openGroup=async(target=group)=>{active=target;await page.goto(ready.url);await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'对话',exact:true}).click();await page.getByRole('button',{name:new RegExp(target.name)}).first().click();await page.getByRole('textbox',{name:'群讨论消息'}).first().waitFor()}
 const messages=async()=>(await pool.query('select id,root_id,author_id,text,task_id,run_id,reference_snapshot,created_at from teloa_group_messages where owner_id=$1 and group_id=$2 order by created_at,id',[owner,active.id])).rows
 const send=async(text,box=page.getByRole('textbox',{name:'群讨论消息'}).first())=>{await box.fill(text);await box.press('Enter');return until('消息保存',messages,rows=>rows.some(row=>row.author_id==='self'&&row.text===text)).then(rows=>rows.find(row=>row.author_id==='self'&&row.text===text))}
 const inspectSession=async sessionId=>{
  const requestId=randomUUID()
  const native=await new Promise((done,fail)=>{
   const finish=(error,value)=>{clearTimeout(timer);worker.off('message',listen);error?fail(error):done(value)}
   const listen=message=>{if(message.kind==='inspection'&&message.requestId===requestId)finish(null,message);else if(message.kind==='failed')finish(Error(scrub(message.message)))}
   const timer=setTimeout(()=>finish(Error('路由诊断超时')),15000)
   worker.on('message',listen);worker.send({kind:'inspect',requestId,sessionId,goalDiagnostics:true},error=>{if(error)finish(error)})
  })
  return native
 }
 const inspectRouting=async trigger=>{
  const {groupRoutingSessionId}=await import('../packages/contract/src/index.ts')
  const sessionId=groupRoutingSessionId(owner,active.id,trigger.created_at.toISOString().slice(0,10)),native=await inspectSession(sessionId)
  const decision=(await pool.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,trigger.id])).rows[0]?.decision
  result.routingDiagnostics=JSON.parse(scrub(JSON.stringify({decision,native})))
 }
 const replyAfter=(trigger,label)=>until(label,async()=>{
  const fact=await statusOf(trigger.id)
  if(fact?.phase==='routing-failed'||fact?.phase==='unavailable'){
   await inspectRouting(trigger)
   throw Error('群消息路由未能处理：'+fact.phase+'/'+fact.hintCode)
  }
  return (await messages()).filter(row=>row.author_id!=='self'&&row.created_at>trigger.created_at)
 },rows=>rows.length>0,300000).then(rows=>rows[0])
 const statusOf=async messageId=>(await status.status(owner,{groupId:active.id,messageIds:[messageId]})).items[0]
 const workOf=(message,label,mode='work')=>until(label,async()=>(await pool.query(`select o.task_id,o.run_id,o.role_id,r.state,r.session_id from teloa_group_routing_outbox o left join teloa_task_runs r on r.id=o.run_id
  where o.owner_id=$1 and o.message_id=$2 and o.execution_mode=$3 and o.run_id is not null`,[owner,message.id,mode])).rows[0],row=>!!row,300000)
 const activeRun=async(message,label)=>{const row=await workOf(message,label);await until(label+'进入原生处理',async()=>(await pool.query('select state from teloa_task_runs where id=$1',[row.run_id])).rows[0].state,state=>state==='active'||state==='ended',300000);return row}
 const inputOf=(message,label,ready)=>until(label,async()=>(await pool.query('select * from teloa_group_work_inputs where owner_id=$1 and message_id=$2',[owner,message.id])).rows[0],row=>!!row&&ready(row),300000)
 await openGroup()
 let asked,item,input,verifiedTaskId
 if(fromStep===1){
 // 1 主群不点名提问：一位员工回应，状态由真实 Run 与回帖投影为已完成。
 asked=await send('本月预算 6800 元，目前已花 6120 元。帮我看一下预算情况。');result.messages.asked=asked.id
 const firstReply=await replyAfter(asked,'不点名提问的员工回应')
 await until('首条消息处理完成',()=>statusOf(asked.id),value=>value?.phase==='completed')
 result.checks.push('semantic-reply-with-real-status')
 // 2 跨主群根追问：上一根话题里的数字进入连续上下文，真实模型给出剩余 680。
 const followUp=await send('还剩多少？');result.messages.followUp=followUp.id
 assert.match((await replyAfter(followUp,'跨主群追问的回应')).text,/680/,'连续追问必须读到上一主群根的预算与开支')
 result.checks.push('cross-root-follow-up-680')
 // 3 引用回复：在话题内引用员工回答，回应者由宿主按原作者直接选定。
 await page.locator('article').filter({has:page.getByText(asked.text,{exact:true})}).first().getByRole('button',{name:/条.*回复|replies|在话题中回复/}).first().click()
 const replyAuthor=[budget,follow,filer].find(role=>role.id===firstReply.author_id)
 assert.ok(replyAuthor,'原回答必须来自本次验收员工')
 await page.getByRole('complementary').locator('article').filter({hasText:replyAuthor.name}).first().getByRole('button',{name:'回复',exact:true}).click()
 const quoted=await send('这个剩余金额是怎么算出来的？',page.getByRole('complementary').getByRole('textbox',{name:'群讨论消息'}));result.messages.quoted=quoted.id
 assert.equal((await pool.query('select reply_to_message_id from teloa_group_messages where id=$1',[quoted.id])).rows[0].reply_to_message_id,firstReply.id,'实际引用必须对应原员工回答')
 const decision=await until('引用回复决策',async()=>(await pool.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,quoted.id])).rows[0]?.decision,value=>!!value)
 assert.equal(decision.kind,'direct');assert.deepEqual(decision.respond,[firstReply.author_id])
 await replyAfter(quoted,'引用回复的回应')
 result.checks.push('quote-reply-direct-to-original-author')
 // 4 明确工作：语义选人接手整理工作，执行策略为 work，原文尾部限制完整保留，成果贴回原群。
 const work=await send('请跟进员把上面的预算、已花和剩余整理成一份 Markdown 跟进表贴回群里，不要修改任何已有记录。');result.messages.work=work.id
 item=await until('工作派发',async()=>(await pool.query("select * from teloa_group_routing_outbox where owner_id=$1 and message_id=$2 and execution_mode='work' and task_id is not null",[owner,work.id])).rows[0],row=>!!row)
 assert.equal(item.role_id,follow.id)
 const source=(await pool.query('select source_snapshot from teloa_group_task_sources where task_id=$1',[item.task_id])).rows[0].source_snapshot
 assert.equal(source.executionMode,'work');assert.ok(source.messageText.endsWith('不要修改任何已有记录。'))
 const workResult=await until('工作成果回群',async()=>(await messages()).filter(row=>row.task_id===item.task_id),rows=>rows.length>0,300000).then(rows=>rows[0])
 result.checks.push('explicit-work-routed-with-work-policy','work-result-posted-to-group')
 // 5 追加修订：同一 taskId、新任务版本、新 Run；旧成果不改写。
 const before=(await pool.query('select version from teloa_tasks where id=$1',[item.task_id])).rows[0].version
 const revision=await send('在刚才的跟进表里补上负责人列，负责人都写本人。');result.messages.revision=revision.id
 input=await until('追加续办',async()=>(await pool.query('select * from teloa_group_work_inputs where owner_id=$1 and message_id=$2',[owner,revision.id])).rows[0],row=>row?.state==='accepted'&&!!row.run_id,300000)
 assert.equal(input.task_id,item.task_id);assert.ok(input.task_version>before)
 await until('续办成果回群',async()=>(await messages()).filter(row=>row.run_id===input.run_id),rows=>rows.length>0,300000)
 assert.equal((await pool.query('select text from teloa_group_messages where id=$1',[workResult.id])).rows[0].text,workResult.text,'旧成果不改写')
 result.checks.push('continuation-same-task-new-version-new-run')
 // 6 活动追加：原 Run 仍在原生处理时追加，经原生受控输入进入同一 Run（不升任务版本、不新建 Run），按原生受理序号核实。
 const long=await send('请跟进员逐项核对本群至今给出的全部预算数字，分三段写出核对过程和结论贴回群里。');result.messages.long=long.id
 const longRun=await activeRun(long,'长工作开始')
 const append=await send('另外在结论最后补一句：以上数字均来自本群消息。');result.messages.append=append.id
 const appended=await inputOf(append,'活动追加受理',row=>row.state==='accepted'||row.state==='rejected')
 assert.equal(appended.state,'accepted');assert.equal(appended.task_id,longRun.task_id)
 assert.equal(appended.run_id,longRun.run_id,'追加须进入原 Run，不新建 Run');assert.equal(appended.task_version,null,'活动追加不升任务版本');assert.ok(appended.accepted_seq!==null,'按原生受理序号核实')
 const appendRun=(await pool.query('select session_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,longRun.run_id])).rows[0]
 const appendNative=await inspectSession(appendRun.session_id)
 const accepted=[...(appendNative.goalRuntime?.userInputs??[]),...(appendNative.goalRuntime?.acceptedInputs??[])].find(row=>row.seq===appended.accepted_seq&&row.source?.kind==='user'&&row.source.rpcId===appended.native_request_id)
 assert.ok(accepted,'回执接受序号必须对应原会话日志中同一原生请求的真实输入')
 result.activeAppend={taskId:appended.task_id,runId:appended.run_id,nativeRequestId:appended.native_request_id,acceptedSeq:appended.accepted_seq,payloadSha256:accepted.payloadSha256}
 const appendResults=await until('追加后的成果回群',async()=>{
  const run=(await pool.query('select state,evidence from teloa_task_runs where owner_id=$1 and id=$2',[owner,longRun.run_id])).rows[0]
  if(run.state==='configuration_failed'||run.state==='ended'&&run.evidence?.reason!=='completed'){
   result.failedRunDiagnostics=JSON.parse(scrub(JSON.stringify({run,native:await inspectSession(appendRun.session_id)})))
   throw Error('追加工作未能完成：'+(run.evidence?.reason??run.state))
  }
  return (await messages()).filter(row=>row.run_id===longRun.run_id)
 },rows=>rows.length>0,300000)
 assert.match(appendResults[0].text,/以上数字均来自本群消息/,'实际交付必须包含原生受理的追加要求')
 result.checks.push('active-run-append-native-accepted')
 // 7 停止：对正在处理的原工作发出停止，经原工作控制收敛为已停止；之后不再贴回该 Run 的成果。
 const stoppable=await send('请跟进员把本群全部消息整理成一份详细的会议纪要，按时间顺序逐条列出，贴回群里。');result.messages.stoppable=stoppable.id
 const stoppableRun=await activeRun(stoppable,'待停止工作开始')
 const stop=await send('先停止跟进员正在整理的会议纪要。');result.messages.stop=stop.id
 const stopped=await inputOf(stop,'停止受理',row=>row.state==='accepted'||row.state==='rejected')
 assert.equal(stopped.operation,'stop');assert.equal(stopped.state,'accepted');assert.equal(stopped.task_id,stoppableRun.task_id)
 await until('停止收敛',()=>statusOf(stop.id),value=>value?.phase==='stopped')
 await until('原 Run 结束',async()=>(await pool.query('select state from teloa_task_runs where id=$1',[stoppableRun.run_id])).rows[0].state,state=>state==='ended')
 result.checks.push('stop-through-work-control')
 }else if(fromStep===8||fromStep===10||fromStep===11){
  asked=await send('本月预算 6800 元，目前已花 6120 元，剩余 680 元。请预算员确认剩余金额，供本次审批与文件交接使用。');result.messages.seed=asked.id
  await replyAfter(asked,'合成上下文准备');await until('合成上下文收敛',()=>statusOf(asked.id),value=>value?.phase==='completed')
 }
 // 8 原生审批：群发起需要脚本执行的工作；状态显示需要你确认，本人从群进入原工作允许一次，结果回原群。
 const approveOnce=async(message,label,choice,maxApprovals=1)=>{
  const run=await activeRun(message,label)
  // 原生审批只记在原 Run 会话日志里，由宿主状态路由投影；这里读本人实际看到的群状态，不读后端直连投影。
  const row=page.locator('article').filter({has:page.getByText(message.text,{exact:true})}).first()
  const state=row.locator("xpath=following-sibling::*[@role='status'][1]")
  let polls=0
  await until(label+'群里显示需要你确认',async()=>{
   if(++polls%20===0)await openGroup(active)
   const visible=await state.getByText('需要你确认',{exact:true}).count()
   if(!visible){
    const original=(await pool.query('select state,evidence,session_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.run_id])).rows[0]
    if(['ended','configuration_failed','withdrawn'].includes(original.state)){
     result.failedApprovalDiagnostics=JSON.parse(scrub(JSON.stringify({label,run:original,native:await inspectSession(original.session_id)})))
     throw Error(label+'：原 Run 已结束，但群里未出现可作答的审批')
    }
   }
   return visible
  },count=>count>0,300000)
  await state.getByRole('button',{name:'查看工作',exact:true}).click()
  // 原生审批卡在原 Run 会话里作答：工作详情的「查看运行」展开原执行，再点击该运行的「打开」，不在群里代为决定。
  const button=page.getByRole('button',{name:choice,exact:true}).first()
  const approvedCalls=new Set(),decide=async()=>{
   const native=await inspectSession(run.session_id),decided=new Set(native.events.filter(event=>event.type==='approval/decided').map(event=>event.data.id))
   const asked=native.events.filter(event=>event.type==='approval/asked'&&!decided.has(event.data.id)).at(-1)
   if(!asked)return false // 原生决定已收敛、界面尚在更新，不重复作答。
   const call=native.events.find(event=>event.type==='tool/call'&&event.data.callId===asked.data.callId)
   assert.ok(call,'审批须对应这次原生工具调用')
   const fingerprint=createHash('sha256').update(JSON.stringify([call.data.name,call.data.arguments])).digest('hex')
   if(approvedCalls.has(fingerprint)||approvedCalls.size>=maxApprovals)throw Error(label+'：同一工具参数重复请求或超过本轮审批次数，先核对原回执')
   if(maxApprovals>1)assert.equal(call.data.name,'run_code','文件工作只逐次作答原生脚本调用')
   await page.screenshot({path:join(output,label+(approvedCalls.size?'-'+(approvedCalls.size+1):'')+'.png')});await button.click()
   approvedCalls.add(fingerprint)
   return true
  }
  try{
   if(!await button.waitFor({timeout:1500}).then(()=>true,()=>false)){
    await page.getByRole('button',{name:'查看运行',exact:true}).click()
    await page.locator('[data-teloa-anchor="run"]').getByRole('button',{name:'打开',exact:true}).first().click()
   }
   await button.waitFor({timeout:60000});assert.ok(await decide(),'原审批仍须可作答')
  }catch(error){
   const original=(await pool.query('select state,evidence,session_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.run_id])).rows[0]
   result.failedApprovalDiagnostics=JSON.parse(scrub(JSON.stringify({label,run:original,native:await inspectSession(original.session_id)})))
   throw error
  }
  try{
   await button.waitFor({state:'hidden',timeout:15000})
   await until(label+'原 Run 收敛',async()=>{
    const current=(await pool.query('select state from teloa_task_runs where id=$1',[run.run_id])).rows[0].state
    if(current==='ended')return current
    if(await button.count()>0&&await button.isVisible()){
     // 文件生成与贴回可以是不同脚本；每个不同调用分别经原生允许一次，业务采用仍只允许本轮的一次固定差异审批。
     await decide()
    }
    return current
   },state=>state==='ended',300000)
  }catch(error){
   if(!result.failedApprovalDiagnostics){
    const original=(await pool.query('select state,evidence,session_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.run_id])).rows[0]
    result.failedApprovalDiagnostics=JSON.parse(scrub(JSON.stringify({label,run:original,native:await inspectSession(original.session_id)})))
   }
   throw error
  }
  await openGroup(active)
  return run
 }
 if(fromStep===1||fromStep===8){
 const allowed=await send('请文件员用 run_code 计算 6800-6120，并把计算结果贴回群里。');result.messages.allowed=allowed.id
 const allowedRun=await approveOnce(allowed,'允许一次','允许一次')
 assert.match((await until('允许后的成果回群',async()=>(await messages()).filter(row=>row.run_id===allowedRun.run_id),rows=>rows.length>0,300000))[0].text,/680/)
 result.checks.push('group-work-native-approval-allowed')
 const denied=await send('请文件员用 run_code 计算 6800 乘以 0.1，并把计算结果贴回群里。');result.messages.denied=denied.id
 const deniedRun=await approveOnce(denied,'拒绝执行','拒绝')
 await until('拒绝后的说明回群',async()=>(await messages()).filter(row=>row.run_id===deniedRun.run_id),rows=>rows.length>0,300000)
 assert.notEqual((await statusOf(denied.id)).phase,'awaiting-approval','拒绝后不再停在待确认')
 result.checks.push('group-work-native-approval-rejected')
 verifiedTaskId=allowedRun.task_id
 }
 // 9 群发起业务修改：记录员在业务群按本人交办准备客户记录草稿，固定差异经原生审批允许一次后才写入正式记录；拒绝时零写。
 if(fromStep!==10&&fromStep!==11){
 await openGroup(businessGroup)
 const batchesOf=async sessionId=>(await records.recentBatches(actor,{scope:draft.scope,sessionId})).items
 const changeOf=async sessionId=>(await pool.query("select document from teloa_business_change_sets where owner_id=$1 and document->>'sessionId'=$2",[owner,sessionId])).rows.map(row=>row.document)
 const create=await send('请记录员新增一条客户记录并请我审批采用：类型 customer，标题「验收客户南辰」，摘要「群内交办」，字段 stage 为「待联系」、note 为「群内交办新增」。');result.messages.businessCreate=create.id
 const createRun=await approveOnce(create,'业务修改允许一次','允许一次')
 const applied=await until('业务修改采用',()=>changeOf(createRun.session_id),rows=>rows.some(row=>row.state==='applied'),120000)
 assert.ok(applied.find(row=>row.state==='applied').preview.operations.some(op=>op.operation==='create'&&op.title==='验收客户南辰'),'审批的是固定差异')
 const formal=await batchesOf(createRun.session_id);assert.ok(formal.length>=1,'正式记录批次来自原 Run 会话')
 await until('业务修改结果回群',async()=>(await messages()).filter(row=>row.run_id===createRun.run_id),rows=>rows.length>0,300000)
 result.checks.push('group-business-change-native-approval-applied')
 const reject=await send('请记录员再新增一条客户记录并请我审批：类型 customer，标题「验收客户西岭」，摘要「群内交办」，字段 stage 为「待联系」、note 为「应被拒绝」。');result.messages.businessReject=reject.id
 const rejectRun=await approveOnce(reject,'业务修改拒绝','拒绝')
 assert.ok((await changeOf(rejectRun.session_id)).every(row=>row.state!=='applied'),'拒绝后草稿不采用')
 assert.equal((await batchesOf(rejectRun.session_id)).length,0,'拒绝后零写正式记录')
 await until('拒绝后的说明回群',async()=>(await messages()).filter(row=>row.run_id===rejectRun.run_id),rows=>rows.length>0,300000)
 assert.notEqual((await statusOf(reject.id)).phase,'awaiting-approval')
 result.checks.push('group-business-change-native-approval-rejected')
 verifiedTaskId=createRun.task_id
 }
 if(fromStep!==9){
 await openGroup()
 if(fromStep!==11){
 // 10 依赖交接：文件员先生成文件贴回群，预算员读取这份固定成果再核对；后序先等待且没有 Task/Run，前序成果回群后只释放一次。
 const staged=await send('先请文件员用 run_code 生成文件 预算核对.md（写明预算 6800、已花 6120、剩余 680）并把文件贴回群里；文件员贴回之后，再请预算员读取文件员贴回的 预算核对.md，核对其中数字是否正确并贴回核对结论。');result.messages.staged=staged.id
 const rowsOf=async()=>(await pool.query('select role_id,state,stage,task_id,run_id,handoff_message_id,reason from teloa_group_routing_outbox where owner_id=$1 and message_id=$2 order by stage,role_id',[owner,staged.id])).rows
 const planned=await until('交接分阶段登记',rowsOf,rows=>rows.length===2)
 const first=planned.find(row=>row.role_id===filer.id),second=planned.find(row=>row.role_id===budget.id)
 assert.ok(first&&second&&first.stage===1&&second.stage===2,'文件员为前序、预算员为后序')
 assert.deepEqual({state:second.state,task:second.task_id,run:second.run_id},{state:'waiting',task:null,run:null},'后序先等待，没有 Task/Run')
 const firstRun=await approveOnce(staged,'交接前序生成文件','允许一次',5)
 verifiedTaskId=firstRun.task_id
 const fileMessage=await until('前序文件回群',async()=>(await messages()).filter(row=>row.run_id===firstRun.run_id&&Array.isArray(row.reference_snapshot)&&row.reference_snapshot.some(ref=>ref.kind==='artifact')),rows=>rows.length>0,300000).then(rows=>rows[0])
 // 未授权时保持原派工等待；本人从现有成员抽屉授予这一固定成果，不走后端代授权。
 const fileRef=fileMessage.reference_snapshot.find(ref=>ref.kind==='artifact')
 assert.ok(fileRef)
 const waiting=await until('未授权后序等待',rowsOf,rows=>rows.find(row=>row.role_id===budget.id)?.reason==='teloa/resource-required').then(rows=>rows.find(row=>row.role_id===budget.id))
 assert.deepEqual({state:waiting.state,task:waiting.task_id,run:waiting.run_id},{state:'waiting',task:null,run:null})
 await openGroup()
 await page.getByRole('button',{name:/^\d+ 位成员$/,exact:true}).click()
 await page.getByRole('complementary',{name:'成员',exact:true}).getByRole('button',{name:'预算员的本群授权',exact:true}).click()
 const grantDialog=page.getByRole('dialog',{name:'配置授权',exact:true})
 // 本轮前序成果来自唯一文件回帖，勾选与回帖固定版本对应的标题。
 const artifactTitle=(await pool.query("select content->>'title' as title from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3",[owner,fileRef.id,fileRef.version])).rows[0]?.title
 assert.ok(artifactTitle,'前序成果有真实标题')
 await grantDialog.getByRole('group',{name:'成果',exact:true}).locator('label').filter({hasText:artifactTitle}).getByRole('checkbox').check()
 await page.screenshot({path:join(output,'交接文件授权.png')})
 await grantDialog.getByRole('button',{name:'保存修改',exact:true}).click()
 await until('界面提交的固定文件授权',async()=>grants.get(owner,{groupId:group.id,roleId:budget.id}),read=>read.status==='active'&&read.grant.resources.some(ref=>ref.kind===fileRef.kind&&ref.id===fileRef.id&&ref.version===fileRef.version))
 await openGroup()
 const released=await until('后序释放',rowsOf,rows=>rows.find(row=>row.role_id===budget.id)?.task_id,300000).then(rows=>rows.find(row=>row.role_id===budget.id))
 assert.equal(released.handoff_message_id,fileMessage.id,'后序以前序固定成果回帖为交接依据')
 assert.equal((await rowsOf()).length,2,'只释放一次，不新增派工')
 const lineageOf=async taskId=>(await pool.query('select source,parent_run_id,budget_account_id,round_control_id from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,taskId])).rows[0]
 const parentLineage=await lineageOf(firstRun.task_id),childLineage=await lineageOf(released.task_id)
 assert.deepEqual(childLineage.source,{kind:'group-run-message',messageId:fileMessage.id,runId:firstRun.run_id});assert.equal(childLineage.parent_run_id,firstRun.run_id)
 assert.equal(childLineage.budget_account_id,parentLineage.budget_account_id,'同父预算');assert.equal(childLineage.round_control_id,parentLineage.round_control_id,'同父控制')
 const secondResult=await until('后序核对结论回群',async()=>(await messages()).filter(row=>row.task_id===released.task_id),rows=>rows.length>0,300000).then(rows=>rows[0])
 const childSnapshot=(await pool.query('select input_text from teloa_task_runs where owner_id=$1 and id=$2',[owner,released.run_id])).rows[0].input_text
 const fixedFiles=JSON.parse(childSnapshot).groupContext.files
 assert.ok(fixedFiles.some(file=>file.kind===fileRef.kind&&file.id===fileRef.id&&file.version===fileRef.version&&/680/.test(file.text)&&/^[0-9a-f]{64}$/.test(file.sha256)),'后序真实读取精确授权的固定文件版本')
 assert.match(secondResult.text,/680/,'后序读取前序固定成果后核对')
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where task_id=$1',[released.task_id])).rows[0].n,1,'后序只启动一次')
 result.checks.push('dependency-handoff-released-once-with-parent-lineage')
 // 固定成果：在群内预览前序固定版本并下载，返回后讨论草稿仍在。
 await page.getByRole('textbox',{name:'群讨论消息'}).first().fill('未发送的后续讨论')
 // 主群只展示话题摘录；进入原话题才能操作前序员工的完整固定成果卡。
 await page.locator('article[data-teloa-message="true"]').filter({has:page.getByText(staged.text,{exact:true})}).getByRole('button',{name:/^\d+ 条话题回复/}).click()
 const article=page.locator('article[data-teloa-message="true"]').filter({has:page.getByRole('button',{name:'文件员',exact:true})}).last()
 await article.getByRole('button',{name:'预览'+artifactTitle,exact:true}).click()
 const preview=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'返回群讨论',exact:true})})
 await preview.waitFor({timeout:30000})
 const files=preview.getByRole('navigation',{name:'文件',exact:true})
 if(await files.count())await files.getByRole('button',{name:'预算核对.md',exact:true}).last().click()
 await preview.getByRole('heading',{name:'预算核对.md',exact:true}).waitFor({timeout:30000})
 const [download]=await Promise.all([page.waitForEvent('download'),preview.getByRole('button',{name:'下载',exact:true}).first().click()])
 const downloaded=await readFile(await download.path())
 assert.match(downloaded.toString('utf8'),/680/)
 const deliveredFile=fixedFiles.find(file=>file.kind===fileRef.kind&&file.id===fileRef.id&&file.version===fileRef.version&&file.name==='预算核对.md')
 assert.ok(deliveredFile,'原交接输入含这份固定文件')
 assert.equal(createHash('sha256').update(downloaded).digest('hex'),deliveredFile.sha256,'下载字节与交接固定文件完全一致')
 await preview.getByRole('button',{name:'返回群讨论',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'群讨论消息'}).first().inputValue(),'未发送的后续讨论','预览与下载不丢讨论草稿')
 await page.getByRole('textbox',{name:'群讨论消息'}).first().fill('')
 await page.getByRole('button',{name:'关闭协作侧栏',exact:true}).click()
 result.checks.push('fixed-artifact-preview-and-download')
 }
 // 11 未知恢复：原 Run 已提交、宿主在收敛前被强制结束；重启后只按原身份核对，同一工作不重复派工，成果只贴一次。
 const crash=await send('请跟进员完成整理工作：依据本群已确认的预算、已花、剩余数字，整理 30 项预算交接核对事项，每项写出所依据的数字、核对方法与结论，整理完后贴回群里。');result.messages.crash=crash.id
 const crashRun=await activeRun(crash,'恢复用工作提交')
 const originalRun=(await pool.query('select native_request_id,state from teloa_task_runs where owner_id=$1 and id=$2',[owner,crashRun.run_id])).rows[0]
 const nativeBeforeCrash=await inspectSession(crashRun.session_id)
 assert.ok(['accepted','active'].includes(originalRun.state),'强退必须发生在原 Run 未结束时')
 assert.equal(nativeBeforeCrash.goalRuntime?.agentStatus,'running','强退前原生仍在运行')
 assert.equal(nativeBeforeCrash.events.filter(event=>event.type==='turn/end').length,0,'强退前原轮没有结束证据')
 const acceptedCount=native=>native.acceptedNativeRequestIds.filter(id=>id===originalRun.native_request_id).length
 assert.equal(acceptedCount(nativeBeforeCrash),1,'原原生请求只受理一次')
 verifiedTaskId=crashRun.task_id
 worker.kill('SIGKILL');await workerExited
 ready=await launch();origin='http://127.0.0.1:'+ready.port;await openGroup()
 // 冷恢复只核对原身份；若原轮未完成，则保留暂停／未知并由本人核对，不能靠自动重发制造成果。
 const recovered=await until('恢复后原工作状态',()=>statusOf(crash.id),value=>value&&['paused','unknown','awaiting-review','completed','blocked'].includes(value.phase),60000)
 const recoveredRun=(await pool.query('select native_request_id,session_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,crashRun.run_id])).rows[0]
 assert.deepEqual(recoveredRun,{native_request_id:originalRun.native_request_id,session_id:crashRun.session_id},'仍是原原生请求与会话')
 const crashStatus=page.locator('article').filter({has:page.getByText(crash.text,{exact:true})}).first().locator("xpath=following-sibling::*[@role='status'][1]")
 await crashStatus.getByRole('button',{name:'查看工作',exact:true}).waitFor()
 assert.equal(await crashStatus.getByRole('button',{name:'重新安排',exact:true}).count(),0,'原运行结果待核对时不能另建派工')
 result.recovery={taskId:crashRun.task_id,runId:crashRun.run_id,nativeRequestId:originalRun.native_request_id,stateBefore:originalRun.state,nativeStatusBefore:nativeBeforeCrash.goalRuntime.agentStatus,endedBefore:false,acceptedBefore:acceptedCount(nativeBeforeCrash),phase:recovered.phase}
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where task_id=$1',[crashRun.task_id])).rows[0].n,1,'恢复不新建 Run')
 assert.equal((await pool.query('select count(*)::int n from teloa_group_routing_outbox where owner_id=$1 and message_id=$2',[owner,crash.id])).rows[0].n,1,'恢复不重复派工')
 await new Promise(done=>setTimeout(done,10000))
 const afterCrash=await inspectSession(crashRun.session_id)
 assert.equal(acceptedCount(afterCrash),1,'恢复未在同一原生会话重发原请求')
 result.recovery.acceptedAfter=acceptedCount(afterCrash)
 assert.ok((await messages()).filter(row=>row.run_id===crashRun.run_id).length<=1,'原成果最多贴一次；未完成轮不能冒充已交付')
 result.checks.push('unknown-recovery-no-duplicate')
 await page.screenshot({path:join(output,'group-continuity.png')})
 // 12 冷重启：原消息、任务、成果与处理状态回读一致，不重复派工或重发。
 const counts=async()=>(await pool.query('select (select count(*) from teloa_group_messages where group_id=$1)::int m,(select count(*) from teloa_group_routing_outbox where group_id=$1)::int o,(select count(*) from teloa_task_runs)::int r',[group.id])).rows[0]
 const beforeRestart=await counts()
 await stopWorker();ready=await launch();origin='http://127.0.0.1:'+ready.port;await openGroup();await new Promise(done=>setTimeout(done,15000))
 assert.deepEqual(await counts(),beforeRestart,'冷重启后不重复派工或重发')
 assert.equal((await statusOf(asked.id)).phase,'completed')
 const afterCold=await inspectSession(crashRun.session_id)
 assert.equal(acceptedCount(afterCold),1,'再次冷重启仍未重发原生请求')
 result.recovery.acceptedAfterCold=acceptedCount(afterCold)
 await page.screenshot({path:join(output,'restarted-group.png')})
 result.checks.push('cold-restart-no-duplicate-dispatch')
 }
 result.ids={groupId:fromStep===9?businessGroup.id:group.id,workTaskId:item?.task_id??verifiedTaskId,continuationRunId:input?.run_id??null}
 result.status='passed';console.log('群聊连续协作本轮指定范围通过。')
}catch(error){failure=error;result.status='failed';result.error=scrub(error);console.error(result.error);if(page){await page.screenshot({path:join(output,'failed-ui.png')}).catch(()=>{});await writeFile(join(output,'failed-ui.txt'),scrub((await page.locator('body').innerText()).slice(-10000)),{mode:0o600}).catch(()=>{})}}
finally{
 await browser?.close().catch(()=>{});await stopWorker();await pool?.end().catch(()=>{});await container?.stop().catch(()=>{})
 await rm(root,{recursive:true,force:true});delete process.env.DEEPSEEK_API_KEY
 result.cleaned=true;await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600})
}
if(failure)process.exitCode=1
