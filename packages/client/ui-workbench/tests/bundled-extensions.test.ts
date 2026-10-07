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
test('市场可选扩展区不再提供内置 IM 的安装或启停入口',()=>{
 const noop=()=>{}
 for(const state of ['available','active']){
  const html=render(BundledExtensionsView,{rows:[view(state)],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
  assert.doesNotMatch(html,/IM 通道|>启用<|>停用</)
 }
})

test('市场区：每个随附扩展按 id 显示自己的名称、简介与确认文案（本地中文检索不借用 IM 文案）',()=>{
 const noop=()=>{}
 const embedding={id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0}
 const both=render(BundledExtensionsView,{rows:[view('available'),embedding],busy:false,error:undefined,confirming:undefined,onAsk:noop,onConfirm:noop,onCancel:noop,onRetry:noop})
 assert.doesNotMatch(both,/IM 通道/)
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
test('内置 IM 未就绪只提供重试，不再要求安装或确认启用插件',()=>{
 for(const state of ['available','failed','enable-pending','disable-pending','unreadable']){
  const html=render(ImChannelsExtensionNotice,{state,onRetry:()=>{}})
  assert.match(html,/消息通道暂未就绪/);assert.match(html,/>重试</)
  assert.doesNotMatch(html,/市场|启用 IM|>确认</)
 }
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
 const failed=render(ImChannelsExtensionNotice,{state:'failed',onRetry:()=>{}})
 assert.match(failed,/消息通道暂未就绪/);assert.match(failed,/>重试</)
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
test('词表：新增文案仅中简、中繁和英文，其余既有语言保留',()=>{
 assert.equal(BUNDLED_EXTENSIONS_MESSAGE_ROWS.length,35)
 const keys=new Set<string>()
 for(const row of BUNDLED_EXTENSIONS_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0]);assert.match(row[0],/^bundledExtensions\./);assert.ok(!keys.has(row[0]),row[0]);keys.add(row[0])
  if(row[0]==='bundledExtensions.im.builtinUnavailable')for(const fallback of row.slice(4))assert.equal(fallback,row[3])
  assert.doesNotMatch(row[1],/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/,row[0]);assert.doesNotMatch(row[3],/workspace|instance|human/i,row[0])
 }
})
