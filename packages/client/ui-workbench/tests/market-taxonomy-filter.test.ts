// TDD：市场行业 / 功能两排筛选纯函数测试（功能验证）
import assert from 'node:assert/strict'
import test from 'node:test'
import type {MarketCatalogItem} from '../src/client/market-catalog-api.ts'

// 直接从源导入纯 TS 模块，无需构建
const {filterByTaxonomy,getIndustrySubKeys,getTaxonomyLabel,taxonomySearchTerms,taxonomyMessageKey} = await import('../lib/types/client/market-taxonomy-filter.js')
const {catalogEntry, solutionEntry} = await import('./market-catalog-fixture.ts')

function item(patch: {functions?: string[]; industries?: string[]} = {}): MarketCatalogItem {
  const base = catalogEntry()
  return {
    entry: {
      ...base,
      taxonomy: {
        functions: patch.functions ?? base.taxonomy.functions,
        industries: patch.industries ?? base.taxonomy.industries,
      },
    } as unknown as MarketCatalogItem['entry'],
    artifact: null,
    addedContentId: null,
    addedRoleId: null,
    secretGroup: null,
  }
}

const skillCommunicationGeneral = item()         // functions:['communication'], industries:['general']
const skillSecuritySoc = item({functions: ['security'], industries: ['cyber-security/soc']})
const skillSecurityDetection = item({functions: ['dev-tools'], industries: ['cyber-security/detection']})
const skillMarketing = item({functions: ['content-design'], industries: ['marketing', 'marketing/new-media']})
const skillOther = item({functions: ['other'], industries: ['other']})
const skillPrivate = item({functions: ['automation'], industries: ['compliance' as never]}) // unknown domain
const skillEngineering = item({functions: ['dev-tools'], industries: ['software/engineering']})
const skillProduct = item({functions: ['data-research'], industries: ['software/product']})
const skillEcommerce = item({functions: ['business-ops'], industries: ['marketing/e-commerce']})

const all = [skillCommunicationGeneral, skillSecuritySoc, skillSecurityDetection, skillMarketing, skillOther, skillPrivate, skillEngineering, skillProduct, skillEcommerce]

test('无筛选：返回所有条目', () => {
  assert.equal(filterByTaxonomy(all, {industry: null, fn: null}).length, all.length)
})

test('行业全部 + 功能筛选：只返回匹配功能', () => {
  const result = filterByTaxonomy(all, {industry: null, fn: 'security'})
  assert.equal(result.length, 1)
  assert.ok(result.includes(skillSecuritySoc))
})

test('功能全部 + 行业根键：包含根键本身及其二级', () => {
  const result = filterByTaxonomy(all, {industry: 'cyber-security', fn: null})
  // cyber-security/soc 和 cyber-security/detection 都属于 cyber-security
  assert.equal(result.length, 2)
  assert.ok(result.includes(skillSecuritySoc))
  assert.ok(result.includes(skillSecurityDetection))
})

test('选中二级键：只返回该二级', () => {
  const result = filterByTaxonomy(all, {industry: 'cyber-security/soc' as never, fn: null})
  assert.equal(result.length, 1)
  assert.ok(result.includes(skillSecuritySoc))
})

test('选中 marketing 根键：返回含 marketing、marketing/new-media 或 marketing/e-commerce 的条目', () => {
  const result = filterByTaxonomy(all, {industry: 'marketing', fn: null})
  assert.equal(result.length, 2)
  assert.ok(result.includes(skillMarketing))
  assert.ok(result.includes(skillEcommerce))
})

test('software 根键收录 software/engineering 与 software/product；二级键精确匹配', () => {
  const root = filterByTaxonomy(all, {industry: 'software', fn: null})
  assert.equal(root.length, 2)
  assert.ok(root.includes(skillEngineering))
  assert.ok(root.includes(skillProduct))
  assert.deepEqual(filterByTaxonomy(all, {industry: 'software/engineering' as never, fn: null}), [skillEngineering])
  assert.deepEqual(filterByTaxonomy(all, {industry: 'software/product' as never, fn: null}), [skillProduct])
  assert.deepEqual(filterByTaxonomy(all, {industry: 'marketing/e-commerce' as never, fn: null}), [skillEcommerce])
  assert.deepEqual(getIndustrySubKeys('software'), ['software/engineering', 'software/product'])
  assert.deepEqual(getIndustrySubKeys('marketing'), ['marketing/new-media', 'marketing/e-commerce'])
})

test('「其他」行业：收录 other 键', () => {
  const result = filterByTaxonomy(all, {industry: 'other', fn: null})
  assert.ok(result.includes(skillOther))
  assert.ok(!result.includes(skillCommunicationGeneral))
})

test('私有模板的未知 domain 归入「其他」', () => {
  // skillPrivate has industries: ['compliance'] which is NOT in marketIndustryKeys → treated as 'other'
  const result = filterByTaxonomy(all, {industry: 'other', fn: null})
  assert.ok(result.includes(skillPrivate))
})

test('行业 + 功能联合筛选：同时满足两个条件', () => {
  const result = filterByTaxonomy(all, {industry: 'cyber-security', fn: 'security'})
  assert.equal(result.length, 1)
  assert.ok(result.includes(skillSecuritySoc))
})

test('空数组输入返回空数组', () => {
  assert.equal(filterByTaxonomy([], {industry: 'cyber-security', fn: null}).length, 0)
})

test('分类文案按当前界面语言取 11 列翻译，不只分简体与英文',()=>{
 assert.equal(taxonomyMessageKey('industry','cyber-security/soc'),'market.taxonomy.industry.cyber-security.soc')
 assert.equal(taxonomyMessageKey('function','office-docs'),'market.taxonomy.function.office-docs')
 assert.equal(taxonomyMessageKey('function','security/soc'),undefined)
 assert.equal(taxonomyMessageKey('industry','unknown'),undefined)
 const zh=getTaxonomyLabel('industry','cyber-security','zh-CN'),tw=getTaxonomyLabel('industry','cyber-security','zh-TW'),ja=getTaxonomyLabel('industry','cyber-security','ja'),en=getTaxonomyLabel('industry','cyber-security','en')
 assert.ok(zh&&tw&&ja&&en)
 assert.notEqual(tw,zh)
 assert.notEqual(ja,en)
 assert.equal(getTaxonomyLabel('industry','not-a-key','zh-CN'),undefined)
})

test('cyber-security 与 other：行业键改名后两个维度取各自文案',()=>{
 assert.equal(getTaxonomyLabel('industry','cyber-security','zh-CN'),'网络安全')
 assert.equal(getTaxonomyLabel('function','security','zh-CN'),'安全')
 assert.notDeepEqual(taxonomySearchTerms('industry','cyber-security'),taxonomySearchTerms('function','security'))
})

test('搜索词覆盖全部界面语言的分类名',()=>{
 const terms=taxonomySearchTerms('industry','cyber-security')
 for(const locale of ['zh-CN','zh-TW','en','ja'])assert.ok(terms.includes(getTaxonomyLabel('industry','cyber-security',locale)!),locale)
 assert.deepEqual(taxonomySearchTerms('industry','not-a-key'),[])
})

test('二级行业的搜索词包含上一级行业名称',()=>{
 const terms=taxonomySearchTerms('industry','cyber-security/soc')
 assert.ok(terms.includes(getTaxonomyLabel('industry','cyber-security','zh-CN')!))
 assert.ok(terms.includes('Cyber Security'))
 assert.ok(terms.includes(getTaxonomyLabel('industry','cyber-security/soc','zh-CN')!))
})

test('新增三个二级行业：11 列文案齐全，搜索词回落到上一级行业名称',()=>{
 const cases:[string,string,string,string][]=[
  ['software/engineering','software','研发工程','Engineering'],
  ['software/product','software','产品','Product'],
  ['marketing/e-commerce','marketing','电商','E-commerce'],
 ]
 for(const [key,parent,zh,en] of cases){
  assert.equal(taxonomyMessageKey('industry',key),`market.taxonomy.industry.${key.replace('/','.')}`)
  assert.equal(getTaxonomyLabel('industry',key,'zh-CN'),zh,key)
  assert.equal(getTaxonomyLabel('industry',key,'en'),en,key)
  for(const locale of ['zh-TW','ja','ko','vi','es','fr','de','pt'])assert.ok(getTaxonomyLabel('industry',key,locale),`${key} ${locale}`)
  const terms=taxonomySearchTerms('industry',key)
  assert.ok(terms.includes(zh))
  assert.ok(terms.includes(en))
  assert.ok(terms.includes(getTaxonomyLabel('industry',parent,'zh-CN')!),`${key} 应含上一级 zh-CN`)
  assert.ok(terms.includes(getTaxonomyLabel('industry',parent,'en')!),`${key} 应含上一级 en`)
 }
})
