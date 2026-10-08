import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {fork} from 'node:child_process'
import {createRequire} from 'node:module'
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from './runtime/native-runtime.mjs'
import {runManagedNativeProfile} from './runtime/native-runtime-entry.mjs'

// 官方 fatal-load 策略会退出物理进程；由外层拥有 PG 与临时目录，确保失败也能回收。
if(process.env.TELOA_RESIDENT_ACCEPTANCE_WORKER==='1'){
 let host,inputIdentity;const actualModelOutput=new Set(),actualModelRequests=new Map(),actualToolCalls=new Map()
 process.on('message',async message=>{
  try{
   if(message.kind==='start'){
    host=await runManagedNativeProfile(message.layout,['--no-open','--host','127.0.0.1','--port','0'])
    inputIdentity=(await import(pathToFileURL(join(message.layout.programRoot,'packages/harness-dsh/lib/native-input-access.js')).href)).nativeInputIdentity
    let guardDiagnosticSinkReady=false
    if(message.guardDiagnostics){
     host.ctx.logger.exporter({levels:{default:3},export(record){
      const [format,stage,code]=record.args
      if(format!=='Teloa 任务工具授权待核对：%s/%s'||typeof stage!=='string'||typeof code!=='string'||!/^[a-z-]+$/.test(stage)||!/^[A-Za-z0-9_./:-]+$/.test(code))return
      if(stage==='probe-ready'&&code==='probe-ready'){guardDiagnosticSinkReady=true;return}
      process.send({kind:'guard-diagnostic',line:'Teloa 任务工具授权待核对：'+stage+'/'+code})
     }})
     host.ctx.logger.warn('Teloa 任务工具授权待核对：%s/%s','probe-ready','probe-ready')
     if(!guardDiagnosticSinkReady)throw Error('固定授权诊断 sink 未收到自检，停止验收。')
    }
    const deadline=Date.now()+90000
    while(!host.ctx.get('teloaWork')){if(Date.now()>deadline)throw Error('常驻业务装配超时');await new Promise(done=>setTimeout(done,100))}
    // 只观察官方提供方的真实增量；持久 SessionEvent 并不存在 llm/request。
    host.ctx.on('llm/stream',async function*(options,next){
     if(options.sessionId){const requests=actualModelRequests.get(options.sessionId)??[];requests.push({provider:options.provider,model:options.model,tools:options.tools?.map(tool=>tool.name)??[],maxTokens:options.maxTokens});actualModelRequests.set(options.sessionId,requests)}
     for await(const chunk of next()){
      if(options.sessionId&&['text-delta','reasoning-delta','tool-call-delta'].includes(chunk.type))actualModelOutput.add(options.sessionId)
      if(options.sessionId&&chunk.type==='tool-call-delta'&&typeof chunk.name==='string'){const names=actualToolCalls.get(options.sessionId)??new Set();names.add(chunk.name);actualToolCalls.set(options.sessionId,names)}
      yield chunk
     }
    })
    const port=host.ctx.webServer.port
    if(!Number.isInteger(port)||port<=0||port===3100)throw Error('隔离宿主端口不正确')
    process.send({kind:'ready',port,url:host.ctx.connection.authenticatedUrl('http://127.0.0.1:'+port+'/'),guardDiagnosticSinkReady})
   }else if(message.kind==='inspect'){
    const {events}=await host.ctx.sessionController.inspect(message.sessionId)
    const diagnostics=events.filter(event=>event.type==='turn/end'||event.type.includes('error')||event.type==='llm/request'||message.goalDiagnostics&&(event.type.startsWith('tool/')||event.type.startsWith('goal/')||event.type==='assistant/message')).map(event=>{
     if(event.type!=='assistant/message')return {type:event.type,seq:event.seq,data:event.data}
     const {stream,...data}=event.data
     return {type:event.type,seq:event.seq,data:{...data,message:{...data.message,content:data.message.content.filter(block=>block.type!=='reasoning')}}}
    })
    // 官方扩展准备只读实际目录与日志；不 accept、不派发，保留原失败原因供定位。
    try{await host.ctx.get('deepseekLlmApiExtensions')?.prepare({body:{},sessionId:message.sessionId,signal:AbortSignal.timeout(10000)})}catch(error){diagnostics.push({type:'extension-diagnostic',message:error?.message})}
    const acceptedNativeRequestIds=events.flatMap(event=>event.type==='agent/inbox/spliced'?event.data.inserted.filter(item=>item.source.kind==='user').map(item=>item.source.rpcId):[])
    const agent=host.ctx.agents.get(message.sessionId),goal=agent?host.ctx.goals.get(agent):undefined,goalInputs=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='goal').map(event=>({seq:event.seq,messageId:event.data.id,source:event.data.source}))
    const goalAdmissions=events.flatMap(event=>event.type==='agent/inbox/spliced'&&agent?.session.isOwnSeq(event.seq)?event.data.inserted.filter(item=>item.source.kind==='goal').map(item=>({seq:event.seq,messageId:item.id,source:item.source,payloadSha256:inputIdentity(item).payloadSha256})):[])
    const acceptedInputs=message.goalDiagnostics&&agent?events.flatMap(event=>event.type==='agent/inbox/spliced'&&agent.session.isOwnSeq(event.seq)?event.data.inserted.filter(item=>['user','goal'].includes(item.source.kind)).map(item=>({seq:event.seq,messageId:item.id,source:item.source,payloadSha256:inputIdentity(item).payloadSha256})):[]):undefined
    const userInputs=message.goalDiagnostics&&agent?events.filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&agent.session.isOwnSeq(event.seq)).map(event=>({seq:event.seq,messageId:event.data.id,source:event.data.source,payloadSha256:inputIdentity(event.data).payloadSha256})):undefined
    const goalRuntime=message.goalDiagnostics&&agent?{agentStatus:agent.status,rootAgent:host.ctx.agents.roots().includes(agent),agentPreset:host.ctx.agentPresets.composedPreset(agent.ctx),registeredGoalTools:['get_goal','create_goal','update_goal'].filter(name=>host.ctx.tools.get(name,agent)!==undefined),modelVisibleTools:host.ctx.tools.schemas(agent).map(tool=>tool.name),actualModelRequests:actualModelRequests.get(message.sessionId)??[],actualToolCallNames:[...actualToolCalls.get(message.sessionId)??[]],compositions:host.ctx.agentPresets.inspectCompositions(agent.ctx).map(value=>({id:value.id,moduleNames:value.modules.map(module=>module.moduleName),leakedServices:value.leakedServices})),acceptedInputs,userInputs}:undefined
    process.send({kind:'inspection',requestId:message.requestId,events:diagnostics,acceptedNativeRequestIds,actualModelOutput:actualModelOutput.has(message.sessionId),goal,goalInputs,goalAdmissions,goalRuntime})
   }else if(message.kind==='stop'){await host?.shutdown.shutdown(0);process.send({kind:'stopped'});process.disconnect()}
   else throw Error('未知验收宿主控制命令')
  }catch(error){process.send?.({kind:'failed',message:error?.message??'验收宿主失败'});process.exitCode=1;await host?.shutdown.shutdown(1);process.disconnect()}
 })
}else{

// 真实官方模型、公开产品 RPC、独立 PG/profile；不向既有实例发送请求，也不重写产品调度。
const options={}
for(let i=2;i<process.argv.length;i++){
 const name=process.argv[i]
 if(name==='--smoke-only'){options.smoke=true;continue}
 if(name==='--stop-only'){options.stop=true;continue}
 if(name==='--ui-only'){options.ui=true;continue}
 if(name==='--goal-only'){options.goal=true;continue}
 if(!['--credentials-file','--output','--playwright-module'].includes(name)||!process.argv[i+1]||options[name])throw Error('参数：--credentials-file <本人私有文件> [--output <结果目录>] [--smoke-only | --stop-only | --ui-only | --goal-only] [--playwright-module <已有模块入口>]')
 options[name]=process.argv[++i]
}
if(!options['--credentials-file'])throw Error('须显式指定本人凭据文件；不会读取默认用户凭据。')
if([options.smoke,options.stop,options.ui,options.goal].filter(Boolean).length>1)throw Error('单项验收参数不能同时使用。')
if(options.ui&&!options['--playwright-module'])throw Error('界面单项须指定已安装浏览器模块。')
const source=resolve(options['--credentials-file']),info=await lstat(source)
if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw Error('本人凭据必须是私有普通文件。')
const credentials=JSON.parse(await readFile(source,'utf8'))
if(typeof credentials.deepseek!=='string'||!credentials.deepseek.trim())throw Error('本人文件缺少有效 DeepSeek 凭据。')
const secrets=Object.values(credentials).filter(v=>typeof v==='string'&&v.length>5)
const scrub=value=>{
 let text=String(value instanceof Error?value.message:value)
 for(const secret of secrets)text=text.split(secret).join('[凭据]')
 return text.replace(/([?&]token=)[^\s"']+/g,'$1[授权]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[隔离数据库]')
}
for(const name of ['log','info','warn','error']){const original=console[name].bind(console);console[name]=(...values)=>original(...values.map(scrub))}
const programRoot=dirname(dirname(fileURLToPath(import.meta.url))),output=options['--output']?resolve(options['--output']):await mkdtemp(join(tmpdir(),'teloa-resident-result-'))
await mkdir(output,{recursive:true,mode:0o700})
const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-resident-e2e-'))),layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'resident-'+randomUUID()}
for(const path of [layout.runtimeRoot,layout.workspaceRoot,layout.dshHome])await mkdir(path,{recursive:true,mode:0o700})
const result={status:'preparing',checks:[],provider:'deepseek-official',model:'deepseek-flash',fixtureModel:false,port:null}
let container,pool,running,failure
try{
 const env={DSH_HOME:layout.dshHome,TELOA_DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot,TELOA_DSH_PROFILE:layout.profileName,TELOA_USAGE_STATS:'off',TELOA_MARKET_REMOTE:'off',TELOA_CREDENTIALS_STORE:'file',TELOA_CREDENTIALS_KEY_FILE:join(root,'credentials-key'),DEEPSEEK_API_KEY:credentials.deepseek}
 await writeFile(env.TELOA_CREDENTIALS_KEY_FILE,randomBytes(32).toString('hex')+'\n',{mode:0o600});Object.assign(process.env,env);delete process.env.DSH_TELEMETRY_DISABLED
 if(process.platform==='darwin'&&!process.env.DOCKER_HOST){const socket=join(homedir(),'.orbstack/run/docker.sock');if(await lstat(socket).catch(()=>null)){process.env.DOCKER_HOST='unix://'+socket;process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'}}
 const plan=await prepareNativeRuntime({programRoot,runtimeRoot:layout.runtimeRoot});installNativeRuntime(plan)
 const backend=createRequire(join(programRoot,'packages/backend/package.json')),{PostgreSqlContainer}=backend('@testcontainers/postgresql'),{Pool}=backend('pg')
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();pool=new Pool({connectionString:container.getConnectionUri(),max:4})
 const {initializeTeloaDatabase}=await import(pathToFileURL(join(programRoot,'packages/backend/src/work/initialize-database.ts')).href);await initializeTeloaDatabase(pool)
 await writeFile(join(layout.runtimeRoot,'database.json'),JSON.stringify({connectionString:container.getConnectionUri()})+'\n',{mode:0o600})
 const official=createRequire(createRequire(join(programRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')),sdk=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-app-boot')).href),profileDir=join(layout.dshHome,'profiles',layout.profileName)
 await(await import('./runtime/profile.mjs')).prepareRuntimeProfile(layout)
 const profile=sdk.loadProfileDirectory('dsh',profileDir,official.resolve('@deepseek-ai/dsh/package.json')),include=await import(pathToFileURL(official.resolve('@deepseek-ai/cordis-plugin-include')).href),context={name:layout.profileName,dir:profile.dir,patchPath:profile.patchPath,installAnchor:official.resolve('@deepseek-ai/dsh/package.json'),startedBundles:profile.layers.map(layer=>layer.packageName),cwd:layout.workspaceRoot,home:layout.dshHome,overlays:[],telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED}
 const rows=include.applyEntryPatches([],sdk.readProfilePatches('dsh',context,profile),()=>{throw Error('验收官方配置未完整解析')})
 const flatten=rows=>rows.flatMap(row=>[row,...row.group&&Array.isArray(row.config)?flatten(row.config):[]]),route=flatten(rows).find(row=>row.name==='@deepseek-ai/dsh-llm-deepseek-api-key'&&!row.disabled)
 const modelPatch=route?{id:route.id,name:route.name,config:{...route.config,maxTokens:2048}}:{insert:[{id:'resident-deepseek-official',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{maxTokens:2048}}]}
 await writeFile(join(profileDir,'cordis.patch.yml'),JSON.stringify([modelPatch])+'\n',{mode:0o600})
 console.log('启动隔离公共宿主，使用系统分配端口。')
 const launch=async()=>{
 const worker=fork(fileURLToPath(import.meta.url),[],{cwd:layout.workspaceRoot,env:{...process.env,TELOA_RESIDENT_ACCEPTANCE_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']})
 worker.on('message',message=>{if(message.kind==='guard-diagnostic'&&/^Teloa 任务工具授权待核对：[a-z-]+\/[A-Za-z0-9_./:-]+$/.test(message.line))result.guardDiagnostics=[...new Set([...(result.guardDiagnostics??[]),message.line])]})
 let guardLog=''
 for(const stream of [worker.stdout,worker.stderr])stream.on('data',bytes=>{
  const clean=scrub(bytes.toString()).replace(/\x1b\[[0-9;]*m/g,'');guardLog+=clean
  const lines=[...guardLog.matchAll(/Teloa 任务工具授权待核对：[a-z-]+\/[A-Za-z0-9_./:-]+/g)].map(match=>match[0])
  if(lines.length)result.guardDiagnostics=[...new Set([...(result.guardDiagnostics??[]),...lines])]
  guardLog=guardLog.slice(-1024);console.log(clean)
 })
 const exited=new Promise(done=>worker.once('exit',(code,signal)=>done({code,signal})))
 const waitExit=async milliseconds=>{let timer;try{return await Promise.race([exited,new Promise(done=>{timer=setTimeout(()=>done(null),milliseconds)})])}finally{clearTimeout(timer)}}
 const handle={shutdown:{shutdown:async()=>{if(worker.exitCode!==null||worker.signalCode!==null)return;if(worker.connected)worker.send({kind:'stop'},()=>{});if(await waitExit(15000))return;worker.kill('SIGTERM');if(await waitExit(5000))return;worker.kill('SIGKILL');await exited}}}
 running=handle
 const ready=await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('公共宿主启动超时')),100000);worker.on('message',message=>{if(message.kind==='ready'){clearTimeout(timer);done(message)}else if(message.kind==='failed'){clearTimeout(timer);fail(Error(scrub(message.message)))}});worker.once('exit',()=>{clearTimeout(timer);fail(Error('公共宿主在就绪前退出，请核对以上已脱敏诊断'))});worker.send({kind:'start',layout,guardDiagnostics:options.goal===true})})
 if(options.goal){assert.equal(ready.guardDiagnosticSinkReady,true);result.guardDiagnosticSinkReady=true}
 return {worker,ready,handle}
 }
 let hosted=await launch(),worker=hosted.worker,origin,cookie
 const until=async(label,read,ready,timeout=90000)=>{const deadline=Date.now()+timeout;for(;;){const value=await read();if(ready(value))return value;if(Date.now()>deadline)throw Error(label+' 超时');await new Promise(done=>setTimeout(done,100))}}
 const authenticate=async ready=>{const port=ready.port;assert.ok(Number.isInteger(port)&&port>0&&port!==3100);result.port=port;origin='http://127.0.0.1:'+port;const response=await fetch(ready.url,{redirect:'manual'});cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie,'实际本人连接须完成启动令牌交换')}
 await authenticate(hosted.ready)
 const rpc=async(method,payload={})=>{const rpcId=randomUUID(),response=await fetch(origin+'/teloa/'+method,{method:'POST',headers:{'content-type':'application/json',cookie,origin},body:JSON.stringify({type:'client-request',rpcId,method,payload}),signal:AbortSignal.timeout(60000)});const value=await response.json();assert.equal(value.rpcId,rpcId);if(value.result?.ok!==true)throw Error(method+'：'+JSON.stringify(value.result?.error??value));return value.result.value}
 const inspection=async sessionId=>{const requestId=randomUUID();return new Promise((done,fail)=>{const timer=setTimeout(()=>{worker.off('message',receive);fail(Error('原生诊断超时'))},15000),receive=message=>{if(message.kind==='inspection'&&message.requestId===requestId){clearTimeout(timer);worker.off('message',receive);done(message)}};worker.on('message',receive);worker.send({kind:'inspect',requestId,sessionId,goalDiagnostics:options.goal===true})})}
 const verifyVisibleLocalMaterial=async task=>{
  if(!options['--playwright-module'])return
  const {chromium}=await import(pathToFileURL(resolve(options['--playwright-module'])).href),browser=await chromium.launch({headless:true})
  let page
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'})
   await context.addCookies(cookie.split('; ').map(value=>{const index=value.indexOf('=');return {name:value.slice(0,index),value:value.slice(index+1),url:origin,httpOnly:true}}))
   page=await context.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'})
   await page.getByRole('button',{name:/^(资料|Library)$/}).first().click()
   await page.getByRole('button',{name:/^(跟踪本机文件|Track a local file)$/}).click()
   const form=page.locator('form').filter({has:page.getByRole('heading',{name:/^(跟踪本机文件|Track a local file)$/})}),title='本人界面登记资料'
   const original='# 本人界面登记\n仅此合成资料，无自动执行。\n';await writeFile(join(layout.workspaceRoot,'本人界面登记.md'),original,{mode:0o600})
   await form.getByLabel(/^(名称|Name)$/).fill(title);await form.getByLabel(/^(工作文件夹内的相对路径|Path relative to the working folder)$/).fill('本人界面登记.md')
   await form.getByRole('button',{name:/^(登记并准备草稿|Register and prepare draft)$/}).click()
   const draft=await until('本人界面登记产生稳定草稿',()=>rpc('resources/list'),value=>value.drafts.some(row=>row.title===title))
   assert.equal(draft.resources.some(row=>row.title===title),false,'登记本身不能自动加入资料')
   await page.getByRole('button',{name:/^(加入资料|Add to library)$/}).click()
   const applied=await until('本人界面明确加入资料',()=>rpc('resources/list'),value=>value.resources.some(row=>row.title===title))
   await page.getByText('仅此合成资料，无自动执行。',{exact:true}).waitFor()
   await page.getByRole('tab',{name:/^(查看源码|View source code)$/}).click();const sourceText=page.locator('textarea#knowledge-write-panel');assert.equal(await sourceText.inputValue(),original);assert.equal(await sourceText.getAttribute('readonly'),'')
   await page.getByRole('tab',{name:/^(预览|Preview)$/}).click()
   await page.screenshot({path:join(output,'local-material-ui.png'),fullPage:true})
   await writeFile(join(layout.workspaceRoot,'本人界面登记.md'),'# 后改原件\n不得自动覆盖原所选版本正文。\n',{mode:0o600})
   await page.getByRole('button',{name:/^(重新读取原版本|Retry selected version)$/}).click();await page.getByText(/^(文件或资料版本已变化，请刷新资料目录后重新选择|The file or library record has changed)/).waitFor()
   assert.equal(await page.getByText('不得自动覆盖原所选版本正文。',{exact:true}).count(),0)
   await page.screenshot({path:join(output,'local-material-version-boundary-ui.png'),fullPage:true})
   result.ui={resourceId:applied.resources.find(row=>row.title===title).id,taskId:task.id};result.checks.push('actual-headless-owner-local-material-register-review-apply','actual-headless-local-material-version-preview-boundary')
   await page.getByRole('button',{name:/^(任务|Tasks)$/}).first().click();await page.getByRole('button',{name:task.title,exact:true}).click()
   await page.getByText(/^(工作额度|Work limits)$/).click();await page.getByText(/^(本人全部工作累计额度|All my work).*token/i).waitFor()
   await page.screenshot({path:join(output,'work-limits-ui.png'),fullPage:true})
   result.checks.push('actual-headless-work-budget-readable')
  }catch(error){if(page){await page.screenshot({path:join(output,'ui-error.png'),fullPage:true}).catch(()=>{});result.uiDiagnostics=scrub((await page.locator('body').innerText()).slice(0,12000))}throw error
  }finally{await browser.close()}
 }
 result.checks.push('fresh-profile-public-native-host')
 const fields={name:'材料核对同事',kind:'employee',scopes:['general'],duty:'核对本人交给你的资料，并交付有证据的简明结果。',dataScope:'仅本任务和本群明确提供的材料。',executionScope:'纯文本回应与已授权资料检索；不外发、不运行系统命令。',skills:[],knowledge:[],responsibility:{triggers:['本人交办、同群明确分工、已授权材料版本变化'],autonomousActions:['核对材料并在原群交付结果'],confirmationPoints:['外发、文件修改、资料范围扩大均交回本人'],escalationRules:['资料不足或来源不能核实时说明等待本人'],deliveryChecks:['只引用本次材料的实际版本；说明完成与阻塞']},runtimeConfig:{model:{provider:result.provider,model:result.model}}}
 let employee=await rpc('roles/create',{requestId:randomUUID(),fields})
 const verifyActualStop=async()=>{
  const stopTask=await rpc('tasks/create',{requestId:randomUUID(),fields:{title:'实际运行整项停止',goal:'请撰写五千字的详细周报，逐节展开桌面协作、资料治理和交付流程。不要调用任何工具。',scope:'general'},assignee:{roleId:employee.id,expectedVersion:employee.version}}),stopping=await rpc('task-runs/prepare',{requestId:randomUUID(),taskId:stopTask.id,expectedTaskVersion:stopTask.version})
  await rpc('task-runs/start',{runId:stopping.id})
  await until('停止前实际提供方输出开始',async()=>{const value=await inspection(stopping.sessionId);result.stopDiagnostics={runId:stopping.id,events:value.events,actualModelOutput:value.actualModelOutput};return value},value=>value.actualModelOutput,60000)
  const beforeStop=await rpc('task-runs/reconcile',{runId:stopping.id});assert.notEqual(beforeStop.state,'ended','必须在实际提供方仍运行时停止')
  const active=await rpc('work-controls/get',{controlId:stopping.lineage.roundControlId})
  await rpc('work-controls/change',{requestId:randomUUID(),controlId:active.id,expectedVersion:active.version,action:'stop',scope:'round',roundControlId:null})
  const stopped=await until('实际原生与子工作停止回执',()=>rpc('work-controls/get',{controlId:active.id}),control=>control.state==='stopped')
  assert.deepEqual(stopped.pendingRunIds,[]);assert.deepEqual(stopped.unknownOperationIds,[])
  const stoppedRun=await rpc('task-runs/reconcile',{runId:stopping.id});result.stopDiagnostics.events=(await inspection(stopping.sessionId)).events
  assert.equal(stoppedRun.state,'ended');assert.notEqual(stoppedRun.evidence.reason,'completed','停止不能伪称业务完成')
  const stoppedAgain=await rpc('task-runs/start',{runId:stopping.id});assert.equal(stoppedAgain.state,'ended');assert.deepEqual(stoppedAgain.evidence,stoppedRun.evidence)
  assert.equal((await inspection(stopping.sessionId)).acceptedNativeRequestIds.filter(id=>id===stopping.nativeRequestId).length,1)
  result.stop={runId:stopping.id,controlId:stopped.id,state:stopped.state,nativeReason:stoppedRun.evidence.reason,nativeEnd:result.stopDiagnostics.events.filter(event=>event.type==='turn/end')};delete result.stopDiagnostics;result.checks.push('actual-native-model-run-stop-acknowledged')
  await verifyVisibleLocalMaterial(stopTask)
 }
 if(options.smoke){
 const task=await rpc('tasks/create',{requestId:randomUUID(),fields:{title:'隔离宿主实际模型连通',goal:'只回答：常驻协作模型已连通。不要调用任何工具。',scope:'general'},assignee:{roleId:employee.id,expectedVersion:employee.version}}),prepared=await rpc('task-runs/prepare',{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version})
 await rpc('task-runs/start',{runId:prepared.id})
 const ended=await until('真实模型任务收尾',()=>rpc('task-runs/reconcile',{runId:prepared.id}),run=>['ended','configuration_failed','withdrawn'].includes(run.state),180000)
 assert.equal(ended.state,'ended');if(ended.evidence?.reason!=='completed'){
  result.diagnostics=JSON.parse(scrub(JSON.stringify((await inspection(ended.sessionId)).events)));throw Error('首个真实模型任务未完成：'+JSON.stringify(result.diagnostics))
 }
 assert.equal(ended.modelStatus?.state,'observed');assert.equal(ended.modelStatus.model.provider,result.provider)
 result.checks.push('actual-official-model-task');result.smokeRunId=ended.id;console.log('隔离宿主与实际官方模型任务完成。')
 }
 if(!options.smoke&&!options.stop&&!options.ui&&!options.goal){
  const owner='local:teloa-owner',materialPath=join(layout.workspaceRoot,'常驻协作合成周报.md')
  // 本人登记当前工作文件夹的真实 Markdown；修订原件，事件采集与完成判定由实际宿主执行。
  const text=round=>`# 常驻协作合成周报\n\n版本标识：ROUND-${round===1?'ONE':'TWO'}\n项目：桌面协作\n完成项：${round===1?3:5}\n阻塞：${round===1?'资料范围扩大仍须本人确认':'本轮已全部核对'}\n`
  await writeFile(materialPath,'# 常驻协作合成周报\n\n初始资料，等待本人补充首轮已核实进度。\n',{mode:0o600})
  const source=await rpc('resources/register-local-material',{requestId:randomUUID(),title:'常驻协作合成周报',path:'常驻协作合成周报.md',scopeIds:['general']})
  const draft=await rpc('resources/create',{requestId:randomUUID(),title:source.title,sourceId:source.id,sourceVersion:source.version,scopeIds:['general']})
  let resource=await rpc('resources/apply',{draftId:draft.id,expectedVersion:draft.version})
  employee=(await rpc('roles/lifecycle',{roleId:employee.id,expectedVersion:employee.version,action:'pause',reason:'本人配置本轮职责与只读工具'})).role
  employee=await rpc('roles/edit',{roleId:employee.id,expectedVersion:employee.version,fields:{...fields,knowledge:[resource.id]}})
  let twin=(await rpc('roles/list')).find(role=>role.kind==='twin');assert.ok(twin,'默认本人分身需真实存在')
  twin=await rpc('roles/edit',{roleId:twin.id,expectedVersion:twin.version,fields:{...fields,name:'本人分身',kind:'twin',knowledge:[resource.id]}})
  const rules=[{name:'teloa_knowledge_search',anyArguments:true,allowed:[]}]
  await rpc('role-tools/change',{roleId:employee.id,expectedRoleVersion:employee.version,action:'save',rules})
  employee=(await rpc('roles/list')).find(role=>role.id===employee.id)
  employee=(await rpc('roles/lifecycle',{roleId:employee.id,expectedVersion:employee.version,action:'resume',reason:'本人完成本轮工具配置'})).role
  await rpc('role-tools/change',{roleId:twin.id,expectedRoleVersion:twin.version,action:'save',rules});twin=(await rpc('roles/list')).find(role=>role.id===twin.id)
  const roles=[employee,twin],group=await rpc('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'常驻同事与分身材料核对',scope:'general',announcement:'本人授权的合成资料，只在本群交付。',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:true},memberRoleIds:roles.map(role=>role.id)}})
  let groupResource=await rpc('groups/resources/save',{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'本轮合成周报',markdown:text(1)})
  const grant=async(role,canAutoRun)=>rpc('groups/agent-grants/change',{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[{kind:'group-resource',id:groupResource.id,version:groupResource.version}],canPost:true,canAutoRun})
  await grant(employee,true);await grant(twin,false)
  for(const role of roles){
   const delegation=await rpc('role-delegations/change',{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope:'general',allowedTools:['teloa_knowledge_search'],knowledgeIds:[resource.id],memoryViewId:null,groupIds:[group.id],safeRecovery:false}})
   if(role.kind==='twin')await rpc('twin-execution-consents/confirm',{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization:{kind:'delegation',delegationId:delegation.id,delegationVersion:delegation.version}})
  }
  await grant(twin,true)
  const completion={kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1},plans=[]
  for(const role of roles){
   let plan=await rpc('plans/create-confirmed',{requestId:randomUUID(),fields:{title:role.name+'长期资料职责',goal:'阅读本人提供的合成周报，简明报告完成项与阻塞，保留资料中的版本标识。不要创建Goal或Team，不调用工具。',scope:'general',dataScope:'仅本人授权的合成周报当前固定版本',delivery:'本轮资料版本小结与正式成果',roleId:role.id,expectedRoleVersion:role.version,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'23:59',timezone:'UTC'},notificationPolicy:'silent',completionPolicy:completion},source:{kind:'manual'}})
   plan=await rpc('plans/configure-work-confirmed',{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,configuration:{completion,triggers:[{kind:'local-event',eventKind:'material-version',sourceId:resource.id,coalesce:'latest'}],budget:{maxGoalRounds:8,maxTokens:200000,maxElapsedMs:600000,maxConcurrent:4,maxRetries:2,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}})
   plans.push(plan)
  }
  // 监听暂停的长期定义仍保留事件；登记初始版本后，真实首修订会合并它，再由本人启用。
  const collected=version=>until('资料来源登记 '+version,()=>pool.query('select 1 from teloa_work_events where owner_id=$1 and event->>\'sourceId\'=$2 and payload->>\'revision\'=$3',[owner,resource.id,String(version)]),value=>value.rows.length>0)
  await collected(resource.version)
  const completedPlanRuns=async expectedVersion=>until('两身份资料事件周期 '+expectedVersion,async()=>{
   const rows=(await pool.query(`select r.id,r.role_id,t.id as task_id,t.state,r.state as run_state,r.evidence,r.input_text,p.id as plan_id from teloa_plan_occurrences o join teloa_tasks t on t.owner_id=o.owner_id and t.request_id=o.task_request_id join teloa_task_runs r on r.owner_id=t.owner_id and r.task_id=t.id join teloa_plans p on p.id=o.plan_id where o.owner_id=$1 and o.plan_id=any($2::uuid[])`,[owner,plans.map(plan=>plan.id)])).rows
   result.pendingPlanRuns=rows.map(row=>({runId:row.id,roleId:row.role_id,planId:row.plan_id,taskState:row.state,runState:row.run_state,evidence:row.evidence}))
   const matching=rows.filter(row=>{try{return JSON.parse(row.input_text).knowledge.contents.some(item=>item.id===resource.id&&item.version===expectedVersion)}catch{return false}})
   const failed=matching.find(row=>row.run_state==='configuration_failed'||row.evidence?.state==='ended'&&row.evidence.reason!=='completed');if(failed)throw Error('长期周期实际运行失败：'+JSON.stringify({roleId:failed.role_id,runId:failed.id,evidence:failed.evidence}))
   return matching
  },rows=>roles.every(role=>rows.filter(row=>row.role_id===role.id&&row.state==='completed'&&row.run_state==='ended').length===1),240000)
  const actualModels=async runs=>{for(const run of runs){const value=await rpc('task-runs/reconcile',{runId:run.id});assert.equal(value.modelStatus?.state,'observed');assert.equal(value.modelStatus.model.provider,result.provider)}}
  const groupRound=async round=>{
   const marker='ROUND-'+(round===1?'ONE':'TWO'),message=await rpc('groups/messages/send',{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:`明确分工：材料核对同事与本人分身各自独立阅读所附周报，各回一条本人结论并包含 ${marker}。不要转派，不要 @ 其他成员，不调用工具。`,references:[{kind:'group-resource',id:groupResource.id,version:groupResource.version}],mentions:roles.map(role=>({roleId:role.id,expectedVersion:role.version}))})
   const replies=await until('两身份群内实际回传 '+marker,()=>rpc('groups/messages/list',{groupId:group.id}),messages=>roles.every(role=>messages.some(reply=>reply.authorId===role.id&&reply.rootId===message.id&&reply.text.includes(marker))),240000)
   const fixed=roles.map(role=>replies.find(reply=>reply.authorId===role.id&&reply.rootId===message.id&&reply.text.includes(marker)))
   assert.equal(new Set(fixed.map(reply=>reply.runId)).size,2);return fixed.map(reply=>({roleId:reply.authorId,taskId:reply.taskId,runId:reply.runId,messageId:reply.id}))
  }
  console.log('修订真实资料，等待事件唤醒两身份首轮职责与群分工。')
  // 两轮均由本人真实修订触发，不手工建周期任务，也不调用 plans/trigger。
  await writeFile(materialPath,text(1),{mode:0o600})
  await collected(resource.version+1)
  resource=(await rpc('resources/list')).resources.find(row=>row.id===resource.id)
  assert.ok(resource);const firstResourceVersion=resource.version
  for(let i=0;i<plans.length;i++){const plan=plans[i];plans[i]=await rpc('plans/change-confirmed',{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'enable'})}
  const firstPlans=await completedPlanRuns(resource.version),firstGroup=await groupRound(1)
  await actualModels(firstPlans)
  result.checks.push('employee-twin-confirmed-delegations','actual-official-model-task','actual-two-role-group-first-round','actual-material-event-first-round-both-identities')
  await writeFile(materialPath,text(2),{mode:0o600})
  await collected(resource.version+1)
  resource=(await rpc('resources/list')).resources.find(row=>row.id===resource.id);assert.ok(resource)
  groupResource=await rpc('groups/resources/save',{requestId:randomUUID(),groupId:group.id,resourceId:groupResource.id,expectedVersion:groupResource.version,title:groupResource.title,markdown:text(2)})
  for(const role of roles)await grant(role,true)
  console.log('真实资料版本已更新，等待产品事件唤醒两身份第二轮。')
  const secondPlans=await completedPlanRuns(resource.version),secondGroup=await groupRound(2)
  assert.equal(new Set([...firstPlans,...secondPlans].map(run=>run.id)).size,4)
  await actualModels(secondPlans)
  const claims=(await pool.query('select q.plan_id,e.event,e.payload from teloa_plan_work_events q join teloa_work_events e on e.owner_id=q.owner_id and e.id=q.event_id where q.owner_id=$1 and q.plan_id=any($2::uuid[]) and q.state=\'claimed\'',[owner,plans.map(plan=>plan.id)])).rows
  assert.ok(roles.length===2&&plans.every(plan=>[firstResourceVersion,resource.version].every(version=>claims.some(row=>row.plan_id===plan.id&&row.event.kind==='material-version'&&row.event.sourceId===resource.id&&row.payload.revision===version))))
  result.checks.push('actual-material-event-second-round-both-identities','actual-two-role-group-second-round','trusted-version-summary-completes-next-cycle')
  result.rounds={plans:[firstPlans,secondPlans].map(rows=>rows.map(row=>({runId:row.id,taskId:row.task_id,roleId:row.role_id,planId:row.plan_id}))),groups:[firstGroup,secondGroup],resourceVersions:[firstResourceVersion,resource.version],eventClaims:claims.map(row=>({planId:row.plan_id,eventId:row.event.id,revision:row.payload.revision}))}
  delete result.pendingPlanRuns
  const formal=[]
  for(const run of [...firstPlans,...secondPlans]){const entries=await rpc('artifacts/task/list',{taskId:run.task_id});assert.ok(entries.length>0,'已验收资料周期必须有本人可取得的正式成果');assert.ok(entries.some(entry=>entry.content.sections.some(section=>section.text.includes(firstPlans.some(row=>row.id===run.id)?'ROUND-ONE':'ROUND-TWO'))));formal.push({taskId:run.task_id,artifactIds:entries.map(entry=>entry.artifactId)})}
  result.artifacts=formal;result.checks.push('formal-artifacts-readable-through-product-api')
  for(const plan of plans){const current=await rpc('plans/get',{planId:plan.id});await rpc('plans/change-confirmed',{requestId:randomUUID(),planId:plan.id,expectedVersion:current.version,action:'pause'})}
  // 保留同一安装身份、PG 与 profile，只重启实际宿主；已完成周期不重放，未派发工作需本人恢复。
  const coldTask=await rpc('tasks/create',{requestId:randomUUID(),fields:{title:'同一宿主停机恢复',goal:'只回答：原单轮已由本人明确恢复。不要调用工具。',scope:'general'},assignee:{roleId:employee.id,expectedVersion:employee.version}}),cold=await rpc('task-runs/prepare',{requestId:randomUUID(),taskId:coldTask.id,expectedTaskVersion:coldTask.version})
  assert.equal(cold.state,'prepared');const originalInput=cold.inputText,originalRequest=cold.nativeRequestId
  await running.shutdown.shutdown(0);hosted=await launch();worker=hosted.worker;await authenticate(hosted.ready)
  const paused=await until('重启后整项保持解除执行许可',()=>rpc('work-controls/get',{controlId:cold.lineage.roundControlId}),control=>control.state==='paused')
  const afterRestart=(await rpc('task-runs/list',{taskId:coldTask.id}))[0]
  assert.equal(afterRestart.id,cold.id);assert.equal(afterRestart.state,'prepared');assert.equal(afterRestart.inputText,originalInput);assert.equal(afterRestart.nativeRequestId,originalRequest)
  assert.equal((await inspection(cold.sessionId)).acceptedNativeRequestIds.filter(id=>id===originalRequest).length,0)
  const candidates=await rpc('work-recovery/inspect',{controlId:paused.id});assert.equal(candidates.length,1);assert.equal(candidates[0].reason,'unaccepted');assert.equal(candidates[0].runId,cold.id)
  const resume={requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[cold.id]}
  await rpc('work-recovery/resume',resume)
  const recovered=await until('本人恢复后实际模型收尾',()=>rpc('task-runs/reconcile',{runId:cold.id}),run=>run.state==='ended',180000)
  assert.equal(recovered.evidence.reason,'completed');assert.equal(recovered.inputText,originalInput);assert.equal(recovered.nativeRequestId,originalRequest);assert.equal(recovered.modelStatus?.state,'observed')
  await rpc('work-recovery/resume',resume)
  assert.equal((await inspection(cold.sessionId)).acceptedNativeRequestIds.filter(id=>id===originalRequest).length,1)
  const unchanged=(await pool.query('select count(*)::integer as count from teloa_plan_occurrences where owner_id=$1 and plan_id=any($2::uuid[])',[owner,plans.map(plan=>plan.id)])).rows[0].count;assert.equal(unchanged,4)
  result.recovery={runId:cold.id,requestId:resume.requestId,acceptedCount:1};result.checks.push('restart-disarmed-no-completed-round-replay','owner-recovery-preserves-run-and-input-once')
  // 等真正模型请求已经开始再停止；无孩子/后台工作且原生 idle 回执齐全才认 stopped。
  await verifyActualStop()
 }
 if(options.stop)await verifyActualStop()
 if(options.ui){const task=await rpc('tasks/create',{requestId:randomUUID(),fields:{title:'本人界面额度检查',goal:'尚未执行，仅由本人查看原工作额度。',scope:'general'},assignee:{roleId:employee.id,expectedVersion:employee.version}});await rpc('task-runs/prepare',{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version});await verifyVisibleLocalMaterial(task)}
 if(options.goal){
  employee=(await rpc('roles/lifecycle',{roleId:employee.id,expectedVersion:employee.version,action:'pause',reason:'本人配置官方 Goal 只读计算职责'})).role
  const names=['get_goal','create_goal','update_goal'],candidate=await rpc('role-tools/candidates',{roleId:employee.id})
  result.goalCandidates=candidate.rules.map(rule=>rule.name)
  for(const name of names)assert.ok(candidate.rules.some(rule=>rule.name===name&&rule.anyArguments===true),'实际岗位工具授权候选缺少 '+name)
  await rpc('role-tools/change',{roleId:employee.id,expectedRoleVersion:employee.version,action:'save',rules:names.map(name=>({name,anyArguments:true,allowed:[]}))});employee=(await rpc('roles/list')).find(role=>role.id===employee.id)
  employee=(await rpc('roles/lifecycle',{roleId:employee.id,expectedVersion:employee.version,action:'resume',reason:'本人明确授权本次官方 Goal 多轮计算'})).role
  const group=await rpc('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'实际官方 Goal 多轮核验',scope:'general',announcement:'只核对纯文本算式，原群回传最后有效轮。',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:true},memberRoleIds:[employee.id]}})
  await rpc('groups/agent-grants/change',{requestId:randomUUID(),groupId:group.id,roleId:employee.id,expectedGroupVersion:group.version,expectedRoleVersion:employee.version,action:'save',resources:[],canPost:true,canAutoRun:false})
  const objective='严格分为两个自动续轮。第1自动轮只核对 2+3=5，输出 GOAL-ROUND-ONE，不得完成Goal，然后结束该轮。第2自动轮核对 5+8=13，用 update_goal complete 完成，并在最后回复写 GOAL-FINAL-SECOND 与两个已核对结果。不得在一个自动轮做两步。'
  const message=await rpc('groups/messages/send',{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请实际创建并完成官方多轮Goal。当前初始轮只调用 create_goal，objective严格设为以下工作步骤、max_goal_rounds为4；创建后只回复 GOAL-CREATED 并结束当前轮，不做计算、不标记complete、不调用其他工具。后续官方自动续轮按objective逐轮执行。不要创建Team、不要转派或@他人。\n'+objective,references:[],mentions:[]})
  // 复用群消息的本人明确交办入口；Goal 专项不依赖路由模型选择回应者。
  const assigned=await rpc('groups/tasks/create',{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:message.text,assignee:{roleId:employee.id,expectedVersion:employee.version}})
  const prepared=await rpc('task-runs/prepare',{requestId:randomUUID(),taskId:assigned.task.id,expectedTaskVersion:assigned.task.version})
  await rpc('task-runs/start',{runId:prepared.id})
  result.goalDispatch={kind:'owner-group-task',taskId:assigned.task.id,runId:prepared.id,messageId:message.id,source:assigned.source}
  console.log('本人明确群任务已提交，等待官方 Goal 的真实续轮和最终回传。')
  const reply=await until('实际官方 Goal 至少两轮与最后有效轮群回传',async()=>{
   const rows=await rpc('groups/messages/list',{groupId:group.id}),reply=rows.find(row=>row.rootId===message.id&&row.authorId===employee.id)
   const source=(await pool.query('select s.task_id from teloa_group_task_sources s join teloa_tasks t on t.owner_id=s.owner_id and t.id=s.task_id where s.owner_id=$1 and s.group_id=$2 and s.message_id=$3 and t.assignee_role_id=$4',['local:teloa-owner',group.id,message.id,employee.id])).rows[0]
   if(source){const runs=await rpc('task-runs/list',{taskId:source.task_id}),run=runs[0];if(run){const native=await inspection(run.sessionId),receipts=(await pool.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 order by round',['local:teloa-owner',run.id])).rows.map(row=>row.receipt);result.goalDiagnostics={runId:run.id,sessionId:run.sessionId,state:run.state,evidence:run.evidence,nativeRequestId:run.nativeRequestId,allowedTools:run.allowedTools,argumentRules:run.argumentRules,roleSnapshot:run.roleSnapshot,lineage:run.lineage,goal:native.goal,receipts,events:native.events,runtime:native.goalRuntime,groupReplies:rows.filter(row=>row.rootId===message.id&&row.authorId===employee.id)};if(native.goal?.phase==='blocked'||native.goal?.activation==='disarmed'&&native.goal?.phase!=='complete')throw Error('实际Goal被阻断，请查看已保存的 goalDiagnostics。');if(run.state==='configuration_failed'||run.state==='ended'&&(run.evidence?.reason!=='completed'||native.goal?.phase!=='complete'))throw Error('实际Goal运行未成功，请查看已保存的 goalDiagnostics。')}}
   return reply
  },reply=>!!reply?.text.includes('GOAL-FINAL-SECOND'),240000)
  const run=await rpc('task-runs/reconcile',{runId:reply.runId}),native=await inspection(run.sessionId),receipts=(await pool.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 order by round',['local:teloa-owner',run.id])).rows.map(row=>row.receipt)
  assert.equal(run.state,'ended');assert.equal(run.evidence.reason,'completed');assert.equal(run.modelStatus?.state,'observed');assert.equal(native.goal?.phase,'complete');assert.ok(native.goal.roundsStarted>=2)
  assert.ok(receipts.length>=2&&receipts.every(receipt=>receipt.state==='accepted'&&receipt.runId===run.id&&receipt.sessionId===run.sessionId&&Number.isInteger(receipt.acceptedSeq)&&native.goalAdmissions.some(input=>input.seq===receipt.acceptedSeq&&input.messageId===receipt.messageId&&input.payloadSha256===receipt.payloadSha256&&input.source.goalId===receipt.goalId&&input.source.revision===receipt.revision&&input.source.round===receipt.round)))
  assert.equal(new Set(receipts.map(receipt=>[receipt.runId,receipt.goalId,receipt.revision,receipt.round].join(':'))).size,receipts.length)
  result.goal={runId:run.id,goalId:native.goal.id,rounds:native.goal.roundsStarted,receipts:receipts.map(receipt=>({round:receipt.round,revision:receipt.revision,acceptedSeq:receipt.acceptedSeq,nativeRequestId:receipt.nativeRequestId,payloadSha256:receipt.payloadSha256})),messageId:reply.id,finalText:reply.text};delete result.goalCandidates;delete result.goalDiagnostics;result.checks.push('actual-official-goal-two-rounds-durable-continuations','actual-goal-last-valid-round-group-reply')
 }
 result.status='passed'
}catch(error){failure=error;result.status='failed';result.error=scrub(error)}
finally{
 if(running){try{await running.shutdown.shutdown(0)}catch(error){failure??=error;result.cleanupError=scrub(error)}}
 if(pool)await pool.end();if(container)await container.stop()
 await writeFile(join(output,'results.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600})
 await rm(root,{recursive:true,force:true});delete process.env.DEEPSEEK_API_KEY
}
console.log(JSON.stringify({status:result.status,checks:result.checks,output}))
if(failure)process.exitCode=1
}
