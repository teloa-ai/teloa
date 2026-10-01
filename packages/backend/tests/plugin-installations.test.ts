import test,{after,before,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type MarketPluginInstallObservation,type MarketPluginInstallPreview,type MarketPluginInstallReceipt,type MarketPluginInstallSpec,type MarketPluginRegistrySource} from '@teloa/contract'
import {initializePluginInstallations,PluginInstallationService,type PluginInstallPort} from '../src/market/plugin-installations.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const owner=randomUUID(),now='2026-09-13T08:00:00.000Z',identity={id:randomUUID,now:()=>now},hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const source:MarketPluginRegistrySource={registry:'npm',packageName:'@teloa/example-plugin',version:'1.2.3'}
const permissionSummary={permissions:[{id:'workspace.read',description:'读取当前工作区',required:true}]}
const preview:MarketPluginInstallPreview={schema:'teloa.market-plugin-install-preview/v1',source,trust:{status:'verified',publisher:'Teloa Labs',integrity:'sha512-QWxhZGRpbjpjpbnRlZ3JpdHk='},bundleHash:hash('bundle'),permissionSummary}
const active:MarketPluginInstallObservation={schema:'teloa.market-plugin-install-observation/v1',status:'active',source,bundleHash:preview.bundleHash,permissionSummary}
const succeeded:MarketPluginInstallReceipt={schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'}
const spec=(requestId=randomUUID(),fixed=preview):MarketPluginInstallSpec=>({schema:'teloa.market-plugin-install-spec/v1',requestId,preview:fixed})

class Port implements PluginInstallPort{
 previewValue:unknown=preview
 observation:unknown=active
 receipts:unknown[]=[succeeded]
 installCalls=0
 activeCalls=0
 maxActive=0
 slow=false
 previewError:Error|undefined
 installError:Error|undefined
 observeError:Error|undefined
 enableCalls:MarketPluginInstallPreview[]=[]
 enableError:Error|undefined
 async preview(requested:MarketPluginRegistrySource):Promise<unknown>{assert.equal(requested.packageName,source.packageName);if(this.previewError)throw this.previewError;return structuredClone(this.previewValue)}
 async install(_fixed:MarketPluginInstallPreview):Promise<unknown>{this.installCalls++;this.activeCalls++;this.maxActive=Math.max(this.maxActive,this.activeCalls);try{if(this.slow)await new Promise(resolve=>setTimeout(resolve,30));if(this.installError)throw this.installError;return structuredClone(this.receipts.shift()??succeeded)}finally{this.activeCalls--}}
 async observe(_requested:MarketPluginRegistrySource):Promise<unknown>{if(this.observeError)throw this.observeError;return structuredClone(this.observation)}
 async enable(requested:MarketPluginInstallPreview):Promise<void>{this.enableCalls.push(requested);if(this.enableError)throw this.enableError}
}

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializePluginInstallations(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
beforeEach(async()=>{await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations')})

test('两个服务实例并发安装同一 package 时跨实例单飞',async()=>{
 const port=new Port();port.slow=true
 const first=new PluginInstallationService(pool,identity,port),second=new PluginInstallationService(pool,identity,port)
 const [a,b]=await Promise.all([first.install(owner,spec()),second.install(owner,spec())])
 assert.equal(a.id,b.id);assert.equal(a.state,'installed-active');assert.equal(port.installCalls,1);assert.equal(port.maxActive,1)
})

test('稳定 requestId 重放同一 spec，异 spec 明确冲突',async()=>{
 const port=new Port(),service=new PluginInstallationService(pool,identity,port),requestId=randomUUID()
 const first=await service.install(owner,spec(requestId)),replayed=await service.install(owner,spec(requestId))
 assert.equal(replayed.id,first.id);assert.equal(port.installCalls,1)
 await assert.rejects(service.install(owner,spec(requestId,{...preview,bundleHash:hash('other')})),{code:'teloa/conflict'})
})

test('已完成或 unknown 请求重放不再依赖 registry，unknown 只核对原生状态',async()=>{
 const port=new Port(),service=new PluginInstallationService(pool,identity,port),completedRequest=randomUUID()
 const completed=await service.install(owner,spec(completedRequest))
 port.previewError=new Error('registry unavailable')
 const replayed=await service.install(owner,spec(completedRequest))
 assert.equal(replayed.id,completed.id);assert.equal(replayed.state,'installed-active');assert.equal(port.installCalls,1)

 await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations')
 port.previewError=undefined;port.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:'命令回包未知',retryable:true}}]
 port.observation={schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'暂不可读',retryable:true}}
 const unknownRequest=randomUUID(),unknown=await service.install(owner,spec(unknownRequest))
 assert.equal(unknown.state,'unknown')
 port.previewError=new Error('registry unavailable');port.observation=active
 const recovered=await service.install(owner,spec(unknownRequest))
 assert.equal(recovered.state,'installed-active');assert.equal(port.installCalls,2)
})

test('请求固定摘要被数据库改写时报告存储损坏而非普通幂等冲突',async()=>{
 const port=new Port(),service=new PluginInstallationService(pool,identity,port),requestId=randomUUID()
 await service.install(owner,spec(requestId))
 await pool.query("update teloa_plugin_install_requests set request_spec=jsonb_set(request_spec,'{preview,bundleHash}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,requestId,hash('tampered')])
 await assert.rejects(service.install(owner,spec(requestId)),{code:'teloa/storage-corrupt'})
})

test('执行前来源、版本、trust、bundleHash 或权限摘要变化均拒绝',async()=>{
 const mutations:MarketPluginInstallPreview[]=[
  {...preview,source:{...source,packageName:'@teloa/other-plugin'}},
  {...preview,source:{...source,version:'1.2.4'}},
  {...preview,trust:{...preview.trust,status:'unverified'}},
  {...preview,bundleHash:hash('changed')},
  {...preview,permissionSummary:{permissions:[{...permissionSummary.permissions[0]!,required:false}]}},
 ]
 for(const changed of mutations){await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations');const port=new Port();port.previewValue=changed;const service=new PluginInstallationService(pool,identity,port);await assert.rejects(service.install(owner,spec()),{code:'teloa/source-unavailable'});assert.equal(port.installCalls,0)}
})

test('安装不自动启用：状态停在 installed-pending-enable，启用是本人的第二次显式动作',async()=>{
 const port=new Port()
 // 装完包不在 dsh.profile.bundles 里，原生观察据此报 pending-enable。
 port.observation={...active,status:'pending-enable'}
 const service=new PluginInstallationService(pool,identity,port)
 const installed=await service.install(owner,spec())
 assert.equal(installed.state,'installed-pending-enable')
 assert.equal(installed.observation?.status,'pending-enable')
 assert.equal(port.enableCalls.length,0,'安装不得自行启用')
 // 启用把包加回 bundles；本进程尚未加载它，于是变成"需重启"。
 port.observation={...active,status:'restart-required'}
 const enabled=await service.install(owner,{...spec(),action:'enable'})
 assert.equal(enabled.id,installed.id)
 assert.equal(enabled.state,'installed-restart-required')
 assert.deepEqual(port.enableCalls,[preview])
 assert.equal(port.installCalls,1,'启用不得再跑一次安装命令')
 // 重启后同一份观察给出 active。
 port.observation=active
 assert.equal((await service.reconcile(owner,{installationId:installed.id})).state,'installed-active')
})

test('存量库的旧状态约束由重跑初始化迁移，待启用状态随后可写入',async()=>{
 // 复刻"这个库是在 installed-pending-enable 之前建的"：内联 check 只在建表那一次生效，
 // 旧约束留在库里，插件落到待启用状态时 insert 会违反它并被事务包装成"存储不可用"。
 await pool.query(`
  alter table teloa_plugin_installations drop constraint if exists teloa_plugin_installations_state_check;
  alter table teloa_plugin_installations add constraint teloa_plugin_installations_state_check
   check(state in ('preparing','installed-active','installed-restart-required','failed','unknown'));
 `)
 const port=new Port();port.observation={...active,status:'pending-enable'}
 const service=new PluginInstallationService(pool,identity,port)
 await assert.rejects(service.install(owner,spec()),{code:'teloa/storage-unavailable'},'旧约束下待启用状态写不进去')
 await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations')
 // 重跑初始化即迁移；幂等，连跑两次也不报错。
 await initializePluginInstallations(pool)
 await initializePluginInstallations(pool)
 assert.equal((await service.install(owner,spec())).state,'installed-pending-enable')
 // 迁移后的约束仍然拒绝表外的状态值。
 await assert.rejects(pool.query("update teloa_plugin_installations set state='installed-unknown-state' where owner_id=$1",[owner]))
})

test('未安装的插件不能启用，启用端口失败不改状态',async()=>{
 const port=new Port();port.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:'安装命令失败',retryable:true}}]
 const service=new PluginInstallationService(pool,identity,port)
 const failed=await service.install(owner,spec());assert.equal(failed.state,'failed')
 await assert.rejects(service.install(owner,{...spec(),action:'enable'}),{code:'teloa/conflict'})
 // 完全没有安装记录时，启用在 prepare 之前就被拒，不消耗 requestId。
 await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations')
 const requestId=randomUUID()
 await assert.rejects(service.install(owner,{...spec(requestId),action:'enable'}),{code:'teloa/not-found'})
 assert.equal((await pool.query('select count(*)::int as total from teloa_plugin_install_requests')).rows[0].total,0)
 port.receipts=[succeeded];port.observation={...active,status:'pending-enable'}
 await service.install(owner,spec())
 port.enableError=new Error('profile 补丁层不可写')
 await assert.rejects(service.install(owner,{...spec(),action:'enable'}),{code:'teloa/dependency-unavailable'})
 assert.equal((await service.list(owner,{})).items[0]?.state,'installed-pending-enable')
 // 端口核对不过时不得加回 bundles，记录保持待启用并回 conflict。
 port.enableError=new Error('enable-verification-failed')
 await assert.rejects(service.install(owner,{...spec(),action:'enable'}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{})).items[0]?.state,'installed-pending-enable')
 // 端口侧根本没有待启用记录（没走过安装路径，或已经启用过一次）：按找不到回，不是冲突。
 port.enableError=new Error('enable-not-pending')
 await assert.rejects(service.install(owner,{...spec(),action:'enable'}),{code:'teloa/not-found'})
 assert.equal((await service.list(owner,{})).items[0]?.state,'installed-pending-enable')
})

test('超时等留下的 unknown 回执经 reconcile 追上原生状态后仍不可启用',async()=>{
 const port=new Port()
 port.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:'命令回包未知',retryable:true}}]
 port.observation={schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'暂不可读',retryable:true}}
 const service=new PluginInstallationService(pool,identity,port)
 const unknown=await service.install(owner,spec())
 assert.equal(unknown.state,'unknown');assert.equal(unknown.receipt?.outcome,'unknown')
 // reconcile 只按原生观察追赶状态，不会补上一份"已核对"的安装回执。
 port.observation={...active,status:'pending-enable'}
 const caughtUp=await service.reconcile(owner,{installationId:unknown.id})
 assert.equal(caughtUp.state,'installed-pending-enable');assert.equal(caughtUp.receipt?.outcome,'unknown')
 await assert.rejects(service.install(owner,{...spec(),action:'enable'}),{code:'teloa/conflict'})
 assert.equal(port.enableCalls.length,0,'上一次安装未完整核对，不得放行到端口')
 assert.equal((await service.list(owner,{})).items[0]?.state,'installed-pending-enable')
})

test('组合补丁结论为拒绝的插件在落任何记录前就被拒安装',async()=>{
 const port=new Port();port.previewValue={...preview,trust:{...preview.trust,status:'rejected'}}
 const service=new PluginInstallationService(pool,identity,port)
 // 信任结论由宿主侧的补丁逐行核验得出；命中拒绝清单即不得安装，也不留安装记录与请求记录。
 await assert.rejects(service.install(owner,spec(randomUUID(),{...preview,trust:{...preview.trust,status:'rejected'}})),{code:'teloa/forbidden'})
 assert.equal(port.installCalls,0)
 assert.equal((await pool.query('select count(*)::int as total from teloa_plugin_installations')).rows[0].total,0)
 assert.equal((await pool.query('select count(*)::int as total from teloa_plugin_install_requests')).rows[0].total,0)
})

test('原生命令 exit 0 但观察身份不匹配时不能进入 active',async()=>{
 const port=new Port();port.observation={...active,source:{...source,version:'1.2.4'}}
 const value=await new PluginInstallationService(pool,identity,port).install(owner,spec())
 assert.equal(value.state,'failed');assert.equal(value.failure?.code,'observation-mismatch');assert.equal(port.installCalls,1)
})

test('失败记录使用同 requestId 可重试，unknown 只经 reconcile 按原生观察恢复',async()=>{
 const port=new Port(),service=new PluginInstallationService(pool,identity,port),failedRequest=randomUUID()
 port.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:'安装命令失败',retryable:true}},succeeded]
 const failed=await service.install(owner,spec(failedRequest));assert.equal(failed.state,'failed');assert.equal(failed.attempt,1)
 const retried=await service.install(owner,spec(failedRequest));assert.equal(retried.state,'installed-active');assert.equal(retried.attempt,2);assert.equal(port.installCalls,2)

 await pool.query('truncate teloa_plugin_install_requests,teloa_plugin_installations')
 port.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:'命令回包未知',retryable:true}}]
 port.observation={schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'原生目录暂不可读',retryable:true}}
 const unknown=await service.install(owner,spec());assert.equal(unknown.state,'unknown');assert.equal(unknown.failure?.code,'install-unknown')
 port.observation=active
 const reconciled=await service.reconcile(owner,{installationId:unknown.id});assert.equal(reconciled.state,'installed-active');assert.equal(port.installCalls,3)
 const stored=await service.get(owner,{installationId:unknown.id});assert.equal(stored.id,unknown.id);assert.equal(stored.failure,undefined)
})

// install() 在 prepare() 之前先核对一次来源，prepare() 提交后 run() 又核对第二次；
// 让端口的 preview() 第一次核对通过、第二次核对不通过，就能复刻"prepare() 已提交、
// run() 才发现不一致并整体回滚"——记录停在 preparing，磁盘上什么都还没做，正是进程在
// 落库与调用 dsh 之间被杀的样子。
class StuckPreparingPort extends Port{
 private calls=0
 override async preview(requested:MarketPluginRegistrySource):Promise<unknown>{
  this.calls++
  return structuredClone(this.calls===1?preview:{...preview,bundleHash:hash('changed')})
 }
}

test('启动核对目标只含准备中与结果未知的安装记录，按创建序且单轮不超过五十条',async()=>{
 const activeOwner=randomUUID(),preparingOwner=randomUUID(),unknownOwner=randomUUID()
 // 正常装完的记录不算待核对。
 await new PluginInstallationService(pool,identity,new Port()).install(activeOwner,spec())

 // 停在 preparing 的记录：见 StuckPreparingPort 注释。
 await assert.rejects(new PluginInstallationService(pool,identity,new StuckPreparingPort()).install(preparingOwner,spec()),{code:'teloa/source-unavailable'})
 const preparingRow=(await pool.query('select id from teloa_plugin_installations where owner_id=$1',[preparingOwner])).rows[0] as {id:string}

 // 结果未知的记录（例如原生命令超时）同样要核对。
 const unknownPort=new Port()
 unknownPort.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:'命令回包未知',retryable:true}}]
 unknownPort.observation={schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'暂不可读',retryable:true}}
 const unknownService=new PluginInstallationService(pool,identity,unknownPort)
 const unknownInstalled=await unknownService.install(unknownOwner,spec())
 assert.equal(unknownInstalled.state,'unknown')

 assert.deepEqual(await unknownService.outstanding(activeOwner),[])
 assert.deepEqual(await unknownService.outstanding(preparingOwner),[preparingRow.id])
 assert.deepEqual(await unknownService.outstanding(unknownOwner),[unknownInstalled.id])
})

test('被中断的准备中安装经核对后落为已安装待启用且回执仍为空',async()=>{
 const testOwner=randomUUID()
 const stuckPort=new StuckPreparingPort()
 const service=new PluginInstallationService(pool,identity,stuckPort)
 await assert.rejects(service.install(testOwner,spec()),{code:'teloa/source-unavailable'})
 const row=(await pool.query('select id from teloa_plugin_installations where owner_id=$1',[testOwner])).rows[0] as {id:string}

 // 磁盘现状 = 包在盘、不在 bundles、有待启用记录：这正是"装了但进程在写回执之前被杀"留下的样子。
 stuckPort.observation={...active,status:'pending-enable'}
 const after=await service.reconcile(testOwner,{installationId:row.id})
 assert.equal(after.state,'installed-pending-enable')
 assert.equal(after.receipt,undefined,'回执从未写下，中断态靠这一点与正常待启用区分')
 await assert.rejects(service.install(testOwner,{...spec(),action:'enable'}),{code:'teloa/conflict'})
})

test('被中断的待启用记录可用新请求重新安装，追上成功回执后才可启用',async()=>{
 const testOwner=randomUUID()
 const stuckPort=new StuckPreparingPort()
 const stuckService=new PluginInstallationService(pool,identity,stuckPort)
 await assert.rejects(stuckService.install(testOwner,spec()),{code:'teloa/source-unavailable'})
 const row=(await pool.query('select id from teloa_plugin_installations where owner_id=$1',[testOwner])).rows[0] as {id:string}
 stuckPort.observation={...active,status:'pending-enable'}
 const interrupted=await stuckService.reconcile(testOwner,{installationId:row.id})
 assert.equal(interrupted.state,'installed-pending-enable');assert.equal(interrupted.receipt,undefined)

 // 重装用新请求 ID，走与首装完全相同的路径：正常端口，真的重新调用一次 port.install()。
 const freshPort=new Port();freshPort.observation={...active,status:'pending-enable'}
 const freshService=new PluginInstallationService(pool,identity,freshPort)
 const reinstalled=await freshService.install(testOwner,spec(randomUUID()))
 assert.equal(reinstalled.id,row.id)
 assert.equal(freshPort.installCalls,1,'中断态必须真的重新触发一次安装命令，不能是空操作')
 assert.equal(reinstalled.receipt?.outcome,'succeeded')
 assert.equal(reinstalled.state,'installed-pending-enable')
 assert.equal(reinstalled.attempt,interrupted.attempt+1)

 // 追上成功回执后，启用不再被"上次安装未完整核对"的判据拦下。
 freshPort.observation={...active,status:'restart-required'}
 const enabled=await freshService.install(testOwner,{...spec(),action:'enable'})
 assert.equal(enabled.state,'installed-restart-required')
 assert.deepEqual(freshPort.enableCalls,[preview])
})

test('已确认成功的待启用记录不会被误判为可重装：重装不重置状态、不重新触发安装命令',async()=>{
 const testOwner=randomUUID()
 const port=new Port();port.observation={...active,status:'pending-enable'}
 const service=new PluginInstallationService(pool,identity,port)
 const installed=await service.install(testOwner,spec())
 assert.equal(installed.state,'installed-pending-enable');assert.equal(installed.receipt?.outcome,'succeeded')
 const reinstalled=await service.install(testOwner,spec(randomUUID()))
 assert.equal(reinstalled.id,installed.id)
 assert.equal(reinstalled.state,'installed-pending-enable')
 assert.equal(reinstalled.attempt,installed.attempt)
 assert.equal(reinstalled.receipt?.outcome,'succeeded')
 assert.equal(port.installCalls,1,'已确认成功的待启用记录重装必须是空操作，不得重新触发安装命令')
})

// 改版前存进记录的旧说明（「该插件会新增…」）：比对只看权限 id 与 required，启用、核对、重装全部照常；
// id 或 required 真变化时仍然拒绝。
const bundlePermissions=(word:string)=>({permissions:[
 {id:'dsh.bundle',description:'将加载 DSH 宿主配置层。',required:true},
 {id:'dsh.bundle.insert:example-extra',description:'该'+word+'会新增 DSH 组合配置行 example-extra。',required:true},
]})
const legacyPreview:MarketPluginInstallPreview={...preview,permissionSummary:bundlePermissions('插件')}
const currentPreview:MarketPluginInstallPreview={...preview,permissionSummary:bundlePermissions('扩展')}
const currentObservation=(status:'active'|'restart-required'|'pending-enable'):MarketPluginInstallObservation=>({schema:'teloa.market-plugin-install-observation/v1',status,source,bundleHash:preview.bundleHash,permissionSummary:currentPreview.permissionSummary})

test('旧文案存储的预览：升级后核对、启用、同请求重放与重装都通过',async()=>{
 const testOwner=randomUUID(),firstRequest=randomUUID()
 // 升级前：registry 与原生观察都给旧文案，记录里存下旧文案的预览。
 const before=new Port();before.previewValue=legacyPreview;before.observation={...currentObservation('pending-enable'),permissionSummary:legacyPreview.permissionSummary}
 const installed=await new PluginInstallationService(pool,identity,before).install(testOwner,spec(firstRequest,legacyPreview))
 assert.equal(installed.state,'installed-pending-enable')
 assert.equal(installed.preview.permissionSummary.permissions[1]!.description,'该插件会新增 DSH 组合配置行 example-extra。')
 // 升级后：registry 与原生观察给新文案。
 const after=new Port();after.previewValue=currentPreview;after.observation=currentObservation('pending-enable')
 const service=new PluginInstallationService(pool,identity,after)
 assert.equal((await service.reconcile(testOwner,{installationId:installed.id})).state,'installed-pending-enable')
 assert.equal((await service.install(testOwner,spec(firstRequest,currentPreview))).id,installed.id,'同请求重放只因说明文字不同不算另一份规格')
 assert.equal((await service.install(testOwner,spec(randomUUID(),currentPreview))).id,installed.id,'新请求按同一预览命中原记录')
 assert.equal(after.installCalls,0,'已确认成功的待启用记录不重装')
 after.observation=currentObservation('restart-required')
 const enabled=await service.install(testOwner,{...spec(randomUUID(),installed.preview),action:'enable'})
 assert.equal(enabled.state,'installed-restart-required')
 assert.equal(after.enableCalls.length,1)
 after.observation=currentObservation('active')
 assert.equal((await service.reconcile(testOwner,{installationId:installed.id})).state,'installed-active')
})

test('旧文案存储的失败记录可用新文案预览重装；权限 id 或 required 变化仍拒绝',async()=>{
 const testOwner=randomUUID()
 const before=new Port();before.previewValue=legacyPreview
 before.receipts=[{schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:'安装命令失败',retryable:true}}]
 const failed=await new PluginInstallationService(pool,identity,before).install(testOwner,spec(randomUUID(),legacyPreview))
 assert.equal(failed.state,'failed')
 const after=new Port();after.previewValue=currentPreview;after.observation=currentObservation('pending-enable')
 const service=new PluginInstallationService(pool,identity,after)
 for(const changed of [
  {permissions:[currentPreview.permissionSummary.permissions[0]!,{...currentPreview.permissionSummary.permissions[1]!,required:false}]},
  {permissions:[currentPreview.permissionSummary.permissions[0]!,{...currentPreview.permissionSummary.permissions[1]!,id:'dsh.bundle.insert:other-row'}]},
 ]){
  const drifted={...currentPreview,permissionSummary:changed}
  after.previewValue=drifted
  await assert.rejects(service.install(testOwner,spec(randomUUID(),drifted)),{code:'teloa/conflict'},'权限真变化时不能套用原记录')
  after.previewValue=currentPreview
  after.observation={...currentObservation('pending-enable'),permissionSummary:changed}
  const mismatched=await service.install(testOwner,spec(randomUUID(),currentPreview))
  assert.equal(mismatched.state,'failed');assert.equal(mismatched.failure?.code,'observation-mismatch','原生观察的权限真变化时判为不一致')
  after.observation=currentObservation('pending-enable')
 }
 const reinstalled=await service.install(testOwner,spec(randomUUID(),currentPreview))
 assert.equal(reinstalled.id,failed.id)
 assert.equal(reinstalled.state,'installed-pending-enable')
})

test('原生端口抛出的非合同长错误被收窄并保留 unknown 可恢复记录',async()=>{
 const port=new Port();port.installError=new Error('x'.repeat(2000))
 const service=new PluginInstallationService(pool,identity,port),value=await service.install(owner,spec())
 assert.equal(value.state,'unknown');assert.equal(value.failure?.code,'install-unknown');assert.ok((value.failure?.message.length??0)<=1000)
 port.installError=undefined;port.observeError=new Error(' '.repeat(2000))
 const reconciled=await service.reconcile(owner,{installationId:value.id})
 assert.equal(reconciled.state,'unknown');assert.equal(reconciled.failure?.code,'observation-unavailable');assert.ok((reconciled.failure?.message.length??0)>0)
})
