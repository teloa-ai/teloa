import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createImAttachWindow,createTeloaWorkService,teloaWorkInvokeEndpoints} from '../src/teloa-work-service.ts'
import {createBroadcastNotificationAdapter,createLocalNotificationAdapter} from '../src/notification-deliveries.ts'

const requestId='16057272-ed9d-44a3-abe4-2ab04e056105'
const signal=new AbortController().signal

function fixture(options:{attachAllowed?:()=>boolean}={}){
 const calls={dispatch:[] as [string,unknown][],install:[] as unknown[],reserve:0,markResponseReady:0}
 const pendingRequests={reserve:async()=>{calls.reserve+=1},markResponseReady:async()=>{calls.markResponseReady+=1}}
 const service=createTeloaWorkService({
  owner:'local:teloa-owner',runtimeRoot:'/tmp/teloa-runtime',attachAllowed:options.attachAllowed??(()=>true),
  dispatch:async(endpoint,payload)=>{calls.dispatch.push([endpoint,payload]);return {ok:endpoint}},
  broadcast:createBroadcastNotificationAdapter(createLocalNotificationAdapter({info(){}}),{warn(){}}),
  install:async recipe=>{calls.install.push(recipe);return '/tmp/teloa-runtime/pkg'},
 })
 return {calls,pendingRequests,service}
}

test('owner 与 runtimeRoot 只读透出',()=>{
 const {service}=fixture()
 assert.equal(service.owner,'local:teloa-owner')
 assert.equal(service.runtimeRoot,'/tmp/teloa-runtime')
})

test('attachExtension 后 dispatchExtension 命中返回 handler 结果；未挂接返回 undefined',async()=>{
 const {service}=fixture()
 assert.equal(service.dispatchExtension('im/channels/list',{},signal),undefined)
 service.attachExtension(['im/channels/list','im/channels/save'],async(endpoint,payload)=>({endpoint,payload}))
 assert.deepEqual(await service.dispatchExtension('im/channels/list',{a:1},signal),{endpoint:'im/channels/list',payload:{a:1}})
 assert.deepEqual(await service.dispatchExtension('im/channels/save',{b:2},signal),{endpoint:'im/channels/save',payload:{b:2}})
 assert.equal(service.dispatchExtension('im/bindings/list',{},signal),undefined)
})

test('重复挂接同一 endpoint → throw，且不改动已有挂接',async()=>{
 const {service}=fixture()
 service.attachExtension(['im/channels/list'],async()=>'first')
 assert.throws(()=>service.attachExtension(['im/bindings/list','im/channels/list'],async()=>'second'),/im\/channels\/list/)
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'first')
 assert.equal(service.dispatchExtension('im/bindings/list',{},signal),undefined)
})

test('I2：attachExtension 只接受契约 imChannelEndpoints，挂核心端点被拒且不留残余挂接',async()=>{
 const {service}=fixture()
 assert.throws(()=>service.attachExtension(['conversations/list'],async()=>'hijack'),/conversations\/list/)
 assert.throws(()=>service.attachExtension(['im/channels/list','groups/messages/send'],async()=>'hijack'),/groups\/messages\/send/)
 assert.equal(service.dispatchExtension('conversations/list',{},signal),undefined)
 assert.equal(service.dispatchExtension('im/channels/list',{},signal),undefined)
 const dispose=service.attachExtension(['im/pairing/create','im/groups/unbind'],async()=>'ok')
 assert.equal(await service.dispatchExtension('im/groups/unbind',{},signal),'ok')
 dispose()
})

test('attachExtension 返回的 dispose 调用后再 dispatch 为 undefined',async()=>{
 const {service}=fixture()
 const dispose=service.attachExtension(['im/channels/list'],async()=>'value')
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'value')
 dispose()
 assert.equal(service.dispatchExtension('im/channels/list',{},signal),undefined)
})

test('L6（放宽）：同一时刻只有一个持有者——持有期间其它挂接一律 throw，不留挂接',async()=>{
 const {service}=fixture()
 const dispose=service.attachExtension(['im/channels/list'],async()=>'first')
 assert.throws(()=>service.attachExtension(['im/bindings/list'],async()=>'hijack'),/已有持有者/)
 assert.equal(service.dispatchExtension('im/bindings/list',{},signal),undefined)
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'first')
 dispose()
})
test('L6（放宽）：持有者释放后，挂接窗口开放时允许重新挂接（停用后再启用）；窗口关闭时仍拒绝',async()=>{
 let open=true
 const {service}=fixture({attachAllowed:()=>open})
 const first=service.attachExtension(['im/channels/list'],async()=>'first')
 first()
 const second=service.attachExtension(['im/channels/list'],async()=>'second')
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'second')
 // 旧持有者的 dispose 再调一次不影响新持有者
 first()
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'second')
 second()
 open=false
 assert.throws(()=>service.attachExtension(['im/channels/list'],async()=>'hijack'),/不在 IM 通道挂接窗口内/)
 assert.equal(service.dispatchExtension('im/channels/list',{},signal),undefined)
 assert.equal(service.extensionAttached(),false)
})

test('revokeExtension：宿主在 IM 启用热套用失败时撤掉窗口内抢先挂接的持有者，旧 dispose 不再生效',async()=>{
 const {service}=fixture()
 const rogue=service.attachExtension(['im/channels/list'],async()=>'rogue')
 service.revokeExtension()
 assert.equal(service.dispatchExtension('im/channels/list',{},signal),undefined)
 assert.equal(service.extensionAttached(),false)
 const next=service.attachExtension(['im/channels/list'],async()=>'im')
 rogue()
 assert.equal(await service.dispatchExtension('im/channels/list',{},signal),'im')
 next()
})
test('H3：invoke 只调 dispatch 一次，不登记 pending request（reserve / markResponseReady 计数为 0）',async()=>{
 const {calls,pendingRequests,service}=fixture()
 const payload={requestId,groupId:'0f9e8d7c-6b5a-4433-9211-0fedcba98765',expectedVersion:1,text:'hi'}
 assert.deepEqual(await service.invoke('groups/messages/send',payload,signal),{ok:'groups/messages/send'})
 assert.deepEqual(calls.dispatch,[['groups/messages/send',payload]])
 assert.equal(calls.reserve,0)
 assert.equal(calls.markResponseReady,0)
 void pendingRequests
})

test('invoke 白名单：只放 IM 一期所需端点并原样透传；其余（含写能力更强的端点与 im/*）→ teloa/forbidden 且不调 dispatch',async()=>{
 const {calls,service}=fixture()
 assert.deepEqual([...teloaWorkInvokeEndpoints].sort(),['conversations/create','conversations/read','groups/get','groups/list','groups/messages/send','object-conversations/change','roles/list','security-actions/attention','task-runs/list','tasks/attention','tasks/list'])
 for(const endpoint of teloaWorkInvokeEndpoints)assert.deepEqual(await service.invoke(endpoint,{},signal),{ok:endpoint})
 assert.equal(calls.dispatch.length,teloaWorkInvokeEndpoints.length)
 for(const endpoint of ['security-actions/decide','roles/create','tasks/create','conversations/adopt','groups/change','plans/trigger','requests/pending/ack','im/channels/list','web-access/change','retrieval/cancel','retrieval/reindex','retrieval/enroll','retrieval/remove','retrieval-model/prepare','retrieval-model/cancel',''])
  await assert.rejects(service.invoke(endpoint,{},signal),{code:'teloa/forbidden'},endpoint)
 assert.equal(calls.dispatch.length,teloaWorkInvokeEndpoints.length)
})

test('H3 源码断言：index.ts 的 createTeloaWorkService 用 dispatchTeloaEndpoint 而非 invokeTeloaEndpoint',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const call=source.match(/^.*createTeloaWorkService\(\{.*$/m)
 assert.ok(call,'index.ts 应调用 createTeloaWorkService')
 assert.match(call[0],/dispatch:\s*dispatchTeloaEndpoint\b/)
 assert.doesNotMatch(call[0],/invokeTeloaEndpoint/)
 assert.match(source,/ctx\.provide\('teloaWork',/)
 assert.match(source,/teloaWork\.dispatchExtension\(endpoint,payload,signal\)/)
 assert.match(source,/\.\.\.imChannelEndpoints/)
})

test('notifications.addAdapter 透传到广播适配器；packages.install 透传白名单配方并返回安装目录',async()=>{
 const {calls,service}=fixture()
 const dispose=service.notifications.addAdapter({channel:'im-telegram',deliver:async()=>({receiptId:'x'})})
 assert.equal(typeof dispose,'function')
 dispose()
 const recipe={package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA=='}
 assert.equal(await service.packages.install(recipe),'/tmp/teloa-runtime/pkg')
 assert.deepEqual(calls.install,[recipe])
})

test('packages.install：白名单外的包名、版本或 integrity → teloa/forbidden，不调用安装',async()=>{
 const {calls,service}=fixture()
 for(const recipe of [
  {package:'left-pad',version:'1.3.0',integrity:'sha512-abc'},
  {package:'@larksuiteoapi/node-sdk',version:'1.0.0',integrity:'sha512-abc'},
 ])await assert.rejects(service.packages.install(recipe),{code:'teloa/forbidden'})
 assert.deepEqual(calls.install,[])
})

test('挂接窗口未开放（装配期 bundles 不含 IM、也不在启用热套用期间）时拒绝任何挂接',()=>{
 const {service}=fixture({attachAllowed:()=>false})
 assert.throws(()=>service.attachExtension(['im/channels/list'],async()=>({})),/不在 IM 通道挂接窗口内/)
 assert.equal(service.extensionAttached(),false)
 assert.equal(service.dispatchExtension('im/channels/list',{},new AbortController().signal),undefined)
})
test('extensionAttached 只读反映是否有挂接端点，不改变持有者判定',()=>{
 const {service}=fixture()
 assert.equal(service.extensionAttached(),false)
 const dispose=service.attachExtension(['im/channels/list'],async()=>({}))
 assert.equal(service.extensionAttached(),true)
 assert.throws(()=>service.attachExtension(['im/channels/list'],async()=>({})),/已有持有者/)
 dispose()
 assert.equal(service.extensionAttached(),false)
})

test('启动时已启用 IM：装配期窗口不随宿主就绪关闭（teloaWork 可能在就绪之后才提供），首次挂接成功后关闭；停用后只有启用热套用窗口能再挂接',async()=>{
 let rowPresent=true
 const window=createImAttachWindow({startup:true,rowPresent:()=>rowPresent})
 const service=createTeloaWorkService({owner:'o',runtimeRoot:'/tmp/x',dispatch:async()=>undefined,broadcast:{add:()=>()=>{}} as never,install:async()=>'',attachAllowed:window.allowed})
 // 宿主就绪之后 IM 才拿到 teloaWork：仍可挂接
 const first=service.attachExtension(['im/channels/list'],async()=>'im')
 first()
 // 装配期窗口已随首次挂接关闭：窗口外再挂接被拒
 assert.throws(()=>service.attachExtension(['im/channels/list'],async()=>'rogue'),/不在 IM 通道挂接窗口内/)
 // 启用热套用窗口内可再挂接；窗口结束后关闭
 await window.during(async()=>{service.attachExtension(['im/channels/list'],async()=>'again')})
 assert.equal(window.allowed(),false)
 // 生效组合没有 IM 行时，窗口内也拒绝
 rowPresent=false
 await window.during(async()=>{assert.equal(window.allowed(),false)})
})
test('装配期 bundles 不含 IM：装配期窗口从未开放；本人第一次启停即关闭装配期窗口',()=>{
 assert.equal(createImAttachWindow({startup:false,rowPresent:()=>true}).allowed(),false)
 const window=createImAttachWindow({startup:true,rowPresent:()=>true})
 window.closeStartup()
 assert.equal(window.allowed(),false)
})
