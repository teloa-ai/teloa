import test,{after,before,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeSkillInstallations,SkillInstallationService,type NativeSkillMetadata,type SkillInstallationFilesPort,type SkillInstallation} from '../src/market/skill-installations.ts'
import {initializeTaskRunSkillRefs} from '../src/work/task-run-skill-refs.ts'
import type {SkillInstallSourceBundle,SkillInstallSourceInput} from '../src/market/skill-install-source.ts'

// 技能硬卸载：真实删除原生文件、依赖记录与安装行；先锁校验 blockers，文件与 DB 分两段，失败允许原请求重试。
let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-12T12:00:00.000Z',identity={id:randomUUID,now:()=>now},owner=randomUUID()
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const native:NativeSkillMetadata={name:'research-brief',description:'形成研究简报',modelInvocable:true,userInvocable:true,bodyHash:hash('body')}
const atomicSource={kind:'atomic' as const,contentId:randomUUID(),contentHash:hash('atomic'),resourceId:'research-brief',resourceVersion:'1.0.0'}
const bundleHash=hash('bundle')
const bundle=(source:import('../src/market/skill-install-source.ts').SkillInstallSourceIdentity=atomicSource):SkillInstallSourceBundle=>({ownerId:owner,source,entryPath:'SKILL.md',files:[{path:'SKILL.md',hash:hash('skill'),bytes:new TextEncoder().encode('skill')}],bundleHash})
class Reader{values=new Map<string,SkillInstallSourceBundle>();async read(who:string,input:SkillInstallSourceInput){if(who!==owner)throw new WorkError('teloa/forbidden','wrong owner');const value=this.values.get(JSON.stringify(input));if(!value)throw new WorkError('teloa/source-unavailable','missing');return structuredClone(value)}}
class Files implements SkillInstallationFilesPort{
 removed:string[]=[];failRemoveOnce=false;failPublish=false
 async inspect(){return native}
 async publish(){if(this.failPublish){this.failPublish=false;throw new WorkError('teloa/storage-unavailable','publish lost')}}
 async verify(){}
 async remove(id:string){this.failRemoveOnce=false;this.removed.push(id)}
}
const setup=()=>{const reader=new Reader(),files=new Files();return {reader,files,service:new SkillInstallationService(pool,identity,reader,files)}}
const install=async(reader:Reader,service:SkillInstallationService)=>{const input={kind:'atomic' as const,contentId:randomUUID()},value=bundle({...atomicSource,contentId:input.contentId});reader.values.set(JSON.stringify(input),value);return (await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:value.bundleHash})).installation}
const uninstallRequest=(installation:SkillInstallation,patch:Record<string,unknown>={})=>({requestId:randomUUID(),installationId:installation.id,expectedVersion:installation.version,expectedBundleHash:installation.bundleHash,confirm:true,...patch})
const blockersOf=async(error:Promise<unknown>):Promise<{code?:string;details?:{reason?:string;blockers?:string[]}}>=>{try{await error}catch(caught){return caught as {code?:string;details?:{reason?:string;blockers?:string[]}}}throw Error('应当拒绝')}

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeSkillInstallations(pool);await pool.query('create table if not exists teloa_task_runs(id uuid primary key, owner_id text not null)');await initializeTaskRunSkillRefs(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
beforeEach(async()=>{await pool.query('truncate teloa_task_run_skill_refs,teloa_task_runs,teloa_skill_uninstall_requests,teloa_skill_selection_requests,teloa_skill_install_maintenance_requests,teloa_skill_install_availability,teloa_skill_install_usages,teloa_skill_install_requests,teloa_skill_selections,teloa_skill_installations')})

/** 卸下初始选择：卸载成功路径要求本人已切换/停用当前选择。 */
const releaseSelection=async(id:string)=>{await pool.query('delete from teloa_skill_selections where owner_id=$1 and installation_id=$2',[owner,id])}

test('卸载真实删除文件、依赖记录与安装行，native 名称/摘要回执准确',async()=>{
 const {reader,files,service}=setup(),installed=await install(reader,service)
 assert.equal((await pool.query('select count(*)::int n from teloa_skill_selections where owner_id=$1 and installation_id=$2',[owner,installed.id])).rows[0].n,1,'安装后应自动成为当前选中')
 // 单版本技能即使当前选中也允许硬卸载：否则永远卸不掉；清掉指向它的选择行后外键才能删安装行。
 const request=uninstallRequest(installed),receipt=await service.uninstall(owner,request)
 assert.deepEqual(receipt,{requestId:request.requestId,installationId:installed.id,nativeName:native.name,bundleHash:installed.bundleHash,removedAt:now})
 assert.deepEqual(files.removed,[installed.id])
 assert.deepEqual(await service.list(owner,{}),{items:[],usages:[]})
 assert.equal((await pool.query('select count(*)::int n from teloa_skill_selections where owner_id=$1 and installation_id=$2',[owner,installed.id])).rows[0].n,0,'卸载后选择行必须删除')
 for(const table of ['teloa_skill_installations','teloa_skill_install_requests','teloa_skill_install_availability','teloa_skill_install_maintenance_requests','teloa_skill_selection_requests']){
  assert.equal((await pool.query(`select count(*)::int n from ${table} where owner_id=$1`,[owner])).rows[0].n,0,table+' 应清空')
 }
 assert.deepEqual((await pool.query('select result from teloa_skill_uninstall_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0].result,receipt)
})

test('同 requestId 同 spec 幂等返回原回执；换版本或换请求则拒绝',async()=>{
 const {reader,files,service}=setup(),installed=await install(reader,service)
 const request=uninstallRequest(installed),first=await service.uninstall(owner,request)
 assert.deepEqual(await service.uninstall(owner,request),first,'重放同一请求必须返回原回执')
 assert.deepEqual(files.removed,[installed.id],'文件删除不能因重放重复执行')
 await assert.rejects(service.uninstall(owner,{...request,expectedVersion:installed.version+1}),{code:'teloa/conflict'})
 await assert.rejects(service.uninstall(owner,uninstallRequest(installed)),{code:'teloa/forbidden'},'安装已删除后新请求不能伪装成功')
})

test('版本/包摘要不符、未完成安装、非本人请求都显式失败且不动文件',async()=>{
 const {reader,files,service}=setup(),installed=await install(reader,service)
 await assert.rejects(service.uninstall(owner,uninstallRequest(installed,{expectedVersion:installed.version+1})),{code:'teloa/version-conflict'})
 await assert.rejects(service.uninstall(owner,uninstallRequest(installed,{expectedBundleHash:hash('other')})),{code:'teloa/version-conflict'})
 await assert.rejects(service.uninstall(randomUUID(),uninstallRequest(installed)),{code:'teloa/forbidden'})
 assert.deepEqual(files.removed,[])
 assert.equal((await service.list(owner,{})).items.length,1)
})

test('输入只接受完整确认请求：confirm 必真、不可夹带字段、uuid/版本/摘要必须合法',async()=>{
 const {reader,service}=setup(),installed=await install(reader,service)
 for(const invalid of [
  uninstallRequest(installed,{confirm:false}),
  {...uninstallRequest(installed),ownerId:'other'},
  uninstallRequest(installed,{requestId:'not-a-uuid'}),
  uninstallRequest(installed,{installationId:'not-a-uuid'}),
  uninstallRequest(installed,{expectedVersion:0}),
  uninstallRequest(installed,{expectedBundleHash:'xyz'}),
 ])await assert.rejects(service.uninstall(owner,invalid),{code:'teloa/invalid-input'})
})

test('当前选中、加载包使用、历史运行引用三类阻塞都拒绝并给出可执行原因',async()=>{
 const {reader,files,service}=setup(),first=await install(reader,service)
 // 同名另一版本存在时，选中的版本要求先切换要保留的版本；非选中版本可正常卸载。
 const secondInput={kind:'atomic' as const,contentId:randomUUID()}
 reader.values.set(JSON.stringify(secondInput),bundle({...atomicSource,contentId:secondInput.contentId}))
 const second=(await service.install(owner,{requestId:randomUUID(),source:secondInput,expectedBundleHash:bundleHash})).installation
 assert.equal((await pool.query('select installation_id from teloa_skill_selections where owner_id=$1 and native_name=$2',[owner,native.name])).rows[0]?.installation_id,first.id,'初始选择保持第一版')
 const selected=await blockersOf(service.uninstall(owner,uninstallRequest(first)))
 assert.equal(selected.code,'teloa/conflict')
 assert.equal(selected.details?.reason,'skill-in-use')
 assert.deepEqual(selected.details?.blockers,['selected'])
 await assert.rejects(service.uninstall(owner,uninstallRequest(first)),/要保留的版本/)
 assert.deepEqual(files.removed,[],'被阻塞时不能删文件')
 // 不选中的同名版本没有 blocker，可卸载；留下选中的第一版仍只有唯一版本。
 assert.equal((await service.uninstall(owner,uninstallRequest(second))).installationId,second.id)
 assert.deepEqual(files.removed,[second.id])
 assert.equal((await pool.query('select count(*)::int n from teloa_skill_installations where owner_id=$1 and native_name=$2',[owner,native.name])).rows[0].n,1)
 // 加载包使用：行业来源安装会生成 usage（唯一版本选中不再阻塞）。
 const industryInput={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()}
 const industrySource={...atomicSource,kind:'industry-local' as const,loadId:industryInput.loadId,itemInstanceId:industryInput.itemInstanceId}
 reader.values.set(JSON.stringify(industryInput),bundle(industrySource))
 const industry=(await service.install(owner,{requestId:randomUUID(),source:industryInput,expectedBundleHash:bundleHash})).installation
 const usage=await blockersOf(service.uninstall(owner,uninstallRequest(industry)))
 assert.deepEqual(usage.details?.blockers,['industry-usage'])
 assert.deepEqual(files.removed,[second.id],'行业 usage 阻塞时不能删文件')
 // 历史运行固定引用：保留运行证据，只可停用（该版本非当前选中，唯一阻塞就是运行引用）。
 const historyInput={kind:'atomic' as const,contentId:randomUUID()}
 reader.values.set(JSON.stringify(historyInput),bundle({...atomicSource,contentId:historyInput.contentId}))
 const history=(await service.install(owner,{requestId:randomUUID(),source:historyInput,expectedBundleHash:bundleHash})).installation
 const runId=randomUUID()
 await pool.query('insert into teloa_task_runs(id,owner_id) values($1,$2)',[runId,owner])
 await pool.query('insert into teloa_task_run_skill_refs(owner_id,run_id,installation_id,name,bundle_hash,files,ref_digest) values($1,$2,$3,$4,$5,$6,$7)',[owner,runId,history.id,native.name,history.bundleHash,'[]',hash('ref')])
 const runRef=await blockersOf(service.uninstall(owner,uninstallRequest(history)))
 assert.equal(runRef.code,'teloa/conflict')
 assert.deepEqual(runRef.details?.blockers,['run-history'])
 assert.deepEqual(files.removed,[second.id],'运行引用阻塞时不能删文件')
})

test('文件已删但删除事务失败时允许同一请求重试并只在成功后写回执',async()=>{
 const {reader,files,service}=setup(),installed=await install(reader,service)
 await releaseSelection(installed.id)
 const request=uninstallRequest(installed)
 // 第一次：文件删除成功后，第二个事务删除安装行时报错；此时不应留下回执。
 const originalRemove=files.remove.bind(files);let calls=0
 files.remove=async(id:string)=>{calls++;await originalRemove(id);if(calls===1)return;throw Error('不应触发')}
 const failingPool={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return new Proxy(db,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{if(calls===1&&typeof sql==='string'&&sql.startsWith('delete from teloa_skill_installations'))throw Error('db down');return (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args)};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool
 const failing=new SkillInstallationService(failingPool,identity,reader,files)
 await assert.rejects(failing.uninstall(owner,request))
 assert.deepEqual(files.removed,[installed.id],'文件已删')
 assert.equal((await pool.query('select count(*)::int n from teloa_skill_uninstall_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0].n,0,'失败不能写回执')
 assert.equal((await service.list(owner,{})).items.length,1,'DB 未删，安装仍在')
 // 重试同一请求：文件删除幂等，第二次事务成功。
 files.remove=async(id:string)=>{files.removed.push(id)}
 const receipt=await service.uninstall(owner,request)
 assert.equal(receipt.installationId,installed.id)
 assert.equal((await service.list(owner,{})).items.length,0)
})

test('preparing 状态的安装不能被硬卸载',async()=>{
 const {reader,files,service}=setup(),source={kind:'atomic' as const,contentId:randomUUID()}
 reader.values.set(JSON.stringify(source),bundle())
 files.failPublish=true
 await assert.rejects(service.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash}),{code:'teloa/storage-unavailable'})
 const preparing=(await service.list(owner,{})).items[0]!
 await assert.rejects(service.uninstall(owner,{requestId:randomUUID(),installationId:preparing.id,expectedVersion:preparing.version,expectedBundleHash:preparing.bundleHash,confirm:true}),{code:'teloa/conflict'})
 assert.deepEqual(files.removed,[])
})
