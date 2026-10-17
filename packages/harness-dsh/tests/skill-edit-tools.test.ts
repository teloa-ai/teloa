import test,{before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {openResourceDatabase,MarketContentStore,initializeMarketContents,normalizeMarketSourceTrust} from '@teloa/backend'
import {SkillInstallSource} from '../../backend/src/market/skill-install-source.ts'
import {SkillInstallationService,initializeSkillInstallations} from '../../backend/src/market/skill-installations.ts'
import {SkillSelectionService} from '../../backend/src/market/skill-selection-changes.ts'
import {SkillAvailabilityService} from '../../backend/src/market/skill-availability.ts'
import {createMarketContentHandler} from '../src/market-content.ts'
import {createSkillInstallationsHandler} from '../src/skill-installations.ts'
import {createSkillSelectionHandler} from '../src/skill-selections.ts'
import {createSkillAvailabilityHandler} from '../src/skill-availability.ts'
import {ManagedSkillFiles} from '../src/managed-skill-files.ts'
import {inspectNativeSkillDirectory} from '../src/managed-skills-native.ts'
import {createSkillEditHandler,registerSkillEditTools} from '../src/skill-edit-tools.ts'
import {groupMessageSecretGate} from '../src/prompt-secret-gate.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem}
let container:StartedPostgreSqlContainer,pool:SkillInstallationService['pool'],databaseRoot:string
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();databaseRoot=await mkdtemp(join(tmpdir(),'teloa-skill-edit-db-'));const {writeFile}=await import('node:fs/promises'),config=join(databaseRoot,'database.json');await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600});pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool;await initializeMarketContents(pool);await initializeSkillInstallations(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(databaseRoot)await rm(databaseRoot,{recursive:true,force:true})})
async function fixture(t:TestContext){
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},ctx=new Context(),root=await realpath(await mkdtemp(join(tmpdir(),'teloa-skill-edit-')))
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})});await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
 const store=new MarketContentStore(pool,identity),files=new ManagedSkillFiles(join(root,'skills'),directory=>inspectNativeSkillDirectory(ctx,directory),()=>{}),installs=new SkillInstallationService(pool,identity,new SkillInstallSource(store,{get:async()=>{throw Error('not industry')}}),files)
 const content=createMarketContentHandler(owner,async()=>store as any),installations=createSkillInstallationsHandler(owner,async()=>installs),selection=createSkillSelectionHandler(owner,async()=>new SkillSelectionService(pool,identity)),availability=createSkillAvailabilityHandler(owner,async()=>new SkillAvailabilityService(pool,identity,{verify:async()=>{}})),admitText=groupMessageSecretGate(()=>['stored-private-value'])
 const handler=createSkillEditHandler({owner,content,installations,selection,availability,admitText})
 const original='---\nname: original-flow\ndescription: 原流程说明\ndisable-model-invocation: true\n---\n\n原流程正文\n'
 const trust={...normalizeMarketSourceTrust(undefined,'本人流程'),license:{status:'declared',value:'MIT'},permissions:[{id:'read:references',description:'读取原资料',required:true}],signature:{status:'verified',signer:'test-fixture'},review:{conclusion:'approved',summary:'测试原内容声明'}}
 const imported=await content('market-content/import',{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'本人流程'},metadata:{id:'original-flow',title:'保存原流程',version:'1.0.0',categories:['test']},trust,files:[{path:'SKILL.md',base64:Buffer.from(original).toString('base64')},{path:'references/guide.txt',base64:Buffer.from('原附件不可执行').toString('base64')}]}) as any
 const source={kind:'atomic',contentId:imported.content.id},preview=await installations('skill-installations/preview',{source}) as any,installed=await installations('skill-installations/install',{requestId:randomUUID(),source,expectedBundleHash:preview.bundleHash,expectedTrustHash:preview.trustHash}) as any
 const id=installed.installation.id,read=await handler('skill-edits/get',{installationId:id}),input={requestId:randomUUID(),installationId:id,expectedSelectionVersion:read.selection.version,expectedBundleHash:read.expectedBundleHash,title:'中文流程名称',description:'修订后的说明',body:'先核对本人需求，再整理原依据。'}
 return {owner,ctx,root,store,files,handler,id,read,input,original,ports:{owner,content,installations,selection,availability,admitText}}
}

test('真实 PostgreSQL、市场内容、DSH parser 与受管文件：修改同技能保存新版本，不启用、不覆盖原件，重试幂等',async t=>{
 const e=await fixture(t);e.input.body='先核对本人需求，再整理原依据。\n'.repeat(2000);const saved=await e.handler('skill-edits/save',e.input),again=await e.handler('skill-edits/save',e.input)
 assert.equal(saved.skill.id,e.read.skill.id);assert.equal(saved.skill.nativeName,e.read.skill.nativeName);assert.equal(saved.skill.title,'中文流程名称');assert.equal(saved.skill.description,e.input.description);assert.equal(saved.skill.version,'1.0.1');assert.equal(saved.skill.private,true);assert.equal(saved.skill.ownerId,e.owner);assert.equal(saved.skill.state,'saved');assert.equal(saved.skill.selected,false);assert.equal(saved.skill.availability,'enabled');assert.equal(saved.body,e.input.body)
 assert.notEqual(saved.skill.installationId,e.id);assert.deepEqual(saved,again);assert.deepEqual(saved.selection,e.read.selection)
 assert.equal(await readFile(e.files.path(e.id),'utf8'),e.original);assert.equal(await readFile(join(e.root,'skills',saved.skill.installationId,'references/guide.txt'),'utf8'),'原附件不可执行')
 const native=await inspectNativeSkillDirectory(e.ctx,join(e.root,'skills',saved.skill.installationId));assert.equal(native.name,'original-flow');assert.equal(native.modelInvocable,false,'原调用政策不能因编辑变更')
 const content=await e.store.get({ownerId:e.owner,kind:'human'},{contentId:saved.skill.contentId});assert.deepEqual(content.trust.license,{status:'declared',value:'MIT'});assert.deepEqual(content.trust.permissions,[{id:'read:references',description:'读取原资料',required:true}]);assert.deepEqual(content.trust.signature,{status:'unverified',signer:null});assert.equal(content.trust.review.conclusion,'needs-review')
 assert.equal((await pool.query('select count(*)::int count from teloa_market_contents where owner_id=$1',[e.owner])).rows[0].count,2)
 assert.equal((await pool.query('select count(*)::int count from teloa_skill_installations where owner_id=$1',[e.owner])).rows[0].count,2)
 assert.equal((await e.handler('skill-edits/get',{installationId:saved.skill.installationId})).skill.state,'saved')
})

test('过期选择/原包、未知字段、凭据与跨本人拒绝，旧文件和当前选择无副作用',async t=>{
 const e=await fixture(t)
 for(const input of [{...e.input,expectedSelectionVersion:2},{...e.input,expectedBundleHash:'a'.repeat(64)},{...e.input,body:'stored-private-value'},{...e.input,ownerId:'other'},{...e.input,path:'/tmp'},{...e.input,nativeName:'renamed-flow'},{...e.input,body:''},{...e.input,body:'汉'.repeat(700000)},{...e.input,body:'x'.repeat(2*1024*1024)}])await assert.rejects(e.handler('skill-edits/save',input))
 const foreign=createSkillEditHandler({...e.ports,owner:'other'});await assert.rejects(foreign('skill-edits/get',{installationId:e.id}),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select count(*)::int count from teloa_market_contents where owner_id=$1',[e.owner])).rows[0].count,1);assert.equal(await readFile(e.files.path(e.id),'utf8'),e.original);assert.deepEqual((await e.handler('skill-edits/get',{installationId:e.id})).selection,e.read.selection)
})

test('停用原技能后编辑只保存修订，原停用和选定版本保持',async t=>{
 const e=await fixture(t);await pool.query("update teloa_skill_install_availability set availability='disabled',version=version+1 where owner_id=$1 and installation_id=$2",[e.owner,e.id])
 const saved=await e.handler('skill-edits/save',e.input);assert.equal(saved.skill.state,'saved');assert.equal((await e.handler('skill-edits/get',{installationId:e.id})).skill.state,'disabled');assert.deepEqual(saved.selection,e.read.selection)
})

test('自然语言工具 pin 原生审核等待前指令，带附件可用；更换指令不提交原编辑',async t=>{
 const e=await fixture(t),ctx=e.ctx;await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('skill-edit-session'),agentOptions:{provider:'test',model:'test'}});agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[{type:'text',text:'修改刚才的流程'},{type:'image',attachment:{id:'untrusted'}}] as any}),{surfaceOp:'append'})
 registerSkillEditTools(ctx,{owner:e.owner,conversation:async sessionId=>({ownerId:e.owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,handler:e.handler,admitText:e.ports.admitText})
 const {requestId:_,...args}=e.input,call=(name:string,input:Record<string,unknown>,id:string)=>ctx.tools.execute({agent,name,arguments:input,callId:ToolCallId(id),signal:AbortSignal.timeout(5000)})
 const read=await call('teloa_skill_get',{installationId:e.id},'read');assert.equal(read.isError,false)
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve}),finished=new Promise<void>(resolve=>{release=resolve});const stop=ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name==='teloa_skill_edit'){entered();await finished}return next()})
 const pending=call('teloa_skill_edit',args,'old-edit');await waiting;agent.session.append('turn/start',{turn:2});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'next'},content:[{type:'text',text:'先取消这次修改'}]}),{surfaceOp:'append'});release();assert.equal((await pending).isError,true);stop()
 assert.equal((await pool.query('select count(*)::int count from teloa_market_contents where owner_id=$1',[e.owner])).rows[0].count,1)
 const saved=await call('teloa_skill_edit',args,'new-edit');assert.equal(saved.isError,false,JSON.stringify(saved));const value=JSON.parse((saved.content[0] as any).text);assert.equal(value.sessionId,agent.id);assert.equal(value.skill.state,'saved')
})
