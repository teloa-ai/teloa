import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import {randomBytes,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from './runtime/native-runtime.mjs'
import {prepareRuntimeProfile} from './runtime/profile.mjs'

// 真实模型使用原生工作台、ToolRuntime 与审批；不向既有实例发请求。
const options={}
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i]
 if(!['--credentials-file','--output','--playwright-module'].includes(key)||!process.argv[i+1]||options[key])throw Error('参数：--credentials-file <本人私有JSON> --output <证据目录> [--playwright-module <已有模块package.json>]')
 options[key]=process.argv[++i]
}
if(!options['--credentials-file']||!options['--output'])throw Error('须明确提供本人私有凭据和证据目录。')
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
const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-business-model-')))
const layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'business-'+randomUUID()}
const result={status:'preparing',provider:'deepseek-official',model:'deepseek-flash',fixtureModel:false,checks:[]}
let pool,container,browser,page,worker,workerExited,sessionId,failure
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
 await writeFile(join(profileDir,'cordis.patch.yml'),JSON.stringify([route?{id:route.id,name:route.name,config:{...route.config,maxTokens:3072}}:{insert:[{id:'business-deepseek',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{maxTokens:3072}}]}])+'\n',{mode:0o600})
 // 合成业务只准备一次；配置、记录使用现有服务，模型真正读取资料并生产结果。
 const {BusinessDefinitionSourceReader}=await import('../packages/backend/src/work/business-definition-source.ts'),unavailable=async()=>{throw Error('本验收无外部业务来源')}
 const drafts=new backend.BusinessConfigurationDraftService(pool,identity),store=new backend.BusinessConfigurationStore(pool),definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const actor={ownerId:'local:teloa-owner',scopeIds:[]},configuration=new backend.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new backend.BusinessRuntimeService(pool,identity),spaces:new backend.BusinessSpaceService(pool,identity)}),preview=new backend.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'真实模型业务验收'})
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户核实',sourceId:draft.candidate.sources[0].sourceId,fields:[{name:'stage',label:'阶段',from:'阶段',type:'text',required:true},{name:'note',label:'备注',from:'备注',type:'text',required:true}]}}],upsertPages:[{id:'home',title:'客户记录',kind:'records',objectType:'customer',fields:['stage','note'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt});actor.scopeIds=[draft.scope]
 const records=new backend.BusinessRecordService(pool,identity,{definitions,warehouse:new backend.BusinessWarehouseService(pool,identity),references:new backend.BusinessSnapshotReferenceService(pool,identity)})
 const record=await records.create(actor,{requestId:randomUUID(),scope:draft.scope,type:'customer',title:'验收客户北辰',summary:'合成验收对象',fields:[{name:'stage',value:'待联系'},{name:'note',value:'需求尚未核实'}]})
 await writeFile(join(layout.workspaceRoot,'需求说明甲.md'),'# 北辰需求说明\n客户计划为42名员工准备协作席位。尚未签约，没有付款记录。\n',{mode:0o600})
 await writeFile(join(layout.workspaceRoot,'需求说明乙.md'),'# 北辰补充说明\n本次预算为6300元。仍需联系本人确认上线时间，不构成成交。\n',{mode:0o600})
 const launch=async()=>{
  worker=fork(join(programRoot,'scripts/验收同事分身常驻协作.mjs'),[],{cwd:layout.workspaceRoot,env:{...process.env,TELOA_RESIDENT_ACCEPTANCE_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']})
  workerExited=new Promise(done=>worker.once('exit',()=>done(true)))
  for(const stream of [worker.stdout,worker.stderr])stream.on('data',bytes=>{void writeFile(join(output,'host.log'),scrub(bytes.toString()),{flag:'a',mode:0o600})})
  return new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('原生宿主启动超时')),100000);worker.on('message',message=>{if(message.kind==='ready'){clearTimeout(timer);done(message)}else if(message.kind==='failed'){clearTimeout(timer);fail(Error(scrub(message.message)))}});worker.once('exit',()=>{clearTimeout(timer);fail(Error('原生宿主在就绪前退出'))});worker.send({kind:'start',layout})})
 }
 const inspection=async()=>{const requestId=randomUUID();return new Promise((done,fail)=>{const timer=setTimeout(()=>{worker.off('message',receive);fail(Error('原生回执读取超时'))},15000),receive=message=>{if(message.kind==='inspection'&&message.requestId===requestId){clearTimeout(timer);worker.off('message',receive);done(message)}};worker.on('message',receive);worker.send({kind:'inspect',requestId,sessionId,goalDiagnostics:true})})}
 let ready=await launch()
 const {loadPlaywright,launchOptions}=await import('../packages/client/ui-workbench/tests/fixtures/load-playwright.mjs')
 const {chromium}=options['--playwright-module']?createRequire(resolve(options['--playwright-module']))('playwright'):await loadPlaywright()
 browser=await chromium.launch(options['--playwright-module']?{headless:true}:launchOptions())
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000)
 let origin='http://127.0.0.1:'+ready.port
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort())
 await page.goto(ready.url)
 const openRecord=async()=>{await page.getByRole('button',{name:/^(Business|业务)$/}).first().click();await page.getByRole('button',{name:/^真实模型业务验收/}).first().click();await page.getByRole('button',{name:/^(Records|记录)$/}).click();await page.getByRole('region',{name:'客户记录',exact:true}).getByRole('button',{name:/验收客户北辰/}).click()}
 await openRecord();await page.getByRole('button',{name:/^(Start new work|开始新工作)$/}).click()
 sessionId=await until('对象工作关联',async()=>(await pool.query('select document from teloa_business_object_work_links')).rows,rows=>rows.length===1).then(rows=>rows[0].document.sessionId)
 const editor=page.getByRole('textbox',{name:/^(Message or run a task|Describe what you want to build|输入|描述)/})
 await editor.fill('请读取工作文件夹中的需求说明甲.md和需求说明乙.md，结合当前客户记录，整理已知需求、预算和仍待确认事项。将摘要保存为当前对象的工作成果；仅准备把备注改成经两份材料核实的简明摘要，保留原阶段，并保存为一份修改草稿。不要采用；没有成交或付款证据，不得改变阶段。')
 await page.getByRole('button',{name:/^(Send message|发送消息)$/}).click();result.status='model-working';console.log('真实模型已在独立业务会话开始读取合成材料。')
 const proposed=await until('真实模型成果及修改草稿',async()=>({changes:(await pool.query('select document from teloa_business_change_sets')).rows.map(row=>row.document),results:(await pool.query('select document from teloa_business_work_results')).rows.map(row=>row.document)}),value=>value.changes.length===1&&value.results.length>0)
 const proposedChange=proposed.changes[0],operation=proposedChange.batch.operations[0],summary=proposed.results.map(row=>row.summary).join('\n')
 assert.match(summary,/42/);assert.match(summary,/6[,\s]?300/);assert.equal(operation.operation,'edit');assert.equal(operation.id,record.id);assert.equal(operation.expectedVersion,1)
 assert.equal(operation.fields.find(field=>field.name==='stage')?.value,'待联系')
 const note=operation.fields.find(field=>field.name==='note')?.value;assert.match(note,/42/);assert.match(note,/6[,\s]?300/)
 assert.equal((await records.get(actor,{scope:draft.scope,type:'customer',id:record.id})).version,1)
 const observed=await inspection();assert.equal(observed.actualModelOutput,true);assert.ok(observed.goalRuntime.actualModelRequests.length>0)
 const calls=observed.events.filter(event=>event.type==='tool/call'||event.type==='tool/ptc-dispatch-start');assert.ok(calls.some(event=>event.data.name==='read'||/read.*file|file.*read/.test(event.data.name)),'必须实际读取文件，不能仅凭提示猜答案')
 result.checks.push('real-model-read-fixed-material','facts-42-seats-and-6300-budget','authored-result-preserved','draft-zero-formal-write')
 await page.getByRole('button',{name:/^(Send message|发送消息)$/}).waitFor()
 await page.getByRole('button',{name:/^(Business|业务)$/}).first().click();await page.getByRole('button',{name:/^真实模型业务验收/}).first().click()
 await page.getByRole('button',{name:/验收客户北辰.*Draft|验收客户北辰.*待审阅/}).click();await page.getByRole('button',{name:/^(Request adoption|请求采用)$/}).click()
 await page.getByRole('button',{name:/^(Allow once|允许一次)$/}).waitFor({timeout:180000})
 assert.equal((await records.get(actor,{scope:draft.scope,type:'customer',id:record.id})).version,1)
 await page.screenshot({path:join(output,'native-approval.png')})
 await page.getByRole('button',{name:/^(Allow once|允许一次)$/}).click()
 await until('真实原生采用',async()=>(await pool.query('select document from teloa_business_change_sets where id=$1',[proposedChange.id])).rows[0].document,value=>value.state==='applied')
 const adopted=await records.get(actor,{scope:draft.scope,type:'customer',id:record.id})
 assert.equal(adopted.version,2);assert.equal(adopted.fields.find(field=>field.label==='阶段').value,'待联系');assert.equal(adopted.fields.find(field=>field.label==='备注').value,note)
 await page.getByRole('button',{name:/^(Send message|发送消息)$/}).waitFor()
 result.checks.push('native-fixed-approval-adopted-once','formal-fields-match-preview')
 await stopWorker();ready=await launch();origin='http://127.0.0.1:'+ready.port;await page.goto(ready.url);await openRecord()
 await page.getByRole('dialog').getByText(summary,{exact:true}).waitFor();await page.screenshot({path:join(output,'restarted-record-results.png')})
 result.checks.push('cold-restart-read-record-and-original-result')
 result.record={id:record.id,version:adopted.version,fields:adopted.fields};result.change={id:proposedChange.id,revision:proposedChange.revision,digest:proposedChange.digest};result.summary=summary;result.native={provider:observed.goalRuntime.actualModelRequests[0].provider,model:observed.goalRuntime.actualModelRequests[0].model,toolCalls:calls.map(event=>event.data.name)}
 result.status='passed';console.log('真实模型业务闭环、固定审批与冷重启回读通过。')
}catch(error){failure=error;result.status='failed';result.error=scrub(error);console.error(result.error);if(page){await page.screenshot({path:join(output,'failed-ui.png')}).catch(()=>{});await writeFile(join(output,'failed-ui.txt'),scrub((await page.locator('body').innerText()).slice(-10000)),{mode:0o600}).catch(()=>{})}}
finally{
 await browser?.close().catch(()=>{});await stopWorker();await pool?.end().catch(()=>{});await container?.stop().catch(()=>{})
 await rm(root,{recursive:true,force:true});delete process.env.DEEPSEEK_API_KEY
 result.cleaned=true;await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600})
}
if(failure)process.exitCode=1
