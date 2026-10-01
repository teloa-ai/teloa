import assert from 'node:assert/strict'
import test from 'node:test'
import {readdir,readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {EvidenceEntry,SecurityAction,SecurityActionExecution,SecurityActionPanel} from '@teloa/contract'
import {securityActionEvidence} from '../src/client/security-action-evidence.ts'

// .tsx 组件不能被 node 直接类型剥离，和 i18n-runtime.test.ts 一样走 tsc 产物；
// tsc 不搬运 CSS Modules，所以就地把 *.module.css 换成类名代理，断言只看结构不看样式。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
// 纯 .ts 模块仍直接读 src，保证测试盯的是源码而不是陈旧产物。
const {EvidenceList}=await import('../lib/types/client/EvidenceList.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {formatDateTime}=await import('../lib/types/client/i18n/format.js')
const {MarkdownPreview}=await import('../lib/types/client/knowledge-markdown.js')

const observedAt='2026-09-15T02:00:00.000Z'
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(entries:readonly EvidenceEntry[])=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(EvidenceList,{entries})))

test('叙述走 Markdown 子集，标题、加粗与列表都成为真实标签',()=>{
 const html=render([{kind:'text',title:'判断依据',body:'## 结论\n\n**高危**外联，参见 `edr-01`\n\n- 命中情报库\n- 连续三次重试'}])
 assert.match(html,/<h2>结论<\/h2>/)
 assert.match(html,/<strong>高危<\/strong>/)
 assert.match(html,/<code>edr-01<\/code>/)
 assert.match(html,/<li>命中情报库<\/li>/)
})

test('日志与命令原样等宽，Markdown 记号与 HTML 都不被解释',()=>{
 const html=render([
  {kind:'log',title:'进程执行记录',body:'*星号* _下划线_ **不该加粗**\n# 不是标题\n<script>alert(1)</script> [x](javascript:alert(2))',source:'edr-01',observedAt},
  {kind:'command',title:'执行命令',body:'isolate --host prod-03 <script>alert(3)</script> [y](javascript:alert(4))'},
 ])
 assert.match(html,/<pre[^>]*><code>\*星号\* _下划线_ \*\*不该加粗\*\*\n# 不是标题\n/)
 assert.doesNotMatch(html,/<strong>不该加粗<\/strong>/)
 assert.doesNotMatch(html,/<h1>/)
 assert.match(html,/isolate --host prod-03/)
 assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),html)
 assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'),html)
 assert.ok(html.includes('[x](javascript:alert(2))'),html)
 assert.doesNotMatch(html,/<script|href="javascript/)
})

test('叙述依据不加载远程图片，知识库的默认渲染不受影响',()=>{
 const markdown='![外联图](https://attacker.example/beacon.png)'
 const evidence=render([{kind:'text',title:'判断依据',body:markdown}])
 assert.doesNotMatch(evidence,/<img/)
 assert.doesNotMatch(evidence,/attacker\.example/)
 assert.match(evidence,/外联图/)
 const knowledge=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(MarkdownPreview,{markdown})))
 assert.match(knowledge,/<img/)
 assert.match(knowledge,/attacker\.example/)
})

test('结构化字段走字段行，来源与采集时间按当前语言呈现',()=>{
 const html=render([{kind:'log',title:'外联日志',body:'1.2.3.4:443',source:'fw-02',observedAt}])
 assert.match(html,/<dl[^>]*>/)
 assert.match(html,/<dt>来源<\/dt><dd>fw-02<\/dd>/)
 assert.ok(html.includes('<dt>采集时间</dt><dd>'+formatDateTime('zh-CN',observedAt)+'</dd>'),html)
})

test('空列表给出明确空态，不渲染空的 dl',()=>{
 const html=render([])
 assert.match(html,/暂无可核对的依据/)
 assert.doesNotMatch(html,/<pre/)
 assert.doesNotMatch(html,/<dl/)
})

const createdAt='2026-09-15T01:00:00.000Z'
const action={id:'a1',ownerId:'o',taskId:'t',version:2,state:'approved',title:'隔离主机',goal:'**确认** C2 外联后隔离 prod-03',tool:'security.endpoint.isolate',riskTier:'high',reversible:'irreversible',playbookVersion:'1.0.0',targetSet:['prod-03'],params:{reason:'C2 外联'},supersedesActionId:null,frozen:null,proposerId:'o',createdAt,updatedAt:observedAt} as unknown as SecurityAction
const approval={id:'ap1',ownerId:'o',actionId:'a1',actionVersion:1,decision:'approved',approverId:'o',reason:'目标与影响已核对',impactConfirmed:true,frozen:{} as never,createdAt:'2026-09-15T01:30:00.000Z'}
const panelOf=(executions:SecurityActionExecution[])=>({taskId:'t',actions:[action],approvals:[approval],executions,proposal:{tools:[]}} as unknown as SecurityActionPanel)
const format={receiptTitle:(kind:'acceptance'|'effect')=>kind==='acceptance'?'受理回执':'效果回执',approvalTitle:(decision:'approved'|'rejected')=>decision==='approved'?'批准意见':'拒绝意见',targetState:(state:'unknown'|'succeeded'|'failed')=>({unknown:'未知',succeeded:'成功',failed:'失败'})[state],goalTitle:'动作目标',dispatchTitle:'派发参数',dispatchSource:(dispatched:boolean)=>dispatched?'执行器派发':'AI 员工提案'}

test('未执行的动作：goal 是叙述，派发参数只放参数本身且署名提案人与提案时间',()=>{
 const entries=securityActionEvidence(action,panelOf([]),format)
 assert.deepEqual(entries.map(entry=>[entry.kind,entry.title]),[['text','动作目标'],['command','派发参数'],['text','批准意见']])
 assert.equal(entries[0]!.body,'**确认** C2 外联后隔离 prod-03')
 assert.equal(entries[1]!.body,JSON.stringify({reason:'C2 外联'},null,2))
 assert.equal(entries[1]!.source,'AI 员工提案')
 assert.equal(entries[1]!.observedAt,createdAt)
 // 工具、剧本与目标属于结构化字段，不混进等宽命令正文。
 assert.doesNotMatch(entries[1]!.body,/security\.endpoint\.isolate|1\.0\.0|prod-03/)
})

test('已执行的动作：派发改署执行器与派发时间，回执目标状态按当前语言呈现',()=>{
 const execution={operationId:'op1',ownerId:'o',actionId:'a1',approvalId:'ap1',approvalVersion:1,state:'succeeded',revision:2,frozen:{} as never,dispatch:{operationId:'op1',actionId:'a1',tool:'security.endpoint.isolate',playbookVersion:'1.0.0',targets:['prod-03'],params:{reason:'C2 外联'}},acceptanceReceipt:null,effectReceipt:{status:'succeeded',receiptId:'r1',detail:'已隔离',observedAt:'2026-09-15T02:30:00.000Z',targets:[{target:'prod-03',state:'succeeded'}]},createdAt:observedAt,updatedAt:'2026-09-15T02:30:00.000Z'} as unknown as SecurityActionExecution
 const entries=securityActionEvidence(action,panelOf([execution]),format)
 assert.deepEqual(entries.map(entry=>[entry.kind,entry.title]),[['text','动作目标'],['command','派发参数'],['text','批准意见'],['log','效果回执']])
 assert.equal(entries[1]!.source,'执行器派发')
 assert.equal(entries[1]!.observedAt,observedAt)
 assert.equal(entries[3]!.body,'已隔离\nprod-03 · 成功')
 assert.equal(entries[3]!.source,'r1')
})

test('全仓客户端源码没有 dangerouslySetInnerHTML',async()=>{
 const root=new URL('../src/client/',import.meta.url)
 const walk=async(dir:URL):Promise<string[]>=>{
  const found:string[]=[]
  for(const entry of await readdir(dir,{withFileTypes:true})){
   const next=new URL(entry.name+(entry.isDirectory()?'/':''),dir)
   if(entry.isDirectory())found.push(...await walk(next))
   else if(/\.(ts|tsx)$/.test(entry.name))found.push(await readFile(next,'utf8'))
  }
  return found
 }
 for(const source of await walk(root))assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})

test('映射处按契约上限收口：超长外部正文与非规范时间都不会让条目整条被拒',async()=>{
 const {readEvidenceEntry}=await import('@teloa/contract')
 const huge={
  ...action,
  goal:'长'.repeat(300_000),
  params:{reason:'x'.repeat(300_000)},
 } as unknown as SecurityAction
 const execution={operationId:'op1',ownerId:'o',actionId:'a1',approvalId:'ap1',approvalVersion:1,state:'succeeded',revision:2,frozen:{} as never,
  dispatch:{operationId:'op1',actionId:'a1',tool:'security.endpoint.isolate',playbookVersion:'1.0.0',targets:['prod-03'],params:{}},
  // 外部回执号与时间都不受本仓控制：回执号超 256、时间用等价但非规范化写法。
  acceptanceReceipt:null,
  effectReceipt:{receiptId:'r'.repeat(400),detail:'已隔离','targets':[{target:'prod-03',state:'succeeded'}],observedAt:'2026-09-15T02:00:00Z'},
  createdAt,updatedAt:createdAt,
 } as unknown as SecurityActionExecution
 const entries=securityActionEvidence(huge,panelOf([execution]),format)
 for(const row of entries)assert.doesNotThrow(()=>readEvidenceEntry(row),row.title)
 assert.ok(entries[0]!.body.endsWith('…'),'截断要留下痕迹')
 assert.equal(entries.at(-1)!.source!.length,256)
 assert.equal(entries.at(-1)!.observedAt,undefined,'非规范化时间不写这个字段，而不是拿它去撞契约')
})
