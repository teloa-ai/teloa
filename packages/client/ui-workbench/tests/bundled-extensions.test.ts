import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {createBundledExtensionsApi}=await import('../lib/types/client/bundled-extensions-api.js')
const {BundledExtensionsView,bundledSetErrorKey}=await import('../lib/types/client/BundledExtensionsSection.js')
const {ImChannelsExtensionNotice,guardImUnavailable,readExtensionStateSettled}=await import('../lib/types/client/ImChannelsSettingsPage.js')
const {BUNDLED_EXTENSIONS_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/bundled-extensions.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN',dshLocale:'zh',revision:1})}
const render=(type:unknown,props:Record<string,unknown>)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(type as never,props)))
const view=(state:string,configuredChannels=0)=>({id:'im-gateway',packageName:'@teloa/im-gateway',version:'0.2.0-alpha.6',state,configuredChannels})

test('API 按精确载荷调用并核对回包',async()=>{
 const calls:unknown[]=[]
 const api=createBundledExtensionsApi(async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);return endpoint==='bundled-extensions/list'?[view('available')]:view('enable-pending')})
 assert.equal((await api.list())[0]?.state,'available')
 assert.equal((await api.set('im-gateway',true)).state,'enable-pending')
 assert.deepEqual(calls,[['bundled-extensions/list',{}],['bundled-extensions/set',{extensionId:'im-gateway',enabled:true}]])
 await assert.rejects(createBundledExtensionsApi(async()=>[{...view('active'),packageName:'@evil/x'}]).list())
})
test('市场区：未启用显示启用；停用确认写明保留数量与清除方法',()=>{
 const noop=()=>{}
 const available=render(BundledExtensionsView,{rows:[view('available')],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.match(available,/官方扩展/);assert.match(available,/IM 通道/);assert.match(available,/未启用/);assert.match(available,/>启用</)
 const disabling=render(BundledExtensionsView,{rows:[view('active',2)],busy:false,error:undefined,confirming:{id:'im-gateway',enabled:false},onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.match(disabling,/已保存的 2 个渠道/);assert.match(disabling,/移除渠道/)
})
test('市场区：每个随附扩展按 id 显示自己的名称、简介与确认文案（本地中文检索不借用 IM 文案）',()=>{
 const noop=()=>{}
 const embedding={id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0}
 const both=render(BundledExtensionsView,{rows:[view('available'),embedding],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.equal(both.match(/IM 通道/g)?.length,1)
 assert.match(both,/本地中文检索/);assert.match(both,/在本机建立资料索引/);assert.match(both,/检索摘录用于当前会话，可能发给远程聊天模型/);assert.match(both,/检索模型需在 市场 · 模型 中另行确认准备/)
 assert.doesNotMatch(both,/资料不出本机/)
 const enabling=render(BundledExtensionsView,{rows:[{...embedding}],busy:false,error:undefined,confirming:{id:'local-embedding',enabled:true},onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.match(enabling,/不会下载/);assert.doesNotMatch(enabling,/IM 通道|渠道/)
 const disabling=render(BundledExtensionsView,{rows:[{...embedding,state:'active'}],busy:false,error:undefined,confirming:{id:'local-embedding',enabled:false},onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.match(disabling,/保留在本机/);assert.doesNotMatch(disabling,/渠道/)
 // 物理内存 ≤ 8 GB 且默认 fp32：行内明确提示内存风险；宿主判定无风险时不提示
 assert.match(render(BundledExtensionsView,{rows:[{...embedding,memoryRisk:true}],busy:false,error:undefined,confirming:{id:'local-embedding',enabled:true},onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop}),/物理内存不超过 8 GB[^<]*3–4 GB[^<]*未实机验证/)
 assert.doesNotMatch(render(BundledExtensionsView,{rows:[{...embedding,memoryRisk:false}],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop}),/物理内存/)
})
test('设置页引导卡：未启用可在此直接启用（先确认），也给市场入口；待重启（回退）只提示',()=>{
 const noop=()=>{}
 const available=render(ImChannelsExtensionNotice,{state:'available',openMarket:noop,enable:{confirming:false,busy:false,error:undefined,onAsk:noop,onConfirm:noop,onCancel:noop}})
 assert.match(available,/>启用 IM 通道</);assert.match(available,/前往市场「扩展」启用/)
 const confirming=render(ImChannelsExtensionNotice,{state:'available',openMarket:noop,enable:{confirming:true,busy:false,error:undefined,onAsk:noop,onConfirm:noop,onCancel:noop}})
 assert.match(confirming,/启用后立即加载 IM 通道/);assert.doesNotMatch(confirming,/重启/);assert.match(confirming,/>确认</);assert.match(confirming,/>取消</)
 const failed=render(ImChannelsExtensionNotice,{state:'available',openMarket:noop,enable:{confirming:false,busy:false,error:'启用后的运行配置没有通过安全检查',onAsk:noop,onConfirm:noop,onCancel:noop}})
 assert.match(failed,/role="alert"[^>]*>启用后的运行配置没有通过安全检查/)
 // 没有启用入口（旧调用方）时仍只给市场入口
 assert.doesNotMatch(render(ImChannelsExtensionNotice,{state:'available',openMarket:noop}),/>启用 IM 通道</)
 const pending=render(ImChannelsExtensionNotice,{state:'enable-pending',openMarket:()=>{}})
 assert.match(pending,/重启 Teloa 后/);assert.doesNotMatch(pending,/前往市场/)
 const unreadable=render(ImChannelsExtensionNotice,{state:'unreadable',openMarket:()=>{},onRetry:()=>{}})
 assert.match(unreadable,/读不到/);assert.match(unreadable,/>重试</)
})
test('设置页刚启动：读到 failed 先隔一会儿重读，挂上即 active；重读完仍 failed 才如实显示，并给重试',async()=>{
 const sequence=(states:string[])=>{const rest=[...states];return async()=>view(rest.length>1?rest.shift()!:rest[0]!) as never}
 let waits=0
 const wait=async()=>{waits+=1}
 assert.equal(await readExtensionStateSettled(sequence(['failed','failed','active']),wait),'active')
 assert.equal(waits,2)
 waits=0
 assert.equal(await readExtensionStateSettled(sequence(['failed']),wait,3),'failed')
 assert.equal(waits,3)
 waits=0
 assert.equal(await readExtensionStateSettled(sequence(['available']),wait),'available')
 assert.equal(await readExtensionStateSettled(async()=>undefined,wait),'unreadable')
 assert.equal(waits,0,'只有 failed 才重读')
 const failed=render(ImChannelsExtensionNotice,{state:'failed',openMarket:()=>{},onRetry:()=>{}})
 assert.match(failed,/没有加载成功/);assert.match(failed,/>重试</)
})
test('im/* 回 dependency-unavailable 时触发重读，其它错误不触发；错误照常抛出',async()=>{
 let rereads=0
 const fail=(code:string)=>async()=>{throw Object.assign(Error(code),{code})}
 const api=guardImUnavailable({channels:fail('teloa/dependency-unavailable'),bindings:fail('teloa/forbidden')},()=>{rereads+=1})
 await assert.rejects(api.channels(),{code:'teloa/dependency-unavailable'})
 await assert.rejects(api.bindings(),{code:'teloa/forbidden'})
 assert.equal(rereads,1)
 assert.equal(guardImUnavailable({pending:()=>undefined},()=>{}).pending(),undefined)
})
test('市场区与确认文案：即时生效，不再提示重启',()=>{
 const noop=()=>{}
 const embedding={id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0}
 for(const confirming of [{id:'im-gateway',enabled:true},{id:'im-gateway',enabled:false},{id:'local-embedding',enabled:true},{id:'local-embedding',enabled:false}]){
  const html=render(BundledExtensionsView,{rows:[view('active',1),embedding],busy:false,error:undefined,confirming,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
  assert.doesNotMatch(html,/重启/,JSON.stringify(confirming))
 }
 assert.match(render(BundledExtensionsView,{rows:[view('available')],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop}),/启用或停用即时生效/)
})
test('启停失败按错误码与原因给固定文案',()=>{
 assert.equal(bundledSetErrorKey({code:'teloa/forbidden'}),'bundledExtensions.error.unregistered')
 assert.equal(bundledSetErrorKey({code:'teloa/forbidden',details:{reason:'safety-check'}}),'bundledExtensions.error.safetyCheck')
 assert.equal(bundledSetErrorKey({code:'teloa/dependency-unavailable',details:{reason:'load-failed'}}),'bundledExtensions.error.loadFailed')
 assert.equal(bundledSetErrorKey({code:'teloa/storage-unavailable'}),'bundledExtensions.error.storage')
 assert.equal(bundledSetErrorKey(Error('x')),'bundledExtensions.error.generic')
})
test('词表：34 行、11 列、键唯一、无禁词',()=>{
 assert.equal(BUNDLED_EXTENSIONS_MESSAGE_ROWS.length,34)
 const keys=new Set<string>()
 for(const row of BUNDLED_EXTENSIONS_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0]);assert.match(row[0],/^bundledExtensions\./);assert.ok(!keys.has(row[0]),row[0]);keys.add(row[0])
  assert.doesNotMatch(row[1],/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/,row[0]);assert.doesNotMatch(row[3],/workspace|instance|human/i,row[0])
 }
})
