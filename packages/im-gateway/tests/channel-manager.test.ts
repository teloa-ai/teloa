import test from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import type {ImChannelKind} from '@teloa/contract'
import {createChannelManager,type ChannelManagerDeps} from '../src/core/channel-manager.ts'
import {createChannelConfigStore} from '../src/core/channels-config.ts'
import {createBindingStore} from '../src/core/bindings.ts'
import {createAudit} from '../src/core/audit.ts'
import {feishuSdkRecipe} from '../src/channels/feishu-sdk.ts'
import type {AdapterDeps,ImChannelAdapter} from '../src/core/types.ts'
import {fakeAdapter,fakeCredentials,silentLog,withTemp} from './im-fakes.ts'

const reqId='11111111-1111-4111-8111-111111111111'
const tgKey=credentialKey('im-gateway','telegram')

function setup(root:string,overrides:Partial<ChannelManagerDeps>&{adapters?:Partial<Record<ImChannelKind,ImChannelAdapter>>}={}){
 const dir=join(root,'im-gateway')
 const fakes=fakeCredentials()
 const created:{kind:ImChannelKind;deps:AdapterDeps}[]=[]
 const order:string[]=fakes.calls.order
 const installs:unknown[]=[]
 const deps:ChannelManagerDeps={
  credentials:fakes.credentials,
  config:createChannelConfigStore(dir),
  bindings:createBindingStore(dir,{perChannel:1}),
  createAdapter:(kind,adapterDeps)=>{created.push({kind,deps:adapterDeps});return overrides.adapters?.[kind]??fakeAdapter(kind).adapter},
  onInbound:async()=>{},
  audit:createAudit(dir),
  installPackage:async recipe=>{order.push('installPackage');installs.push(recipe);return join(root,'sdk')},
  lock:{held:true},
  log:silentLog,
  now:()=>'2026-09-26T00:00:00.000Z',
  ...overrides,
 }
 return {manager:createChannelManager(deps),deps,fakes,created,order,installs}
}

function deepValues(value:unknown):string[]{
 if(typeof value==='string')return [value]
 if(Array.isArray(value))return value.flatMap(deepValues)
 if(value&&typeof value==='object')return Object.entries(value).flatMap(([key,item])=>[key,...deepValues(item)])
 return []
}

test('1. save → modifyRecord 收到 api-key env；summary 不含凭据值；list 的 credentialsSaved 只来自 describeRecord、不调 readRecord',()=>withTemp(async root=>{
 const {manager,fakes}=setup(root)
 const summary=await manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'123456:TEST-SECRET-VALUE'}})
 assert.deepEqual(fakes.store.get(tgKey),{kind:'api-key',env:{TELEGRAM_BOT_TOKEN:'123456:TEST-SECRET-VALUE'}})
 assert.ok(!deepValues(summary).some(value=>value.includes('TEST-SECRET')))
 assert.equal(summary.enabled,false,'首次保存 enabled=false')
 const list=await manager.list()
 assert.equal(list.length,1)
 assert.equal(list[0]!.credentialsSaved,true)
 assert.equal(list[0]!.label,'Telegram')
 assert.equal(fakes.calls.read,0)
}))

test('2. describeRecord writable:false → save 抛 dependency-unavailable 且不写凭据',()=>withTemp(async root=>{
 const fakes=fakeCredentials({writable:false})
 const {manager}=setup(root,{credentials:fakes.credentials})
 await assert.rejects(manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'t'}}),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(fakes.calls.order,[])
}))

test('3. enable 未保存凭据 → conflict；保存后 enable → adapter.env() 每次调用各读一次 readRecord',()=>withTemp(async root=>{
 const tg=fakeAdapter('telegram')
 const {manager,deps,fakes,created}=setup(root,{adapters:{telegram:tg.adapter}})
 await assert.rejects(manager.enable('telegram'),{code:'teloa/not-found'})
 await deps.config.upsert({channelId:'telegram',kind:'telegram',enabled:false,createdAt:'2026-09-26T00:00:00.000Z'})
 await assert.rejects(manager.enable('telegram'),{code:'teloa/conflict'})
 await manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'tok'}})
 const summary=await manager.enable('telegram')
 assert.equal(summary.enabled,true)
 assert.equal(summary.status.connected,true)
 assert.equal(tg.calls.start,1)
 assert.equal(created.length,1)
 const before=fakes.calls.read
 assert.deepEqual(await created[0]!.deps.env(),{TELEGRAM_BOT_TOKEN:'tok'})
 await created[0]!.deps.env()
 assert.equal(fakes.calls.read-before,2,'凭据按次读取不缓存')
 assert.equal(manager.adapter('telegram'),tg.adapter)
}))

test('4. M7：feishu save 先 installPackage(feishuSdkRecipe) 再 modifyRecord；安装失败 → dependency-unavailable 且不写凭据；telegram 不安装',()=>withTemp(async root=>{
 const ok=setup(root)
 await ok.manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'s'}})
 assert.deepEqual(ok.installs,[feishuSdkRecipe])
 assert.deepEqual(ok.order,['installPackage','modifyRecord'])
 await ok.manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'t'}})
 assert.equal(ok.installs.length,1,'telegram 不调 installPackage')

 const failing=setup(join(root,'b'),{installPackage:async()=>{throw new Error('npm 失败')}})
 await assert.rejects(failing.manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'s'}}),{code:'teloa/dependency-unavailable'})
 assert.equal(failing.order.includes('modifyRecord'),false)
 assert.deepEqual(await failing.manager.list(),[])
}))

test('feishu enable：启动前再经 installPackage 取安装目录，适配器收到 loadSdk',()=>withTemp(async root=>{
 const {manager,installs,created}=setup(root)
 await manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'s'}})
 await manager.enable('feishu')
 assert.equal(installs.length,2)
 assert.equal(typeof (created[0]!.deps as AdapterDeps&{loadSdk?:unknown}).loadSdk,'function')
}))

test('7. startEnabled：一个渠道 start 抛错不影响另一个；出错渠道 status.error 非空且不含原始错误文本',()=>withTemp(async root=>{
 const tg=fakeAdapter('telegram',{failStart:true})
 const slack=fakeAdapter('slack')
 const {manager,deps}=setup(root,{adapters:{telegram:tg.adapter,slack:slack.adapter}})
 for(const kind of ['telegram','slack'] as const)await deps.config.upsert({channelId:kind,kind,enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await manager.startEnabled()
 const list=await manager.list()
 const byId=Object.fromEntries(list.map(row=>[row.channelId,row]))
 assert.equal(byId.slack!.status.connected,true)
 assert.equal(byId.telegram!.status.connected,false)
 assert.equal(byId.telegram!.status.error,'start-failed')
 assert.ok(!JSON.stringify(list).includes('xoxb-TEST-SECRET'))
}))

test('disable：停 adapter、enabled=false、通知 onChannelDisabled；stopAll 停全部',()=>withTemp(async root=>{
 const tg=fakeAdapter('telegram')
 const slack=fakeAdapter('slack')
 const {manager,deps}=setup(root,{adapters:{telegram:tg.adapter,slack:slack.adapter}})
 for(const kind of ['telegram','slack'] as const)await deps.config.upsert({channelId:kind,kind,enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await manager.startEnabled()
 const disabled:string[]=[]
 // 通知先于停渠道：监听器里渠道仍连接（审批撤卡要编辑卡片），停用等监听器完成。
 const off=manager.onChannelDisabled(async id=>{disabled.push(`${id}:${manager.adapter(id)?'connected':'gone'}:${tg.calls.stop}`);await new Promise(resolve=>setTimeout(resolve,5))})
 const summary=await manager.disable('telegram')
 assert.equal(summary.enabled,false)
 assert.equal(tg.calls.stop,1)
 assert.deepEqual(disabled,['telegram:connected:0'])
 assert.equal(manager.adapter('telegram'),undefined)
 off()
 await manager.stopAll()
 assert.equal(slack.calls.stop,1)
 await assert.rejects(manager.disable('feishu'),{code:'teloa/not-found'})
}))

test('锁未持有：list 所有渠道 status.error=another-host；enable → conflict；startEnabled 不启动',()=>withTemp(async root=>{
 const tg=fakeAdapter('telegram')
 const {manager,deps}=setup(root,{adapters:{telegram:tg.adapter},lock:{held:false}})
 await deps.config.upsert({channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await manager.startEnabled()
 assert.equal(tg.calls.start,0)
 const [row]=await manager.list()
 assert.deepEqual(row!.status,{connected:false,error:'another-host'})
 await assert.rejects(manager.enable('telegram'),{code:'teloa/conflict'})
}))

test('L4 list 透出适配器错误码（平台 409 → another-host）；适配器给出非错误码的原文 → unknown，不透出原文',()=>withTemp(async root=>{
 const raw=fakeAdapter('slack')
 raw.adapter.status=()=>({connected:false,error:'平台原文 token=abcd1234'})
 const other=setup(root,{adapters:{slack:raw.adapter}})
 await other.deps.config.upsert({channelId:'slack',kind:'slack',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await other.manager.startEnabled()
 assert.deepEqual((await other.manager.list())[0]!.status,{connected:false,error:'unknown'})
 await other.manager.stopAll()
 await other.deps.config.remove('slack')
 const tg=fakeAdapter('telegram')
 tg.adapter.status=()=>({connected:false,error:'another-host'})
 const {manager,deps}=setup(root,{adapters:{telegram:tg.adapter}})
 await deps.config.upsert({channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await manager.startEnabled()
 const [row]=await manager.list()
 assert.deepEqual(row!.status,{connected:false,error:'another-host'})
}))

test('M1：飞书启用等待 SDK 安装期间 disable → 安装完成后不建适配器、不收消息；随后再 enable 正常启动',()=>withTemp(async root=>{
 let release!:(dir:string)=>void
 let pending=0
 const {manager,created,deps}=setup(root,{installPackage:()=>{pending+=1;return pending===1?Promise.resolve(join(root,'sdk')):new Promise<string>(resolve=>{release=resolve})}})
 await manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'s'}})
 const enabling=manager.enable('feishu')
 for(let i=0;i<100&&!release;i+=1)await new Promise(resolve=>setTimeout(resolve,2))
 await manager.disable('feishu')
 release(join(root,'sdk'))
 await enabling
 assert.equal(created.length,0,'停用后不得再建适配器')
 assert.equal(manager.adapter('feishu'),undefined)
 assert.equal((await deps.config.list())[0]!.enabled,false)
 deps.installPackage=async()=>join(root,'sdk')
 await manager.enable('feishu')
 assert.equal(created.length,1)
 assert.ok(manager.adapter('feishu'))
}))

test('M1：适配器 start 途中 disable → start 返回后补停、不留连接；并发两次 enable 只建一个适配器',()=>withTemp(async root=>{
 let open!:()=>void
 const gate=new Promise<void>(resolve=>{open=resolve})
 const events:string[]=[]
 const tg=fakeAdapter('telegram')
 tg.adapter.start=async()=>{events.push('start');await gate;events.push('started')}
 tg.adapter.stop=async()=>{events.push('stop')}
 const {manager,created}=setup(root,{adapters:{telegram:tg.adapter}})
 await manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'123456:TEST-SECRET-VALUE'}})
 const first=manager.enable('telegram'),second=manager.enable('telegram')
 for(let i=0;i<100&&!events.includes('start');i+=1)await new Promise(resolve=>setTimeout(resolve,2))
 await manager.disable('telegram')
 open()
 await Promise.all([first,second])
 assert.equal(created.length,1)
 assert.equal(events.at(-1),'stop')
 assert.equal(manager.adapter('telegram'),undefined)
}))

test('stopAll 与进行中的 startEnabled 竞争：启动完成后仍被停下，不留连接（dispose 放锁前不得漏停）',()=>withTemp(async root=>{
 const events:string[]=[]
 let open!:()=>void
 const gate=new Promise<void>(resolve=>{open=resolve})
 const tg=fakeAdapter('telegram')
 tg.adapter.start=async()=>{events.push('start');await gate;events.push('started')}
 tg.adapter.stop=async()=>{events.push('stop')}
 const slow=fakeAdapter('slack')
 const {manager,deps}=setup(root,{adapters:{telegram:tg.adapter,slack:slow.adapter}})
 await deps.config.upsert({channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 const starting=manager.startEnabled()
 for(let i=0;i<100&&!events.includes('start');i+=1)await new Promise(resolve=>setTimeout(resolve,2))
 await manager.stopAll()
 open()
 await starting
 assert.equal(events.at(-1),'stop')
 assert.equal(manager.adapter('telegram'),undefined)
 // stopAll 之后再次 startEnabled（例如装载序列尾部才执行到）不再启动任何渠道。
 await deps.config.upsert({channelId:'slack',kind:'slack',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await manager.startEnabled()
 assert.equal(slow.calls.start,0)
}))

test('remove：停 adapter、删绑定与群绑定、deleteRecord、删配置',()=>withTemp(async root=>{
 const tg=fakeAdapter('telegram')
 const {manager,deps,fakes}=setup(root,{adapters:{telegram:tg.adapter}})
 await manager.save({requestId:reqId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'tok'}})
 await manager.enable('telegram')
 await deps.bindings.bind({channelId:'telegram',imUserId:'u1',ownerId:'local:teloa-owner',displayName:'Max'})
 await deps.bindings.groups.bind({channelId:'telegram',chatId:'-100',groupId:'22222222-2222-4222-8222-222222222222'})
 await manager.remove('telegram')
 assert.equal(tg.calls.stop,1)
 assert.deepEqual(await deps.bindings.list('telegram'),[])
 assert.deepEqual(await deps.bindings.groups.list('telegram'),[])
 assert.equal(fakes.store.has(tgKey),false)
 assert.deepEqual(await manager.list(),[])
}))

test('Lark：save 用同一份受管 SDK 配方（与飞书共用、不另装别的包），凭据按 channelId 单独存；列表名称为 Lark',()=>withTemp(async root=>{
 const {manager,installs,fakes,order}=setup(root)
 await manager.save({requestId:reqId,channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_a1b2c3d4e5f60718',LARK_APP_SECRET:'TEST-lark-secret'}})
 assert.deepEqual(installs,[feishuSdkRecipe])
 assert.deepEqual(order,['installPackage','modifyRecord'])
 assert.deepEqual(fakes.store.get(credentialKey('im-gateway','lark')),{kind:'api-key',env:{LARK_APP_ID:'cli_a1b2c3d4e5f60718',LARK_APP_SECRET:'TEST-lark-secret'}})
 assert.equal(fakes.store.has(credentialKey('im-gateway','feishu')),false)
 const [row]=await manager.list()
 assert.deepEqual([row!.channelId,row!.kind,row!.label,row!.credentialsSaved,row!.enabled],['lark','lark','Lark',true,false])
 assert.ok(!deepValues(row).some(value=>value.includes('TEST-lark')))
}))

test('飞书与 Lark 同时启用：各建各的适配器、各读各的凭据、SDK 配方相同；停用 Lark 不影响飞书，删除 Lark 只删 Lark 的凭据与绑定',()=>withTemp(async root=>{
 const feishu=fakeAdapter('feishu'),lark=fakeAdapter('lark')
 const {manager,installs,created,fakes,deps}=setup(root,{adapters:{feishu:feishu.adapter,lark:lark.adapter}})
 await manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'TEST-feishu'}})
 await manager.save({requestId:reqId,channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'TEST-lark'}})
 await manager.enable('feishu')
 await manager.enable('lark')
 assert.ok(installs.every(recipe=>recipe===feishuSdkRecipe))
 assert.deepEqual(created.map(row=>row.kind),['feishu','lark'])
 for(const row of created)assert.equal(typeof (row.deps as AdapterDeps&{loadSdk?:unknown}).loadSdk,'function')
 assert.deepEqual(await created[0]!.deps.env(),{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'TEST-feishu'})
 assert.deepEqual(await created[1]!.deps.env(),{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'TEST-lark'})
 assert.deepEqual((await manager.list()).map(row=>[row.channelId,row.enabled,row.status.connected]),[['feishu',true,true],['lark',true,true]])
 await deps.bindings.bind({channelId:'feishu',imUserId:'ou_a',ownerId:'local:teloa-owner',displayName:'A'})
 await deps.bindings.bind({channelId:'lark',imUserId:'ou_a',ownerId:'local:teloa-owner',displayName:'A'})
 await manager.disable('lark')
 assert.equal(lark.calls.stop,1)
 assert.equal(feishu.calls.stop,0)
 assert.ok(manager.adapter('feishu'))
 await manager.remove('lark')
 assert.equal(fakes.store.has(credentialKey('im-gateway','lark')),false)
 assert.equal(fakes.store.has(credentialKey('im-gateway','feishu')),true)
 assert.deepEqual((await deps.bindings.list('feishu')).map(row=>row.imUserId),['ou_a'])
 assert.deepEqual(await deps.bindings.list('lark'),[])
 assert.deepEqual((await manager.list()).map(row=>row.channelId),['feishu'])
}))

test('飞书与 Lark 不能用同一个 App ID：后保存的一方被拒（conflict + details.reason），不写凭据、不建渠道；换 App ID 即可保存',()=>withTemp(async root=>{
 const {manager,fakes}=setup(root)
 await manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'TEST-feishu'}})
 await assert.rejects(manager.save({requestId:reqId,channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_a1b2c3d4e5f60718',LARK_APP_SECRET:'TEST-lark'}}),
  (error:unknown)=>(error as {code?:string}).code==='teloa/conflict'&&(error as {details?:{reason?:string}}).details?.reason==='app-id-in-use'&&!String((error as Error).message).includes('TEST-'))
 assert.equal(fakes.store.has(credentialKey('im-gateway','lark')),false)
 assert.deepEqual((await manager.list()).map(row=>row.channelId),['feishu'])
 // 同一渠道重复保存同一 App ID 不算冲突。
 await manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'TEST-feishu-2'}})
 await manager.save({requestId:reqId,channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'TEST-lark'}})
 await assert.rejects(manager.save({requestId:reqId,channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_0123456789abcdef',FEISHU_APP_SECRET:'x'}}),{code:'teloa/conflict'})
}))
