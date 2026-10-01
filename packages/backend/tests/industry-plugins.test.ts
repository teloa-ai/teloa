import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,marketPluginInstallationStates,type MarketPluginInstallPreview,type MarketPluginInstallSpec,type MarketPluginRegistrySource} from '@teloa/contract'
import type {PluginInstallation} from '../src/market/plugin-installations.ts'
import {IndustryPluginService,IndustryLoadService,initializeIndustryPlugins,initializeIndustryLoads,projectPluginState,type IndustryPluginSourceSnapshot,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool);await initializeIndustryPlugins(pool)})
after(async()=>{await pool?.end();await container?.stop()})

const contentId=randomUUID(),contentHash='a'.repeat(64),snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',resources:[{localId:'visualize-plugin',kind:'plugin' as const,title:'dsh-visualize',version:'0.1.2',required:false,available:true}],relations:[],entrypoints:[]}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const valid={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'}
const sourceReader=(loads:IndustryLoadService,read?:(value:IndustryPluginSourceSnapshot)=>IndustryPluginSourceSnapshot)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId);assert.ok(item);const value={loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:valid};return read?read(value):value}})

const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const registrySource:MarketPluginRegistrySource={registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}
const permissionSummary={permissions:[{id:'workspace.read',description:'读取当前工作区',required:true}]}
const previewFixture:MarketPluginInstallPreview={schema:'teloa.market-plugin-install-preview/v1',source:registrySource,trust:{status:'verified',publisher:'Teloa Labs',integrity:'sha512-QWxhZGRpbjpjpbnRlZ3JpdHk='},bundleHash:sha('bundle'),permissionSummary}
const installationFixture:PluginInstallation={id:randomUUID(),ownerId:'',preview:previewFixture,state:'preparing',attempt:1,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'}

test('projectPluginState 覆盖全部安装状态',()=>{
 for(const state of marketPluginInstallationStates)assert.ok(['needs_install','installing','pending-enable','active','restart-required','failed'].includes(projectPluginState(state)))
 assert.equal(projectPluginState('installed-active'),'active')
 assert.equal(projectPluginState('installed-restart-required'),'restart-required')
 assert.equal(projectPluginState('installed-pending-enable'),'pending-enable')
 assert.equal(projectPluginState('failed'),'failed')
 assert.equal(projectPluginState('preparing'),'installing')
 assert.equal(projectPluginState('unknown'),'installing')
})

test('插件登记时复用本人已有同版本安装并投影其状态',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'插件空间'}})
 const existing:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner,state:'installed-active'}
 const plugins={preview:async()=>{throw Error('不应预览')},install:async()=>{throw Error('不应安装')},reconcile:async()=>existing,find:async(actor:string,src:MarketPluginRegistrySource)=>{assert.equal(actor,owner);assert.deepEqual(src,{registry:'npm',packageName:'dsh-visualize',version:'0.1.2'});return existing}}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins),input={requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 const created=await service.instantiate(owner,input)
 assert.equal(created.state,'active');assert.equal(created.installationId,existing.id);assert.deepEqual(created.definition,valid);assert.equal(created.revision,1);assert.equal(created.scope,load.space.scope)
 assert.deepEqual(await service.instantiate(owner,input),created)
 assert.deepEqual((await service.list(owner,{})).items,[created]);assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
})

test('行业插件拒绝执行工具目标、跨本人读取及损坏固定映射',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},executionTool:IndustryLoadSource={read:async()=>({...snapshot,resources:[{...snapshot.resources[0]!,kind:'execution-tool' as const}]})},loads=new IndustryLoadService(pool,identity,executionTool)
 const plugins={preview:async()=>previewFixture,install:async()=>installationFixture,reconcile:async()=>installationFixture,find:async()=>null}
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'6'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'执行空间'}}),service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins)
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/conflict'})
 const properLoads=new IndustryLoadService(pool,identity,source),proper=await properLoads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'7'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'插件读取空间'}}),properService=new IndustryPluginService(pool,identity,properLoads,sourceReader(properLoads),plugins),saved=await properService.instantiate(owner,{requestId:randomUUID(),loadId:proper.id,itemInstanceId:proper.items[0]!.instanceId})
 await assert.rejects(properService.get('other',{instanceId:saved.id}),{code:'teloa/forbidden'})
 await pool.query('update teloa_industry_plugin_instances set item_local_id=$2 where id=$1',[saved.id,'other'])
 await assert.rejects(properService.get(owner,{instanceId:saved.id}),{code:'teloa/storage-corrupt'})
})

test('无既有安装时登记为 needs_install，install 走预览与安装并同请求恢复',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'安装空间'}})
 let installs=0
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async(actor:string,spec:MarketPluginInstallSpec)=>{installs+=1;assert.equal(actor,owner);assert.deepEqual(spec.preview,previewFixture);return {...installed,state:'preparing' as const}},reconcile:async()=>({...installed,state:'installed-active' as const})}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 assert.equal(created.state,'needs_install');assert.equal(created.installationId,null)
 const command={requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture},first=await service.install(owner,command)
 assert.equal(first.state,'installing');assert.equal(first.installationId,installed.id);assert.equal(first.revision,2)
 assert.deepEqual(await service.install(owner,command),first);assert.equal(installs,1)
 const reconciled=await service.reconcile(owner,{instanceId:created.id})
 // 核对改变了投影状态，所以修订递增；状态未变化时提前返回，修订保持不动。
 assert.equal(reconciled.state,'active');assert.equal(reconciled.revision,3)
 assert.deepEqual(await service.reconcile(owner,{instanceId:created.id}),reconciled)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),reconciled)
 assert.equal((await pool.query('select revision from teloa_industry_plugin_instances where id=$1',[created.id])).rows[0].revision,3)
})

test('预览或安装失败时不写 installationId 与回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'c'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'失败空间'}})
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>{throw new WorkError('teloa/source-unavailable','npm 不可达')},reconcile:async()=>{throw Error('不应核对')}}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID()
 await assert.rejects(service.install(owner,{requestId,instanceId:created.id,expectedRevision:1,preview:previewFixture}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_plugin_install_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_plugin_instances where owner_id=$1 and installation_id is not null',[owner])).rows[0].count,0)
})

test('并发 install 只有一个推进同一预期版本',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'d'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'并发空间'}})
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 let installs=0
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>{installs+=1;return {...installed,state:'preparing' as const}},reconcile:async()=>({...installed,state:'installed-active' as const})}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const settled=await Promise.allSettled([service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture}),service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture})])
 assert.equal(settled.filter(result=>result.status==='fulfilled').length,1)
 const failure=settled.find(result=>result.status==='rejected') as PromiseRejectedResult
 assert.equal(failure.reason.code,'teloa/version-conflict')
 assert.equal((await service.get(owner,{instanceId:created.id})).revision,2)
 // 两侧都会调用宿主安装：宿主按 (owner,requestId)/(owner,package) 幂等，落败方重试会收敛到同一安装。
 assert.equal(installs,2)
})

test('激活后固定定义被篡改则回落为待安装的漂移投影并停止使用当前安装',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'e'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'篡改空间'}})
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner,state:'installed-active' as const}
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>installed,reconcile:async()=>installed}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const activated=await service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture})
 assert.equal(activated.state,'active')
 await pool.query(`update teloa_industry_plugin_instances set definition=jsonb_set(definition,'{packageName}','"evil-pkg"') where id=$1`,[created.id])
 const projected=await service.get(owner,{instanceId:created.id})
 assert.equal(projected.state,'needs_install');assert.equal(projected.drift,true);assert.equal(projected.installationId,installed.id)
 await assert.rejects(service.reconcile(owner,{instanceId:created.id}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:projected.revision,preview:previewFixture}),{code:'teloa/source-unavailable'})
 assert.equal((await pool.query('select state from teloa_industry_plugin_instances where id=$1',[created.id])).rows[0].state,'active')
})

test('端口返回他人安装、来源不符或核对身份不符时抛来源不可用且不写状态',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 const prepare=async(name:string,plugins:ConstructorParameters<typeof IndustryPluginService>[4])=>{
  const loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:sha(name),target:{kind:'new',spaceId:randomUUID(),name}})
  const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins)
  return {service,created:await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})}
 }
 const foreign=await prepare('他人安装空间',{find:async()=>null,preview:async()=>previewFixture,install:async()=>({...installed,ownerId:randomUUID()}),reconcile:async()=>{throw Error('不应核对')}})
 const requestId=randomUUID()
 await assert.rejects(foreign.service.install(owner,{requestId,instanceId:foreign.created.id,expectedRevision:1,preview:previewFixture}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await foreign.service.get(owner,{instanceId:foreign.created.id}),foreign.created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_plugin_install_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)

 const drifted=await prepare('来源不符空间',{find:async()=>null,preview:async()=>previewFixture,install:async()=>({...installed,preview:{...previewFixture,source:{...registrySource,version:'9.9.9'}}}),reconcile:async()=>{throw Error('不应核对')}})
 await assert.rejects(drifted.service.install(owner,{requestId:randomUUID(),instanceId:drifted.created.id,expectedRevision:1,preview:previewFixture}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await drifted.service.get(owner,{instanceId:drifted.created.id}),drifted.created)

 const swapped=await prepare('核对身份空间',{find:async()=>null,preview:async()=>previewFixture,install:async()=>installed,reconcile:async()=>({...installed,id:randomUUID()})})
 const bound=await swapped.service.install(owner,{requestId:randomUUID(),instanceId:swapped.created.id,expectedRevision:1,preview:previewFixture})
 assert.equal(bound.installationId,installed.id);assert.equal(bound.state,'installing')
 await assert.rejects(swapped.service.reconcile(owner,{instanceId:swapped.created.id}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await swapped.service.get(owner,{instanceId:swapped.created.id}),bound)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_plugin_instances where owner_id=$1 and installation_id is not null',[owner])).rows[0].count,1)
})

test('固定来源漂移后目录投影为待安装并保留安装身份，写路径与核对仍判定来源不可用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'8'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移投影空间'}})
 let drifted=false
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>({...installed,state:'preparing' as const}),reconcile:async()=>({...installed,state:'installed-active' as const})}
 const reader=sourceReader(loads,value=>drifted?{...value,fileHash:'0'.repeat(64)}:value),service=new IndustryPluginService(pool,identity,loads,reader,plugins)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const installing=await service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture})
 assert.equal(installing.state,'installing');assert.ok(!('drift' in installing))
 drifted=true
 const projected=await service.get(owner,{instanceId:created.id})
 assert.deepEqual(projected,{...installing,state:'needs_install',drift:true})
 assert.equal(projected.installationId,installed.id)
 assert.deepEqual(await service.list(owner,{}),{items:[projected]})
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:projected.revision,preview:previewFixture}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.reconcile(owner,{instanceId:created.id}),{code:'teloa/source-unavailable'})
 const stored=(await pool.query('select state,revision,installation_id from teloa_industry_plugin_instances where id=$1',[created.id])).rows[0]
 assert.equal(stored.state,'installing');assert.equal(stored.revision,2);assert.equal(stored.installation_id,installed.id)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_plugin_install_requests where owner_id=$1',[owner])).rows[0].count,1)
})

test('目录逐行容错：损坏的插件实例只记入 errors，其余实例照常返回',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const first=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'9'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间甲'}})
 const second=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'0'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间乙'}})
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>{throw Error('不应安装')},reconcile:async()=>{throw Error('不应核对')}}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins)
 const broken=await service.instantiate(owner,{requestId:randomUUID(),loadId:first.id,itemInstanceId:first.items[0]!.instanceId})
 const good=await service.instantiate(owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:second.items[0]!.instanceId})
 await pool.query('update teloa_industry_plugin_instances set item_local_id=$2 where id=$1',[broken.id,'tampered'])
 assert.deepEqual(await service.list(owner,{}),{items:[good],errors:[{instanceId:broken.id,code:'teloa/storage-corrupt'}]})
 await assert.rejects(service.get(owner,{instanceId:broken.id}),{code:'teloa/storage-corrupt'})
})

test('行业安装接入知情同意：预览只读、安装持固定预览提交、待启用需二次显式启用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:sha('知情同意空间'),target:{kind:'new',spaceId:randomUUID(),name:'知情同意空间'}})
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 let previews=0,enables=0,installs=0
 const specs:MarketPluginInstallSpec[]=[]
 const plugins={
  find:async()=>null,
  preview:async()=>{previews+=1;return previewFixture},
  install:async(_actor:string,spec:MarketPluginInstallSpec)=>{
   specs.push(spec)
   if(spec.action==='enable'){enables+=1;return {...installed,state:'installed-restart-required' as const}}
   installs+=1;return {...installed,state:'installed-pending-enable' as const}
  },
  reconcile:async()=>({...installed,state:'installed-pending-enable' as const}),
 }
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 // ① 预览只读：不推进状态、不落记录，权限与信任结论原样交给客户端。
 assert.deepEqual(await service.preview(owner,{instanceId:created.id}),previewFixture)
 assert.equal(previews,1);assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 // ② 安装由客户端持这一份固定预览提交；服务端不再自己取一次预览。
 const pending=await service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture})
 assert.equal(pending.state,'pending-enable');assert.equal(pending.installationId,installed.id);assert.equal(pending.revision,2)
 assert.equal(previews,1);assert.equal(installs,1);assert.deepEqual(specs[0]!.preview,previewFixture);assert.equal(specs[0]!.action,undefined)
 // ③ 启用是第二次显式动作，走市场路径同一条服务端实现。
 const enabled=await service.enable(owner,{instanceId:pending.id,preview:previewFixture})
 assert.equal(enabled.state,'restart-required');assert.equal(enables,1);assert.equal(specs[1]!.action,'enable')
 // 已经启用过的实例不能再走一次启用。
 await assert.rejects(service.enable(owner,{instanceId:pending.id,preview:previewFixture}),{code:'teloa/conflict'})
 assert.equal(enables,1)
})

test('固定预览与插件定义来源不符时，安装与启用都在动手之前拒绝',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:sha('预览不符空间'),target:{kind:'new',spaceId:randomUUID(),name:'预览不符空间'}})
 const installed:PluginInstallation={...installationFixture,id:randomUUID(),ownerId:owner}
 let installs=0
 const plugins={find:async()=>null,preview:async()=>previewFixture,install:async()=>{installs+=1;return {...installed,state:'installed-pending-enable' as const}},reconcile:async()=>({...installed,state:'installed-pending-enable' as const})}
 const service=new IndustryPluginService(pool,identity,loads,sourceReader(loads),plugins)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const foreign={...previewFixture,source:{...registrySource,packageName:'other-plugin'}}
 await assert.rejects(service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:foreign}),{code:'teloa/source-unavailable'})
 // 预览格式不对同样不进任何写路径。
 await assert.rejects(service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:{...previewFixture,bundleHash:'zz'}}),{code:'teloa/invalid-input'})
 assert.equal(installs,0);assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 const pending=await service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,preview:previewFixture})
 assert.equal(pending.state,'pending-enable')
 await assert.rejects(service.enable(owner,{instanceId:pending.id,preview:foreign}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.enable(owner,{instanceId:pending.id,preview:{...previewFixture,extra:true} as never}),{code:'teloa/invalid-input'})
})
