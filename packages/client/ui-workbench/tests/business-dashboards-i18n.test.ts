import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {BUSINESS_DASHBOARD_MESSAGE_ROWS} from '../src/client/i18n/locales/business-dashboards.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const {catalogs}=await import('../lib/types/client/i18n/messages.js') as {catalogs:Record<string,Record<string,string>>}
const files=['BusinessDashboardPage.tsx','BusinessWidgets.tsx','BusinessDashboardList.tsx','BusinessSyncControls.tsx']
const components=await Promise.all(files.map(name=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')))
const wired=[...components,...await Promise.all(['BusinessPage.tsx','BusinessLedger.tsx','WorkNavigation.tsx','business-widget-presentation.ts','business-dashboard-errors.ts'].map(name=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')))]
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const
/** 与 `i18n-messages.test.ts` 同一张按语言分派的禁词表。 */
const forbidden:Record<typeof locales[number],RegExp>={
 'zh-CN':/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,
 'zh-Hant':/工作空間|單空間|實例|投影|尚未載入|內容待讀取|\d+\s*項資源|人類/,
 en:/workspace|instance|\bhumans?\b/i,
 ja:/ワークスペース|インスタンス|人間/,
 ko:/워크스페이스|인스턴스|인간/,
 vi:/workspace|instance|con người/i,
 es:/workspace|instance|humanos?/i,
 fr:/workspace|instance|humains?/i,
 de:/workspace|instance|Mensch(?:en)?/i,
 pt:/workspace|instance|humanos?/i,
}

test('看板词表十一列、键唯一、并入核心词表，禁词不命中',()=>{
 const keys=BUSINESS_DASHBOARD_MESSAGE_ROWS.map(row=>row[0])
 assert.equal(new Set(keys).size,keys.length)
 for(const row of BUSINESS_DASHBOARD_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(row.every(value=>value.trim()),row[0])
  assert.notEqual(row[3],row[1],row[0]+' 英文不能直接复用中文')
  assert.equal(catalogs['zh-CN']![row[0]],row[1],'未并入 zh-CN：'+row[0])
  locales.forEach((locale,index)=>assert.doesNotMatch(row[index+1]!,forbidden[locale],row[0]+' '+locale))
  assert.ok(wired.some(source=>source.includes("'"+row[0]+"'")),'未接线：'+row[0])
 }
})

test('看板组件源码不写固定中文、不经 HTML 字符串注入',()=>{
 components.forEach((source,index)=>{
  assert.deepEqual(chineseUiLiterals(source),[],files[index])
  assert.doesNotMatch(source,/dangerouslySetInnerHTML|innerHTML/,files[index])
 })
})

test('整页时间范围七行与组件下钻两行：键齐全、中文照规格、英文列无中日韩字符',()=>{
 const rows=new Map<string,readonly string[]>(BUSINESS_DASHBOARD_MESSAGE_ROWS.map(row=>[row[0],row]))
 const expected={
  'business.dashboards.range.label':'时间范围','business.dashboards.range.24h':'近 24 小时','business.dashboards.range.7d':'近 7 天','business.dashboards.range.30d':'近 30 天',
  'business.dashboards.range.90d':'近 90 天','business.dashboards.range.all':'全部时间','business.dashboards.range.unbound':'不随时间范围变化',
  'business.dashboards.drilldown.open':'查看对象','business.dashboards.drilldown.row':'查看 {value}',
 }
 for(const [key,zh] of Object.entries(expected)){
  const row=rows.get(key)
  assert.ok(row,'缺词条：'+key)
  assert.equal(row[1],zh,key)
  assert.doesNotMatch(row[3]!,/[぀-ヿ㐀-鿿가-힯]/,key+' en')
 }
})
