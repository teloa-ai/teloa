import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {businessChartTypes,businessFieldTypes,businessViewKinds,businessViewWindows} from '@teloa/contract'
import {inspectIndustryContent} from '../src/client/industry-content.ts'
import {readIndustryDirectory,type IndustryContent} from '../src/client/industry-directory.ts'
import {industryResourceKinds,type IndustryManifest,type IndustryResourceKind} from '../src/client/industry-manifest.ts'
import {BUSINESS_SHARE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-share.ts'

// 和 business-ledger-render.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {IndustryContents}=await import('../lib/types/client/IndustryContents.js')
const {industryBrowserGroups}=await import('../lib/types/client/IndustryResourceBrowser.js') as {industryBrowserGroups:ReadonlyArray<{title:string;kinds:readonly IndustryResourceKind[]}>}
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {CORE_PAGE_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/core-pages.js') as {CORE_PAGE_MESSAGE_ROWS:ReadonlyArray<readonly string[]>}

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}

const fixtureRoot=new URL('../../../../tests/fixtures/业务定制层/SOC/',import.meta.url)
const walk=async(dir:URL,prefix=''):Promise<{path:string;bytes:Uint8Array}[]>=>{
 const found:{path:string;bytes:Uint8Array}[]=[]
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
  const next=new URL(entry.name+(entry.isDirectory()?'/':''),dir)
  if(entry.isDirectory())found.push(...await walk(next,prefix+entry.name+'/'))
  else found.push({path:prefix+entry.name,bytes:new Uint8Array(await readFile(next))})
 }
 return found
}
const fixture=await walk(fixtureRoot)
const item=await readIndustryDirectory(fixture.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),'teloa.json','安全运营台账')
assert.ok(item.manifest?.format==='teloa.business-package/v2'&&item.packageContent,'SOC 夹具必须能读成行业模板')
const manifest:IndustryManifest=item.manifest
const packageContent:IndustryContent=item.packageContent

/** 预览一次只渲染被选中的那一项，因此按资源逐个裁出单资源清单再渲染，才能把三类声明的摘要都看到。 */
const single=(id:string):{manifest:IndustryManifest;content:IndustryContent}=>{
 const resource=manifest.resources.find(row=>row.id===id)
 assert.ok(resource?.source.kind==='local',id)
 const file=packageContent.files.find(row=>row.path===(resource.source as {path:string}).path)
 assert.ok(file,id)
 return {manifest:{...manifest,resources:[resource],relations:[],entrypoints:[]},content:{manifestPath:'teloa.json',hash:packageContent.hash,resources:[],files:[file]}}
}
const paint=(id:string)=>{
 const one=single(id)
 return renderToStaticMarkup(createElement(I18nProvider as never,{runtime} as never,createElement(IndustryContents as never,{manifest:one.manifest,content:one.content} as never)))
}
const objectTypeIds=['alert-ticket','incident-ticket','asset'] as const
const viewIds=['soc-risk-distribution','soc-pending-board','soc-alert-trend','soc-alert-list'] as const
const actionIds=['assign-alert-review','isolate-endpoint'] as const

test('SOC 夹具的三份对象类型、四张视图与两个动作都按各自的契约读成声明，不落回知识原文',()=>{
 const rows=new Map(inspectIndustryContent(manifest,packageContent).map(row=>[row.id,row]))
 for(const [ids,kind] of [[objectTypeIds,'object-type'],[viewIds,'business-view'],[actionIds,'business-action']] as const){
  for(const id of ids){
   const row=rows.get(id)
   assert.equal(row?.state,'parsed',id+' 应解析成功：'+row?.message)
   assert.equal(row?.definition?.kind,kind,id)
  }
 }
 assert.equal([...objectTypeIds,...viewIds,...actionIds].length,9)
})

test('对象类型摘要给类型名、单位、字段数与绑定的来源，字段清单只有标签与类型名',()=>{
 const html=paint('alert-ticket')
 for(const piece of ['告警工单','单位','条','字段数','7 项','绑定的来源','security-alert-http','默认动作','assign-alert-review','字段清单'])assert.ok(html.includes(piece),piece)
 const items=[...html.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(match=>match[1])
 assert.deepEqual(items,['严重度 · 选项','主机 · 文本','当前判定 · 选项','首次出现 · 时间','最近变化 · 时间','涉及账号数 · 数字','关联调查 · 关联'])
})

test('视图摘要把形态与图形写成人话，度量与筛选只给条数',()=>{
 const trend=paint('soc-alert-trend')
 for(const piece of ['告警趋势','形态','趋势','图形','折线图','看哪类对象','alert-ticket','度量条数','3 项','筛选条数','0 项','时间窗','最近 30 天'])assert.ok(trend.includes(piece),piece)
 const distribution=paint('soc-risk-distribution')
 for(const piece of ['分布','柱状图'])assert.ok(distribution.includes(piece),piece)
 assert.ok(!distribution.includes('时间窗'),'没有时间窗的视图不写这一行')
 const board=paint('soc-pending-board')
 for(const piece of ['大盘卡','单值'])assert.ok(board.includes(piece),piece)
 const list=paint('soc-alert-list')
 for(const piece of ['清单','表格'])assert.ok(list.includes(piece),piece)
})

test('动作摘要给目标类型、任务模板标识与输入项数，并写明接收方必须正好要求同样多项输入',()=>{
 const isolate=paint('isolate-endpoint')
 for(const piece of ['隔离这台主机','对哪类对象','alert-ticket','目标类型','执行工具','任务模板标识','endpoint-isolation-record','输入项数','2 项','任务模板需包含 2 项输入；数量不一致时无法加载此操作，请检查任务模板。'])assert.ok(isolate.includes(piece),piece)
 const assign=paint('assign-alert-review')
 for(const piece of ['任务模板','alert-triage-review','3 项','任务模板需包含 3 项输入；数量不一致时无法加载此操作，请检查任务模板。'])assert.ok(assign.includes(piece),piece)
})

test('摘要只显示结构：快照字段标签、枚举取值、字面量取值与原始 JSON 一个都不进页面',()=>{
 const html=[...objectTypeIds,...viewIds,...actionIds].map(paint).join('\n')
 // 落到 `else` 会被当知识原文，用 `<pre>` 把整份 JSON 打出来——这条断言就是钉住那件事没有发生。
 assert.ok(!html.includes('<pre'),'摘要不得出现 <pre>')
 assert.ok(!html.includes('"format":"teloa.business-'),'摘要不得出现原始 JSON 的 format 字样')
 // `from` 指向别人快照里的字段标签，内部字段名同理：本夹具里 `severity` 既是字段名也是那一列的拉丁标识。
 for(const name of ['severity','verdict','first-seen-at','account-count','registered-at'])assert.ok(!html.includes(name),'不得出现字段标识：'+name)
 // 三份对象类型 `values` 里的声明取值，一个都不显示。
 for(const value of ['还没有人看','等你确认','已确认维护','进来的事','需要你','已完成','生产','测试'])assert.ok(!html.includes(value),'不得出现枚举取值：'+value)
 // `from:'literal'` 的字面量。
 assert.ok(!html.includes('按告警工单发起'),'不得出现动作输入的字面量取值')
 // 度量标签「高 / 中 / 低」是按严重度分线的取值串，只给条数就不会漏出来。
 for(const value of ['>高<','>中<','>低<'])assert.ok(!html.includes(value),'不得出现度量取值串：'+value)
})

test('正文标识或版本与清单不一致的声明落 invalid，且消息带得出是哪个文件',()=>{
 for(const [key,value] of [['id','other-type'],['version','2.0.0']] as const){
  const one=single('alert-ticket')
  const raw=JSON.parse(new TextDecoder().decode(one.content.files[0]!.bytes)) as Record<string,unknown>
  const content:IndustryContent={...one.content,files:[{...one.content.files[0]!,bytes:new TextEncoder().encode(JSON.stringify({...raw,[key]:value}))}]}
  const row=inspectIndustryContent(one.manifest,content)[0]
  assert.equal(row?.state,'invalid',key)
  assert.ok(row?.message.includes('object-types/alert-ticket.json'),row?.message)
 }
})

test('目录分组覆盖 industryResourceKinds 全集，以后加资源类型漏改分组就红',()=>{
 const covered=industryBrowserGroups.flatMap(group=>[...group.kinds])
 assert.equal(new Set(covered).size,covered.length,'同一类型不得落进两个分组')
 assert.deepEqual([...covered].sort(),[...industryResourceKinds].sort())
})

test('分享摘要词表十一列齐全、零回落，且四组封闭枚举逐项都有人话',()=>{
 for(const row of BUSINESS_SHARE_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(row.every(value=>value.trim()),row[0]+' 有空列')
  assert.notEqual(row[3],row[1],row[0]+' 的英文与中文逐字相同')
  assert.notEqual(row[4],row[1],row[0]+' 的日文与中文逐字相同')
 }
 const keys:readonly string[]=BUSINESS_SHARE_MESSAGE_ROWS.map(row=>row[0])
 for(const [prefix,members] of [
  ['market.industry.business.viewKind.',businessViewKinds],
  ['market.industry.business.chart.',businessChartTypes],
  ['market.industry.business.fieldType.',businessFieldTypes],
  ['market.industry.business.window.',businessViewWindows],
 ] as const)for(const member of members)assert.ok(keys.includes(prefix+member),'缺人话词条：'+prefix+member)
})

test('分享摘要词条接进核心词表且每个键都真被界面引用',async()=>{
 const core=CORE_PAGE_MESSAGE_ROWS.map(row=>row[0])
 assert.equal(new Set(core).size,core.length,'核心词表出现重复键')
 // 落点键由 industry-template-presentation 的共同真源提供，两个消费组件不再各自抄一份数组。
 const wired=(await Promise.all(['IndustryContents.tsx','IndustryResourceBrowser.tsx','IndustryLoadForm.tsx','BusinessShareForm.tsx','industry-template-presentation.ts'].map(name=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')))).join('\n')
 for(const [key] of BUSINESS_SHARE_MESSAGE_ROWS){
  assert.ok(core.includes(key),'未接进核心词表：'+key)
  // 四组枚举按 `前缀 + 枚举值` 拼键，源码里只看得到前缀，两种写法都算接线。
  const prefix=key.slice(0,key.lastIndexOf('.')+1)
  assert.ok(wired.includes("'"+key+"'")||wired.includes("'"+prefix+"'"),'未接线的词条：'+key)
 }
})
