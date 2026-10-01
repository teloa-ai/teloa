import test from 'node:test'
import assert from 'node:assert/strict'
import {marketFunctionKeys,marketIndustryKeys,marketIndustryParent,isMarketIndustryRoot,readMarketTaxonomy} from '../src/market-taxonomy.ts'

test('功能键数量为 10，行业键数量为 15（6 一级 + 9 二级）',()=>{
 assert.equal(marketFunctionKeys.length,10)
 assert.equal(marketIndustryKeys.length,15)
 assert.ok((marketFunctionKeys as readonly string[]).includes('office-docs'))
 assert.ok((marketFunctionKeys as readonly string[]).includes('other'))
 assert.ok((marketIndustryKeys as readonly string[]).includes('general'))
 assert.ok((marketIndustryKeys as readonly string[]).includes('cyber-security/soc'))
 assert.ok((marketIndustryKeys as readonly string[]).includes('software/engineering'))
 assert.ok((marketIndustryKeys as readonly string[]).includes('software/product'))
 assert.ok((marketIndustryKeys as readonly string[]).includes('marketing/e-commerce'))
})

test('marketIndustryParent：一级键返回 undefined，二级键返回一级键',()=>{
 assert.equal(marketIndustryParent('general'),undefined)
 assert.equal(marketIndustryParent('cyber-security'),undefined)
 assert.equal(marketIndustryParent('other'),undefined)
 assert.equal(marketIndustryParent('cyber-security/soc'),'cyber-security')
 assert.equal(marketIndustryParent('cyber-security/detection'),'cyber-security')
 assert.equal(marketIndustryParent('cyber-security/appsec'),'cyber-security')
 assert.equal(marketIndustryParent('cyber-security/grc'),'cyber-security')
 assert.equal(marketIndustryParent('marketing/new-media'),'marketing')
 assert.equal(marketIndustryParent('media/video'),'media')
 assert.equal(marketIndustryParent('software/engineering'),'software')
 assert.equal(marketIndustryParent('software/product'),'software')
 assert.equal(marketIndustryParent('marketing/e-commerce'),'marketing')
})

test('isMarketIndustryRoot：只对一级键返回 true',()=>{
 assert.equal(isMarketIndustryRoot('general'),true)
 assert.equal(isMarketIndustryRoot('cyber-security'),true)
 assert.equal(isMarketIndustryRoot('marketing'),true)
 assert.equal(isMarketIndustryRoot('media'),true)
 assert.equal(isMarketIndustryRoot('software'),true)
 assert.equal(isMarketIndustryRoot('other'),true)
 assert.equal(isMarketIndustryRoot('cyber-security/soc'),false)
 assert.equal(isMarketIndustryRoot('cyber-security/grc'),false)
 assert.equal(isMarketIndustryRoot('software/engineering'),false)
 assert.equal(isMarketIndustryRoot('marketing/e-commerce'),false)
 assert.equal(isMarketIndustryRoot('unknown'),false)
 assert.equal(isMarketIndustryRoot(42),false)
 assert.equal(isMarketIndustryRoot(null),false)
})

test('readMarketTaxonomy：合法输入原样读出',()=>{
 const t=readMarketTaxonomy({functions:['office-docs'],industries:['general']})
 assert.deepEqual(t,{functions:['office-docs'],industries:['general']})
 // 多值合法
 const t2=readMarketTaxonomy({functions:['security','dev-tools'],industries:['cyber-security/soc','cyber-security/grc']})
 assert.deepEqual(t2,{functions:['security','dev-tools'],industries:['cyber-security/soc','cyber-security/grc']})
 const t3=readMarketTaxonomy({functions:['dev-tools'],industries:['software/engineering','software/product','marketing/e-commerce']})
 assert.deepEqual(t3,{functions:['dev-tools'],industries:['software/engineering','software/product','marketing/e-commerce']})
})

test('readMarketTaxonomy：未知功能键拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['unknown-cat'],industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy({functions:['OFFICE-DOCS'],industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：未知行业键拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:['unknown']}),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:['Security']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：functions 空数组拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:[],industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：industries 空数组拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:[]}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：functions 超过 2 个拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs','security','dev-tools'],industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：industries 超过 4 个拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:['general','cyber-security','marketing','media','software']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：functions 重复键拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs','office-docs'],industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：industries 重复键拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:['general','general']}),(e:any)=>e?.code==='teloa/invalid-input')
})

test('readMarketTaxonomy：多余属性拒绝',()=>{
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs'],industries:['general'],extra:1}),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy({functions:['office-docs']}),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy({industries:['general']}),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy(null),(e:any)=>e?.code==='teloa/invalid-input')
 assert.throws(()=>readMarketTaxonomy('string'),(e:any)=>e?.code==='teloa/invalid-input')
})
