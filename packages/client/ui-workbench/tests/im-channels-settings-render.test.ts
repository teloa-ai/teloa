import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {ImChannelsSettingsView,ImChannelKindNotes,imSaveFailureKey}=await import('../lib/types/client/ImChannelsSettingsPage.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const source=(name:string)=>readFileSync(new URL(`../src/client/${name}`,import.meta.url),'utf8')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN',dshLocale:'zh',revision:1})}
const summary=(channelId:'feishu'|'lark'|'telegram'|'slack'|'stub',extra:Record<string,unknown>={})=>({channelId,kind:channelId,label:channelId,enabled:true,credentialsSaved:true,status:{connected:true},bindings:0,groups:0,...extra})
const now=Date.parse('2026-09-26T00:00:00.000Z')
const noop=()=>{},later=async()=>true
const view=(extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(ImChannelsSettingsView as never,{
 channels:[],bindings:[],groupBindings:[],roles:[],groups:[],pairing:undefined,pairingExpired:false,copied:false,now,busy:false,savingKind:undefined,error:undefined,recovery:false,discarded:false,
 onSave:later,onToggle:noop,onRemove:noop,onPair:noop,onCopy:noop,onChangeTarget:noop,onUnbind:noop,onBindGroup:later,onUnbindGroup:noop,onRetry:noop,onDiscard:noop,...extra,
})))

test('三种渠道状态分别显示已连接、连接出错（按错误码本地化原因）与未启用',()=>{
 const html=view({channels:[
  summary('telegram'),
  summary('slack',{status:{connected:false,error:'another-host'}}),
  summary('feishu',{enabled:false,status:{connected:false}}),
 ]})
 assert.match(html,/已连接/)
 assert.match(html,/连接出错/)
 assert.match(html,/另一台 Teloa 已连接该渠道/)
 assert.doesNotMatch(html,/another-host/)
 assert.match(html,/未启用/)
 assert.doesNotMatch(html,/imChannels\./,'词条都已翻译')
})

test('L4 每个错误码都有本地化原因；非错误码的原文不显示，退回「未知问题」',()=>{
 const codes=['another-host','credentials-invalid','credentials-missing','reconnecting','sdk-missing','sdk-install-failed','start-failed','unknown']
 const html=view({channels:codes.map(error=>summary('slack',{status:{connected:false,error}}))})
 for(const code of codes)assert.doesNotMatch(html,new RegExp(`>${code}<`))
 assert.doesNotMatch(html,/imChannels\./)
 assert.match(html,/密钥无效或已被撤销/)
 const raw=view({channels:[summary('slack',{status:{connected:false,error:'平台原文 token=abcd1234'}})]})
 assert.doesNotMatch(raw,/平台原文/)
 assert.match(raw,/连接出现未知问题/)
})

test('凭据：已保存只显示「凭据已保存」，密码框不受控、不带 value 属性',()=>{
 const html=view({channels:[summary('telegram')]})
 assert.match(html,/密钥已保存/)
 const inputs=[...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map(match=>match[0])
 assert.ok(inputs.length>=1)
 for(const input of inputs){assert.doesNotMatch(input,/\svalue=/);assert.match(input,/autoComplete="off"|autocomplete="off"/i)}
 assert.doesNotMatch(source('ImChannelsSettingsPage.tsx'),/type="password"[^>]*value=/,'源码中密码框不绑定 value')
 assert.doesNotMatch(source('ImChannelsSettingsPage.tsx'),/dangerouslySetInnerHTML/)
})

test('配对码区显示 6 位码、倒计时与发送提示；过期后隐藏码',()=>{
 const pairing={channelId:'telegram',code:'123456',expiresAt:new Date(now+600_000).toISOString()}
 const html=view({channels:[summary('telegram')],pairing})
 assert.match(html,/123456/)
 assert.match(html,/10:00 后失效/)
 assert.match(html,/\/pair 123456/)
 const expired=view({channels:[summary('telegram')],pairing,now:now+600_000})
 assert.doesNotMatch(expired,/123456/)
 assert.match(expired,/配对码已过期/)
 const cleared=view({channels:[summary('telegram')],pairing:undefined,pairingExpired:true})
 assert.match(cleared,/配对码已过期/)
 // L3：倒计时到 0 时页面把配对码从状态里清掉（setPairing(undefined)），不只是视图隐藏。
 assert.match(source('ImChannelsSettingsPage.tsx'),/current>=Date\.parse\(pairing\.expiresAt\)\)\{[^}]*setPairing\(undefined\)/)
 const copied=view({channels:[summary('telegram')],copied:true})
 assert.doesNotMatch(copied,/123456/)
 assert.match(copied,/配对码不再显示/)
})

test('默认对话对象：主助手与同事可选；群绑定与已知限制两条',()=>{
 const roleId='7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
 const html=view({
  channels:[summary('telegram')],
  bindings:[{channelId:'telegram',imUserId:'u1',displayName:'小王',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'role',roleId}}],
  roles:[{id:roleId,name:'资料员'}],
  groups:[{id:'g1',name:'周报群'}],
  groupBindings:[{channelId:'telegram',chatId:'-100',groupId:'g1',boundAt:'2026-09-26T00:00:00.000Z'}],
 })
 assert.match(html,/主助手/)
 assert.match(html,new RegExp(`<option value="role:${roleId}" selected="">资料员</option>`))
 assert.match(html,/周报群/)
 assert.match(html,/<details/)
 assert.match(html,/工作台上的同一张卡片/)
 assert.match(html,/重启前发到 IM 的审批卡片会过期/)
})

test('DOM 的 className 全部来自 module css；样式颜色只用 --teloa-* 令牌',()=>{
 const html=view({
  channels:[summary('telegram'),summary('slack',{status:{connected:false,error:'x'}}),summary('feishu',{enabled:false})],
  bindings:[{channelId:'telegram',imUserId:'u1',displayName:'小王',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'}}],
  pairing:{channelId:'telegram',code:'123456',expiresAt:new Date(now+60_000).toISOString()},
  error:'出错',recovery:true,discarded:true,
 })
 assert.match(html,/丢弃这条恢复记录/);assert.match(html,/已丢弃本地恢复记录/)
 const styles=source('ImChannelsSettingsPage.module.css')
 const defined=new Set([...styles.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map(match=>match[1]!).concat('tokens'))
 const used=new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap(match=>match[1]!.split(/\s+/).filter(Boolean)))
 for(const name of used)assert.ok(defined.has(name),`className ${name} 未在 module css 中定义`)
 assert.doesNotMatch(styles,/#[0-9a-fA-F]{3,8}\b/,'不写十六进制颜色')
 assert.doesNotMatch(styles,/\b(?:rgb|rgba|hsl|hsla)\(/,'不写字面颜色函数')
 for(const match of styles.matchAll(/var\((--[a-z0-9-]+)/g))assert.match(match[1]!,/^--teloa-/)
})

test('验收用模拟通道：渠道类型下拉只列正式四种；宿主预置了 stub 渠道行（仅验收环境）时才多出「验收用模拟通道」',()=>{
 // 只看「添加渠道」表单里的渠道类型下拉（页面上第一个 select）。
 const options=(html:string)=>[...(/<select[^>]*>(.*?)<\/select>/.exec(html)?.[1]??'').matchAll(/<option value="([a-z]+)"/g)].map(match=>match[1])
 assert.deepEqual(options(view({channels:[summary('telegram')]})),['feishu','lark','telegram','slack'])
 const html=view({channels:[summary('stub',{enabled:false,credentialsSaved:false,status:{connected:false}})]})
 assert.deepEqual(options(html),['feishu','lark','telegram','slack','stub'])
 assert.match(html,/验收用模拟通道/)
 assert.doesNotMatch(html,/imChannels\./)
})

const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

test('Lark（飞书国际版）：下拉显示中文名；已添加的飞书与 Lark 两行并列，配对与群绑定下拉都能选到 Lark',()=>{
 const html=view({channels:[summary('feishu'),summary('lark',{status:{connected:false,error:'credentials-invalid'}})]})
 assert.match(html,/<option value="lark">Lark（飞书国际版）<\/option>/)
 assert.match(html,/<strong>飞书<\/strong>/)
 assert.match(html,/<strong>Lark（飞书国际版）<\/strong>/)
 assert.match(html,/密钥无效或已被撤销/)
 const selects=[...html.matchAll(/<select[^>]*>(.*?)<\/select>/g)].map(match=>match[1]!)
 assert.ok(selects.filter(options=>options.includes('value="lark"')).length>=3,'添加表单、配对、群绑定三处都有 Lark')
 assert.doesNotMatch(html,/imChannels\./)
})

test('Lark 说明：给出 Lark 开发者后台固定地址（open.larksuite.com，新窗口打开）与共用开发包说明；飞书不显示 Lark 地址',()=>{
 const lark=render(createElement(ImChannelKindNotes as never,{kind:'lark'}))
 assert.match(lark,/<a href="https:\/\/open\.larksuite\.com\/app" target="_blank" rel="noreferrer">open\.larksuite\.com\/app<\/a>/)
 assert.match(lark,/Lark 开发者后台/)
 assert.match(lark,/与飞书共用/)
 assert.doesNotMatch(lark,/open\.feishu\.cn|imChannels\./)
 const feishu=render(createElement(ImChannelKindNotes as never,{kind:'feishu'}))
 assert.match(feishu,/首次保存飞书渠道需要下载飞书开发包/)
 assert.doesNotMatch(feishu,/larksuite/)
 assert.equal(render(createElement(ImChannelKindNotes as never,{kind:'telegram'})),'')
 // 安装失败的白话提示按种类分开：Lark 渠道不提示「飞书开发包」。
 const page=source('ImChannelsSettingsPage.tsx')
 assert.match(page,/lark:'imChannels\.larkInstallFailed'/)
 assert.match(page,/<ImChannelKindNotes kind=\{kind\}\/>/)
})

test('保存失败的白话提示：App ID 已被另一渠道使用 → 专门提示；飞书、Lark 开发包下载失败各自提示；其余交给通用错误',()=>{
 assert.equal(imSaveFailureKey('lark',{code:'teloa/conflict',details:{reason:'app-id-in-use'}}),'imChannels.appIdInUse')
 assert.equal(imSaveFailureKey('feishu',{code:'teloa/conflict',details:{reason:'app-id-in-use'}}),'imChannels.appIdInUse')
 assert.equal(imSaveFailureKey('lark',{code:'teloa/dependency-unavailable'}),'imChannels.larkInstallFailed')
 assert.equal(imSaveFailureKey('feishu',{code:'teloa/dependency-unavailable'}),'imChannels.feishuInstallFailed')
 assert.equal(imSaveFailureKey('telegram',{code:'teloa/dependency-unavailable'}),undefined)
 assert.equal(imSaveFailureKey('lark',{code:'teloa/conflict'}),undefined)
 assert.equal(imSaveFailureKey('lark',undefined),undefined)
 assert.match(translateMessage('zh-CN','imChannels.appIdInUse' as never),/App ID 已经用在另一个渠道上/)
 // IM 通道接口把宿主回包的 details 带给页面，才能认出 app-id-in-use。
 assert.match(source('index.ts'),/createImChannelsApi\(async\(endpoint,payload\)=>\{[^\n]*details:result\.error\.details/)
})

test('App ID 格式暂时无法建立长连接：状态写明白话原因（核对是否复制完整、确认无误请反馈），不显示错误码',()=>{
 const html=view({channels:[summary('lark',{status:{connected:false,error:'app-id-unsupported'}})]})
 assert.match(html,/这个 App ID 的格式暂时无法建立长连接，请核对是否复制完整；如确认无误请通过问题反馈告诉我们/)
 assert.doesNotMatch(html,/app-id-unsupported|imChannels\./)
})
