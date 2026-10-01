import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

// 六处 kinds 清单逐字重复，加类型必须同时改：只改后端则加载能过、导入过不去；只改客户端则界面显示未知类型；
// 漏掉两条回包白名单（DSH 适配与客户端读取器）则整条加载被判 `teloa/invalid-host-response`，界面上只看得到
// 「加载未完成，请重试。」——2026-09-16 隔离宿主验收正是被这两处挡住的，故一并纳入本用例。
// 这条用例是规格 §3.2 那个代价的唯一守卫，它扫的是源码文本，不依赖任何构建产物。
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8')
const expected=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration']

test('业务台账的可选来源称呼同时进入契约和两端读取器白名单',async()=>{
 // 漏任一读取器会让合法台账整条拒收，不能只确认数据源声明自己认识该字段。
 const contract=await read('packages/contract/src/business-definitions.ts')
 assert.match(contract,/export type BusinessLedgerBlock=\{[\s\S]*?source:\{sourceId:string;connected:boolean;sourceNoun\?:string\}/)
 for(const path of ['packages/harness-dsh/src/business-definitions.ts','packages/client/ui-workbench/src/client/business-ledger-api.ts']){
  const source=await read(path)
  assert.match(source,/exact\(row\.source,\['sourceId','connected',\.\.\.\(hasSourceNoun\?\['sourceNoun'\]:\[\]\)\]\)/,path)
 }
})

test('六处行业资源类型清单逐字一致，且含三类业务定制声明',async()=>{
 const store=await read('packages/backend/src/market/content-store.ts')
 const loads=await read('packages/backend/src/work/industry-loads.ts')
 const manifest=await read('packages/client/ui-workbench/src/client/industry-manifest.ts')
 const harness=await read('packages/harness-dsh/src/industry-loads.ts')
 const loadApi=await read('packages/client/ui-workbench/src/client/industry-load-api.ts')
 const market=await read('packages/client/ui-workbench/src/client/market-content-api.ts')
 const quoted=text=>[...text.matchAll(/'([a-z-]+)'/g)].map(match=>match[1])
 const storeList=quoted(/const kinds=\[(.+?)\] as const/s.exec(store)[1])
 const loadsList=quoted(/const kinds:readonly IndustryLoadResourceKind\[\]=\[(.+?)\]/s.exec(loads)[1])
 const loadsUnion=[...(/export type IndustryLoadResourceKind=(.+)/.exec(loads)[1]).matchAll(/'([a-z-]+)'/g)].map(match=>match[1])
 const clientList=quoted(/export const industryResourceKinds=\[(.+?)\] as const/s.exec(manifest)[1])
 const harnessList=quoted(/\nconst kinds=\[(.+?)\]\n/s.exec(harness)[1])
 const loadApiList=quoted(/\nconst kinds=\[(.+?)\] as const/s.exec(loadApi)[1])
 const marketList=quoted(/const resourceKinds=\[(.+?)\] as const/s.exec(market)[1])
 assert.deepEqual(storeList,expected)
 assert.deepEqual(loadsList,expected)
 assert.deepEqual(loadsUnion,expected)
 assert.deepEqual(clientList,expected)
 assert.deepEqual(harnessList,expected)
 assert.deepEqual(loadApiList,expected.filter(kind=>kind!=='business-configuration'))
 assert.deepEqual(marketList,expected)
})

test('明确不改的三处仍然不含业务定制声明', async()=>{
 const compare=await read('packages/contract/src/industry-update-compare.ts')
 const loads=await read('packages/backend/src/work/industry-loads.ts')
 const store=await read('packages/backend/src/market/content-store.ts')
 const detachable=/export const industryUpdateDetachableKinds:readonly string\[\]=\[(.+?)\]/s.exec(compare)[1]
 const carry=/const carryKinds:readonly IndustryLoadResourceKind\[\]=\[(.+?)\]/s.exec(loads)[1]
 const relations=/const relationTargets:Record<string,readonly MarketResourceKind\[\]>=\{(.+?)\n\}/s.exec(store)[1]
 for(const [name,text] of [['detachable',detachable],['carry',carry],['relations',relations]])
  for(const kind of ['object-type','business-view','business-action'])
   assert.ok(!text.includes(kind),name+' 不得含 '+kind)
})
