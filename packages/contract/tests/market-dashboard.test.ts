import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import * as api from '../src/index.ts'
import {readMarketIndexV2 as readAlpha6Index} from '../../../tests/fixtures/旧版市场索引读取器-v2-0.2.0-alpha.6/market-index.ts'

export const dashboardCatalogFixture=()=>({
 format:'teloa.market-catalog-entry/v1',id:'teloa.dashboard.soc',kind:'dashboard',delivery:'install',version:'1.0.0',upstream:null,
 taxonomy:{functions:['security'],industries:['cyber-security/soc']},
 dashboard:{packageId:'soc-dashboard',title:{'zh-CN':'告警处置看板',en:'Alert board'},summary:{'zh-CN':'查看和跟进告警。',en:'Review and track alerts.'},scope:'SOC',capabilities:{now:[{'zh-CN':'查看告警记录',en:'Review alert records'}],needs:[{'zh-CN':'选择目标业务并确认字段',en:'Choose a business and confirm fields'}],permissions:[{'zh-CN':'不会自动授予权限',en:'Does not grant permissions automatically'}]}},
 modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-01',reviewer:'Teloa'},
})
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'

test('业务看板在独立分类中紧接方案，目录计数保持严格六类',()=>{
 assert.deepEqual(api.marketEntryKinds,['solution','dashboard','role','skill','connector','model'])
 assert.deepEqual(api.emptyMarketCatalogCounts(),{solution:0,dashboard:0,role:0,skill:0,connector:0,model:0})
 const value=dashboardCatalogFixture(),parsed=api.readMarketCatalogEntry(value)
 assert.deepEqual(parsed,value)
 assert.equal(api.marketEntryNeedsV2(parsed),true)
 assert.deepEqual(api.readMarketCatalogListContents({ 'business-configuration':1},api.readMarketCatalogEntry(JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/solutions/teloa.soc.json',import.meta.url),'utf8')))),{'business-configuration':1})
})

test('业务看板目录只接受固定安装元数据，最低应用版本须包含 alpha.7 格式支持',()=>{
 const value=dashboardCatalogFixture()
 for(const mutation of [{...value,delivery:'builtin'},{...value,solution:value.dashboard},{...value,upstream:{}},{...value,compatibility:{...value.compatibility,teloa:'>=0.2.0-alpha.6'}},{...value,dashboard:{...value.dashboard,automaticMapping:true}},{...value,dashboard:{...value.dashboard,capabilities:{...value.dashboard.capabilities,permissions:[]}}}])assert.throws(()=>api.readMarketCatalogEntry(mutation),invalid)
})

test('业务看板工件须有根清单和许可，包身份在目录中唯一',()=>{
 const entry=api.readMarketCatalogEntry(dashboardCatalogFixture())
 const files=[{path:'teloa.json',sha256:sha('manifest'),size:8},{path:'LICENSE',sha256:sha('license'),size:7}]
 const artifact={files,treeHash:api.marketCatalogTreeHash(files,sha)}
 assert.deepEqual(api.readMarketCatalogArtifact(artifact,entry,sha),artifact)
 const onlyLicense=[files[1]!]
 assert.throws(()=>api.readMarketCatalogArtifact({files:onlyLicense,treeHash:api.marketCatalogTreeHash(onlyLicense,sha)},entry,sha),/teloa\.json/)
 assert.throws(()=>api.readMarketCatalogIndex({format:'teloa.market-catalog/v1',catalogVersion:'2026.10.1',entries:[{...entry,artifact},{...entry,id:'teloa.dashboard.other',artifact}]},sha),/看板包标识/)
})

test('业务看板只进 v2，旧 alpha.6 读取器跳过新类型且仍可读取既有方案',()=>{
 const dashboard=dashboardCatalogFixture(),solution=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/solutions/teloa.soc.json',import.meta.url),'utf8'))
 const entries=[dashboard,solution].sort((a,b)=>a.id<b.id?-1:1),value={format:'teloa.market-index/v2',catalogVersion:'2026.10.1',entries}
 assert.equal(api.assembleMarketIndexV2(value).entries.length,2)
 assert.equal(api.readMarketIndexV2(value,'0.2.0-alpha.7').entries.length,2)
 assert.deepEqual(readAlpha6Index(value,'0.2.0-alpha.6').skipped,{unknownKind:1,newerApp:0})
 assert.deepEqual(readAlpha6Index(value,'0.2.0-alpha.6').entries.map(row=>row.id),['teloa.soc'])
 assert.throws(()=>api.readMarketIndex({...value,format:'teloa.market-index/v1'}),/v1 索引/)
})
