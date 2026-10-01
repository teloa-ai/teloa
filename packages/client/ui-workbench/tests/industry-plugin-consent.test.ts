import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {readFile} from 'node:fs/promises'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {MarketPluginInstallPreview} from '@teloa/contract'
import type {IndustryPluginInstance} from '../src/client/industry-plugin-api.ts'

// 与 market-plugin-installations-enable.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {IndustryPluginInstallControl,createSequenceGuard}=await import('../lib/types/client/IndustryPluginInstallControl.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

const instanceId='12345678-1234-4234-8234-123456789012'
const definition={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'@teloa/threat-intel-plugin',version:'1.2.0'}
const preview=(status:MarketPluginInstallPreview['trust']['status']='unverified'):MarketPluginInstallPreview=>({
 schema:'teloa.market-plugin-install-preview/v1',
 source:{registry:'npm',packageName:definition.packageName,version:definition.version},
 trust:{status,publisher:'Example Publisher',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},
 bundleHash:'c'.repeat(64),
 permissionSummary:{permissions:[{id:'dsh.bundle.insert',description:'向组合插入一行',required:true},{id:'dsh.tool.read',description:'读取工作区文件',required:false}]},
})
const instance=(state:IndustryPluginInstance['state']):IndustryPluginInstance=>({
 id:instanceId,ownerId:'local:teloa-owner',loadId:'22345678-1234-4234-8234-123456789012',itemInstanceId:'32345678-1234-4234-8234-123456789012',
 itemLocalId:'threat-intel-plugin',contentId:'42345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),itemVersion:'1.0.0',
 scope:'space-1',definition,definitionHash:'b'.repeat(64),
 ...(state==='needs_install'?{state:'needs_install' as const,revision:1 as const,installationId:null}:{state,revision:2,installationId:'62345678-1234-4234-8234-123456789012'}),
 createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z',
} as IndustryPluginInstance)

const control=(props:Record<string,unknown>)=>render(createElement(IndustryPluginInstallControl as never,{
 instance:instance('needs_install'),busy:false,
 preview:async()=>preview(),install:async()=>{},enable:async()=>{},
 ...props,
} as never))

test('未安装时只给一个入口：先看将要改动的内容，不能一键装下去',()=>{
 const html=control({})
 assert.match(html,/安装/)
 // 预览还没拿到，权限摘要与确认区都不该凭空出现。
 assert.doesNotMatch(html,/dsh\.bundle\.insert/)
 assert.doesNotMatch(html,/确认安装|我已核对/)
})

test('待启用的实例给启用确认区：权限逐条、发布者、完整性摘要与信任结论同屏，勾选前不能提交',async()=>{
 // 组件自己去取预览；这里直接把渲染后的确认区形态钉住（预览已在手时的分支）。
 const {PluginPreviewFacts,EnableConfirm}=await import('../lib/types/client/PluginInstallConsent.js')
 const facts=render(createElement(PluginPreviewFacts as never,{value:preview()} as never))
 for(const piece of ['@teloa/threat-intel-plugin','1.2.0','Example Publisher','dsh.bundle.insert','向组合插入一行','dsh.tool.read'])assert.ok(facts.includes(piece),piece)
 assert.ok(facts.includes(preview().trust.integrity),'完整性摘要必须同屏可核')
 const enable=render(createElement(EnableConfirm as never,{preview:preview(),ack:false,setAck:()=>{},busy:false,enable:()=>{}} as never))
 assert.match(enable,/<button[^>]*disabled[^>]*>/,'没勾选核对不能提交启用')
 const ready=render(createElement(EnableConfirm as never,{preview:preview(),ack:true,setAck:()=>{},busy:false,enable:()=>{}} as never))
 assert.doesNotMatch(ready,/<button[^>]*disabled[^>]*>/)
})

test('信任结论三态各有自己的文案，被拒绝的走告警色',async()=>{
 const {trustKey,trustNoticeKey}=await import('../lib/types/client/PluginInstallConsent.js')
 assert.equal(trustKey('rejected'),'market.plugin.install.trust.rejected')
 assert.notEqual(trustNoticeKey('rejected'),trustNoticeKey('unverified'))
 const {EnableConfirm}=await import('../lib/types/client/PluginInstallConsent.js')
 const html=render(createElement(EnableConfirm as never,{preview:preview('rejected'),ack:false,setAck:()=>{},busy:false,enable:()=>{}} as never))
 assert.match(html,/<span class="warn">已拒绝<\/span>/)
})

test('双击「查看将要改动的内容」：两次点击都发出请求，界面必须停在后一次的事实上',async()=>{
 // 复现 LOW-E：世代令牌必须连 setFixed 这类"数据"写入也约束住，不能只约束 error/pending。
 // 这里按生产代码里 run() 的用法重放：先后两轮，前一轮的响应故意晚到。
 const sequence={current:0}
 let committed:string[]=[]
 const run=async(work:(isLatest:()=>boolean)=>Promise<unknown>)=>{
  const {isLatest}=createSequenceGuard(sequence)
  await work(isLatest)
 }
 const requests:Array<()=>void>=[]
 const fetchPreview=(label:string)=>new Promise<string>(resolve=>{requests.push(()=>resolve(label))})
 // 双击：几乎同时发出两轮请求（对应两次连续点击）。
 const first=run(async isLatest=>{const value=await fetchPreview('第一次点击的预览');if(isLatest())committed.push(value)})
 const second=run(async isLatest=>{const value=await fetchPreview('第二次点击的预览');if(isLatest())committed.push(value)})
 // 乱序到达：先发出的第一轮反而后至。
 requests[1]!();await second
 requests[0]!();await first
 assert.deepEqual(committed,['第二次点击的预览'],'先发出的那一轮迟到时不能覆盖后一轮已经写下的事实')
})

test('两处「查看将要改动的内容」都把 setFixed 钉在 isLatest() 判断里，不是只守 error/pending',async()=>{
 // 上一条测的是 createSequenceGuard 本身的语义；这条把守卫落到组件源码里的两个真实调用点，
 // 防止有人以后照抄别处 run(async()=>{...}) 的写法，漏掉 setFixed 前的 isLatest() 判断。
 const source=await readFile(new URL('../src/client/IndustryPluginInstallControl.tsx',import.meta.url),'utf8')
 const setFixedCalls=[...source.matchAll(/if\(isLatest\(\)\)(?:\{setFixed\(next\)|setFixed\(next\))/g)]
 assert.equal(setFixedCalls.length,2,'needs_install 与 pending-enable 两处预览按钮都要守住')
})

test('提交体只带契约白名单字段：安装持固定预览与预期版本，启用不消耗 requestId',async()=>{
 const {createIndustryPluginApi}=await import('../src/client/industry-plugin-api.ts')
 const calls:Array<[string,unknown]>=[]
 const saved={...instance('pending-enable')}
 const api=createIndustryPluginApi(async(method,payload)=>{calls.push([method,payload]);return method.endsWith('/preview')?preview():saved})
 const fixed=await api.preview(instanceId)
 await api.install({requestId:'52345678-1234-4234-8234-123456789012',instanceId,expectedRevision:1,preview:fixed})
 await api.enable(instanceId,fixed)
 assert.deepEqual(calls.map(([method])=>method),['industry-plugins/preview','industry-plugins/install','industry-plugins/enable'])
 assert.deepEqual(Object.keys(calls[1]![1] as object).sort(),['expectedRevision','instanceId','preview','requestId'])
 assert.deepEqual(Object.keys(calls[2]![1] as object).sort(),['instanceId','preview'])
 assert.deepEqual((calls[1]![1] as {preview:MarketPluginInstallPreview}).preview,fixed,'提交的必须就是人核过的那一份')
})
