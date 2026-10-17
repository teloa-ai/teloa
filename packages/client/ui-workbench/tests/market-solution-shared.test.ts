import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,readdirSync} from 'node:fs'
import {currentSolutionCatalog,localReadOnlyConnections,officialSolutionItem} from '../src/client/market-solution-presentation.ts'
import {composeFromCounts,composeFromManifest,sourceConnectorMode} from '../src/client/industry-composition.ts'
import {validateIndustryManifest} from '../src/client/industry-manifest.ts'
import {sourceLabel} from '../src/client/market-preview.ts'

// 设计约束）：官方包可直接作为问答依据；列表计数与清单七行同一算法；本机方案页与官方页的接入源读写同一口径。
const root=new URL('../../../../tests/fixtures/public-market/',import.meta.url)
const read=(path:string)=>JSON.parse(readFileSync(new URL(path,root),'utf8'))
const entry=read('catalog/solutions/teloa.cn-workspace.json')
const manifest=validateIndustryManifest(read('artifacts/solutions/teloa.cn-workspace/1.0.0/teloa.json'))
const connectors=readdirSync(new URL('catalog/connectors/',root)).map(name=>read('catalog/connectors/'+name))
const encoder=new TextEncoder()
const packageFiles=(prefix:string)=>['connections/lark-read.json','connections/yuque-read.json'].map(path=>({path:prefix+path,hash:'a'.repeat(64),bytes:encoder.encode(readFileSync(new URL('artifacts/solutions/teloa.cn-workspace/1.0.0/'+path,root),'utf8'))}))

test('本机方案页的接入源读写：读包内连接声明，按官方连接器目录判定，与官方页同一口径',()=>{
 const content=(prefix:string)=>({manifestPath:prefix+'teloa.json',hash:'b'.repeat(64),files:packageFiles(prefix),resources:[]})
 assert.deepEqual(localReadOnlyConnections(manifest,content(''),connectors),['lark-read','yuque-read'])
 assert.deepEqual(localReadOnlyConnections(manifest,content('pkg/'),connectors),['lark-read','yuque-read'],'清单在子目录时按清单所在目录找连接声明')
 assert.deepEqual(localReadOnlyConnections(manifest,undefined,connectors),[],'没有包内文件（内置示例）时一律按保守口径')
 assert.deepEqual(localReadOnlyConnections(manifest,content(''),[]),[],'读不到官方连接器目录时按保守口径')
 const broken={...content(''),files:[{path:'connections/lark-read.json',hash:'a'.repeat(64),bytes:encoder.encode('{')}]}
 assert.deepEqual(localReadOnlyConnections(manifest,broken,connectors),[],'连接声明读不出来时不算只读，也不报错')
 const lark=manifest.resources.find(resource=>resource.id==='lark-read')!
 assert.deepEqual(sourceConnectorMode(lark,['lark-read']),{mode:'read'})
 assert.deepEqual(sourceConnectorMode(lark,[]),{mode:'write',approval:false})
})

test('列表计数与清单七行同一算法：按资源类型计数算出的七行与直接读清单一致',()=>{
 const counts:Record<string,number>={}
 for(const resource of manifest.resources)counts[resource.kind]=(counts[resource.kind]??0)+1
 assert.deepEqual(composeFromCounts(counts),composeFromManifest(manifest))
})

test('官方包作为问答依据：标题、简介、准备事项取自目录条目，清单取自方案包，来源写明是 Teloa 官方目录',()=>{
 const item=officialSolutionItem(entry,manifest)
 assert.equal(item.id,'catalog:teloa.cn-workspace@1.0.0')
 assert.equal(item.title,'中国企业办公协同');assert.equal(item.version,'1.0.0');assert.equal(item.manifest,manifest)
 assert.deepEqual(item.requirements,entry.solution.capabilities.needs.map((value:{'zh-CN':string})=>value['zh-CN']))
 assert.deepEqual(item.source,{kind:'catalog',entryId:'teloa.cn-workspace',version:'1.0.0'})
 assert.equal(sourceLabel(item.source),'Teloa 官方目录 · teloa.cn-workspace@1.0.0')
 assert.equal(item.localized?.title?.locales.en,'China workplace collaboration')
})

test('「先问问」临时带进来的官方方案不进全局搜索与本人目录，市场不再重复解释资源流程',()=>{
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 // 全局搜索与目录核验共用 searchableMarketItems，它只读 currentSolutionCatalog 的本机当前版本目录。
 assert.match(frame,/const searchableMarketItems=\(\)=>currentSolutionCatalog\(marketRef\.current\.items\)/)
 assert.match(frame,/get market\(\)\{return searchableMarketItems\(\)/)
 // 真实过滤行为：来源为官方目录的临时方案不进目录，本机导入与内置来源保留且顺序不变。
 const temporary=officialSolutionItem(entry,manifest),local={...temporary,id:'local-copy',source:{kind:'builtin' as const}}
 assert.deepEqual(currentSolutionCatalog([temporary,local]).map(row=>row.id),['local-copy'])
 assert.deepEqual(currentSolutionCatalog([temporary]),[])
 const page=readFileSync(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(page, /<GuidedSetup|market\.guide\.summary/)
})
