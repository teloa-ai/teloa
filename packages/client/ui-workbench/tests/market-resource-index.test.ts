import test from 'node:test'
import assert from 'node:assert/strict'
import {sandboxMarket} from '../src/client/market-preview.ts'
import {marketResourceIndex,filterMarketResources} from '../src/client/market-resource-index.ts'
import {localizedMarketResourceEntryTitle} from '../src/client/market-home-presentation.ts'

test('独立资源与两个行业的公共引用投影成同一资源版本，保留全部使用位置',()=>{
 const items=sandboxMarket().items
 const rows=marketResourceIndex(items)
 const reports=rows.filter(row=>row.id==='skill-report')
 assert.equal(reports.length,1)
 assert.equal(reports[0]!.itemId,'skill-report')
 assert.deepEqual(new Set(reports[0]!.uses.map(use=>use.templateId)),new Set(['bundle-general','bundle-security']))
 assert.equal(reports[0]!.status,'catalogued')
 assert.equal(filterMarketResources(rows,{kind:'skill',query:'',referencedIndustry:'security',capability:'写作'}).some(row=>row.id==='skill-report'),true)
 assert.equal(filterMarketResources(rows,{kind:'mcp',query:'',referencedIndustry:'all',capability:'all'}).some(row=>row.id==='resource-mcp'),true)
})
test('同名不同身份与同身份不同版本不合并，引用类型冲突明确呈现',()=>{
 const items=sandboxMarket().items
 const report=items.find(row=>row.id==='skill-report')!
 const rows=marketResourceIndex([...items,{...report,id:'another-report'},{...report,version:'0.2.0'}])
 assert.equal(rows.filter(row=>row.title===report.title).length,3)
 const security=items.find(row=>row.id==='bundle-security')!
 if(security.manifest?.format!=='teloa.business-package/v2')throw Error('fixture')
 const bad=structuredClone(security)
 if(bad.manifest?.format!=='teloa.business-package/v2')throw Error('fixture')
 bad.manifest.resources.find(row=>row.source.kind==='public'&&row.source.id==='skill-report')!.kind='mcp'
 assert.equal(marketResourceIndex([report,bad]).find(row=>row.id==='skill-report')!.status,'conflict')
})
test('同一目录身份与版本的不同内容摘要不能静默采用第一条',()=>{
 const report=sandboxMarket().items.find(row=>row.id==='skill-report')!
 const rows=marketResourceIndex([{...report,hash:'a'.repeat(64)},{...report,hash:'b'.repeat(64)}])
 assert.equal(rows.length,1)
 assert.equal(rows[0]!.status,'conflict')
})
test('资源可见范围独立于引用行业，私人资源不会随公共模板变成公共',()=>{
 const items=sandboxMarket().items.map(item=>item.id==='skill-report'?{...item,visibility:'personal' as const}:item)
 const rows=marketResourceIndex(items)
 const filter={kind:'skill' as const,query:'',referencedIndustry:'security',capability:'写作'}
 assert.equal(filterMarketResources(rows,{...filter,visibility:'public'}).some(row=>row.id==='skill-report'),false)
 assert.equal(filterMarketResources(rows,{...filter,visibility:'personal'}).some(row=>row.id==='skill-report'),true)
 const unresolved=rows.find(row=>row.id==='security-investigation-skill')!
 assert.equal(unresolved.visibility,'unknown')
 assert.equal(filterMarketResources(rows,{kind:'all',query:'',referencedIndustry:'all',capability:'all',visibility:'public'}).includes(unresolved),false)
})
// 第三方插件 dsh-visualize 已整体下线（产品底座只用官方插件），原「可视化插件作为独立通用资源被行业
// 模板推荐而不被复制」一测没有真实的 plugin 夹具可用；owner 过滤这一维度改用仍在架的 skill-report
// （DSH 所有）与 resource-knowledge（Teloa 所有）覆盖，其余合并/引用行为已由上一测（独立资源与两个
// 行业的公共引用投影成同一资源版本）覆盖。
test('独立资源按 owner 过滤：DSH 拥有的资源不与 Teloa 拥有的混在一起',()=>{
 const rows=marketResourceIndex(sandboxMarket().items)
 assert.equal(filterMarketResources(rows,{kind:'all',query:'',referencedIndustry:'all',capability:'all',owner:'DSH'}).some(row=>row.id==='skill-report'),true)
 assert.equal(filterMarketResources(rows,{kind:'all',query:'',referencedIndustry:'all',capability:'all',owner:'DSH'}).some(row=>row.id==='resource-knowledge'),false)
 assert.equal(filterMarketResources(rows,{kind:'all',query:'',referencedIndustry:'all',capability:'all',owner:'Teloa'}).some(row=>row.id==='skill-report'),false)
 assert.equal(filterMarketResources(rows,{kind:'all',query:'',referencedIndustry:'all',capability:'all',owner:'Teloa'}).some(row=>row.id==='resource-knowledge'),true)
})

test('行业资源索引保留标题本地化，目录可按当前语言展示和搜索',()=>{
 const item=structuredClone(sandboxMarket().items.find(row=>row.id==='bundle-security')!)
 if(item.manifest?.format!=='teloa.business-package/v2')throw Error('fixture')
 const resource=item.manifest.resources.find(row=>row.id==='security-investigation-skill')!
 resource.localized={title:{original:resource.title,defaultLocale:'en',locales:{en:'Alert investigation skill','zh-CN':resource.title}}}
 const rows=marketResourceIndex([item]),indexed=rows.find(row=>row.id==='security-investigation-skill')!
 assert.equal(localizedMarketResourceEntryTitle(indexed,'en'),'Alert investigation skill')
 assert.equal(localizedMarketResourceEntryTitle(indexed,'ja'),'Alert investigation skill')
 assert.equal(filterMarketResources(rows,{kind:'skill',query:'alert investigation',referencedIndustry:'all',capability:'all',searchValues:row=>[localizedMarketResourceEntryTitle(row,'en')]}).length,1)
 assert.equal(filterMarketResources(rows,{kind:'skill',query:resource.title,referencedIndustry:'all',capability:'all',searchValues:row=>[localizedMarketResourceEntryTitle(row,'en')]}).length,1)
})

test('独立资源与行业引用合并后仍按独立来源的本地化标题搜索',()=>{
 const items=sandboxMarket().items
 const report=items.find(row=>row.id==='skill-report')!
 const localized={title:{original:report.title,defaultLocale:'en',locales:{en:'Reporting handbook','zh-CN':report.title}}}
 const rows=marketResourceIndex(items.map(item=>item===report?{...report,localized}:item))
 const found=filterMarketResources(rows,{kind:'skill',query:'Reporting handbook',referencedIndustry:'security',capability:'all',searchValues:row=>[localizedMarketResourceEntryTitle(row,'en')]})
 assert.deepEqual(found.map(row=>row.id),['skill-report'])
 assert.equal(localizedMarketResourceEntryTitle(found[0]!,'en'),'Reporting handbook')
})
