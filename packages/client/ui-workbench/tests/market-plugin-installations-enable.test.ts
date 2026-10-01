import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {MarketPluginInstallPreview} from '@teloa/contract'
import {MARKET_INSTALLATION_MESSAGE_ROWS} from '../src/client/i18n/locales/market-installations.ts'

// 和 evidence-list.test.ts / attention-decision-card.test.ts 同样的取巧：.tsx 走 tsc 产物，
// CSS Modules 换成类名代理，断言只看结构不看样式。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {EnableConfirm,statusKey,trustKey,trustNoticeKey,MarketPluginInstallControl}=await import('../lib/types/client/MarketPluginInstallations.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

const source={registry:'npm' as const,packageName:'@example/visualize',version:'1.2.3'}
const preview:MarketPluginInstallPreview={schema:'teloa.market-plugin-install-preview/v1',source,trust:{status:'unverified',publisher:'Example Publisher',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},bundleHash:'a'.repeat(64),permissionSummary:{permissions:[{id:'dsh.bundle.insert:example-extra',description:'该扩展会新增 DSH 组合配置行 example-extra。',required:true},{id:'dsh.client:web',description:'将加载 DSH web 客户端代码。',required:false}]}}

test('旧记录里存的权限说明（「该插件…」）按权限 id 显示当前文案；识别不了的 id 显示原文',()=>{
 const legacy:MarketPluginInstallPreview={...preview,permissionSummary:{permissions:[{id:'dsh.bundle.insert:example-extra',description:'该插件会新增 DSH 组合配置行 example-extra。',required:true},{id:'workspace.read',description:'读取当前工作区',required:false}]}}
 const html=render(createElement(EnableConfirm,{preview:legacy,ack:false,busy:false,setAck:()=>{},enable:()=>{}}))
 assert.match(html,/该扩展会新增 DSH 组合配置行 example-extra。/)
 assert.doesNotMatch(html,/该插件/)
 assert.match(html,/读取当前工作区/)
})

test('状态词典明确区分"已安装 · 待启用"与启用后"需重启"，且不影响其余状态映射',()=>{
 assert.equal(statusKey('pending-enable'),'market.plugin.install.state.pendingEnable')
 assert.equal(statusKey('restart-required'),'market.plugin.install.state.enabledRestart')
 assert.equal(statusKey('active'),'market.plugin.install.state.active')
 assert.equal(statusKey('preparing'),'market.plugin.install.state.preparing')
 assert.equal(statusKey('failed'),'market.plugin.install.state.failed')
 assert.equal(statusKey('unknown'),'market.plugin.install.state.unknown')
})

test('启用确认区不是弹框：逐条列出权限摘要（id、描述与必需/可选）、发布者、来源版本与信任结论，勾选前提交按钮禁用',()=>{
 const html=render(createElement(EnableConfirm,{preview,ack:false,busy:false,setAck:()=>{},enable:()=>{}}))
 assert.doesNotMatch(html,/role="dialog"/)
 assert.match(html,/@example\/visualize/)
 assert.match(html,/1\.2\.3/)
 assert.match(html,/Example Publisher/)
 // 权限条目不能丢 id 与必需/可选：必需的用徽标呈现，不是裸小字。
 assert.match(html,/dsh\.bundle\.insert:example-extra/)
 assert.match(html,/该扩展会新增 DSH 组合配置行 example-extra/)
 assert.match(html,/<span[^>]*>必需<\/span>/)
 assert.match(html,/dsh\.client:web/)
 assert.match(html,/将加载 DSH web 客户端代码/)
 assert.match(html,/可选/)
 assert.doesNotMatch(html,/<span[^>]*>可选<\/span>/,'可选不需要徽标，保持纯文本')
 assert.match(html,/未核验/)
 assert.match(html,/<input[^>]*type="checkbox"[^>]*\/>/)
 assert.doesNotMatch(html,/checked=""|checked="checked"/)
 assert.match(html,/<button[^>]*disabled=""[^>]*>启用<\/button>/)
})

test('勾选核对后按钮才可点；仍在提交中（并发防重）时即便已勾选也禁用',()=>{
 const checked=render(createElement(EnableConfirm,{preview,ack:true,busy:false,setAck:()=>{},enable:()=>{}}))
 assert.doesNotMatch(checked,/<button[^>]*disabled=""[^>]*>启用<\/button>/)
 assert.match(checked,/checked=""/)
 const busy=render(createElement(EnableConfirm,{preview,ack:true,busy:true,setAck:()=>{},enable:()=>{}}))
 assert.match(busy,/<button[^>]*disabled=""[^>]*>启用<\/button>/)
})

test('已核验来源给出核验结论，而不是笼统的"未核验"文案',()=>{
 const html=render(createElement(EnableConfirm,{preview:{...preview,trust:{...preview.trust,status:'verified'}},ack:false,busy:false,setAck:()=>{},enable:()=>{}}))
 assert.match(html,/已核验/)
 assert.doesNotMatch(html,/未核验/)
})

test('MarketPluginInstallControl 首次渲染（记录尚未从 useEffect 回来）不报错、不显示启用区',()=>{
 const api={
  list:async()=>({items:[]}),
  preview:async()=>preview,
  install:async()=>{throw Error('不应调用')},
  reconcile:async()=>{throw Error('不应调用')},
 }
 const html=render(createElement(MarketPluginInstallControl,{api:api as never,source,title:'@example/visualize'}))
 assert.match(html,/DSH 扩展安装/)
 assert.doesNotMatch(html,/已安装 · 待启用/)
})

test('组件源码通过白名单构造器提交启用请求，不手写内联 payload，也不直接回显 WorkError 明细',async()=>{
 const source=await readFile(new URL('../src/client/MarketPluginInstallations.tsx',import.meta.url),'utf8')
 assert.match(source,/marketPluginEnableSpec\(record,crypto\.randomUUID\(\)\)/)
 assert.match(source,/localizeWorkError\(locale,cause\)/)
 assert.doesNotMatch(source,/action:\s*'enable'/,'启用动作字段只应出现在 market-plugin-install-state.ts 的白名单构造器里')
 assert.doesNotMatch(source,/cause\.message|error\.message/)
})

test('确认区共用样式有真实定义：边框、浅底与内边距，不是从未定义过的空类名',async()=>{
 const css=await readFile(new URL('../src/client/RealSkillInstallations.module.css',import.meta.url),'utf8')
 assert.match(css,/\.notice\{[^}]*border:[^}]*border-radius:[^}]*background:[^}]*\}/)
})

test('市场安装词典按十一列固定收录启用相关文案，且十种语言均非空',()=>{
 const keys=['market.plugin.install.state.pendingEnable','market.plugin.install.state.enabledRestart','market.plugin.install.action.enable','market.plugin.install.enable.title','market.plugin.install.enable.notice','market.plugin.install.enable.acknowledge','market.plugin.install.field.trust','market.plugin.install.trust.verified','market.plugin.install.trust.unverified','market.plugin.install.trust.verifiedNotice','market.plugin.install.trust.unverifiedNotice']
 for(const key of keys){
  const row=MARKET_INSTALLATION_MESSAGE_ROWS.find(item=>item[0]===key)
  assert.ok(row,key)
  assert.equal(row!.length,11,key)
  for(const cell of row!)assert.ok(cell.trim().length>0,key)
 }
})

test('信任结论三态三文案：被拒绝的补丁不与“仅未签名”共用一句话，并用告警色',()=>{
 assert.equal(trustKey('verified'),'market.plugin.install.trust.verified')
 assert.equal(trustKey('unverified'),'market.plugin.install.trust.unverified')
 assert.equal(trustKey('rejected'),'market.plugin.install.trust.rejected')
 assert.equal(trustNoticeKey('rejected'),'market.plugin.install.trust.rejectedNotice')
 assert.notEqual(trustNoticeKey('rejected'),trustNoticeKey('unverified'))
 for(const key of ['market.plugin.install.trust.rejected','market.plugin.install.trust.rejectedNotice']){
  const row=MARKET_INSTALLATION_MESSAGE_ROWS.find(entry=>entry[0]===key)
  assert.ok(row,key)
  assert.equal(row!.length,11,key)
  for(const value of row!.slice(1))assert.ok(value.trim(),key)
 }
 const html=render(createElement(EnableConfirm as never,{preview:{...preview,trust:{...preview.trust,status:'rejected'}},ack:false,setAck:()=>{},busy:false,enable:()=>{}} as never))
 assert.match(html,/<span class="warn">已拒绝<\/span>/)
})

test('启用确认区同屏给出完整性摘要：启用是最后一次人工把关',()=>{
 const html=render(createElement(EnableConfirm as never,{preview,ack:false,setAck:()=>{},busy:false,enable:()=>{}} as never))
 assert.ok(html.includes(preview.trust.integrity),'integrity 必须与发布者、信任结论同屏可核')
 assert.match(html,/完整性摘要|完整性/)
})
