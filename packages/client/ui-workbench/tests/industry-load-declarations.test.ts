import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {industryResourceDestinationGroups,isBusinessDeclarationPackage} from '../src/client/industry-template-presentation.ts'
import {industryResourceKinds} from '../src/client/industry-manifest.ts'
import {BUSINESS_SHARE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-share.ts'

const root=new URL('../src/client/',import.meta.url)

test('市场详情与加载确认共用同一份资源落点，并完整覆盖全部行业资源类型',async()=>{
 const covered=industryResourceDestinationGroups.flatMap(row=>[...row.kinds])
 assert.equal(new Set(covered).size,covered.length,'同一资源类型不能落到多个用户侧去处')
 assert.deepEqual([...covered].sort(),[...industryResourceKinds].sort())
 const [contents,load]=await Promise.all(['IndustryContents.tsx','IndustryLoadForm.tsx'].map(name=>readFile(new URL(name,root),'utf8')))
 assert.ok(contents)
 assert.ok(load)
 for(const source of [contents,load])assert.match(source,/industryResourceDestinationGroups/)
 assert.doesNotMatch(load,/\['market\.industry\.destination\.roles',\['role'\]\]/,'加载确认不得再维护第二份落点数组')
})

test('只含声明的模板明确其最小权限面和来源未连接后的数据边界，普通模板不触发该说明',async()=>{
 assert.equal(isBusinessDeclarationPackage([{kind:'data-source'},{kind:'object-type'},{kind:'business-view'},{kind:'business-action'}]),true)
 assert.equal(isBusinessDeclarationPackage([{kind:'role'},{kind:'object-type'}]),false)
 const load=await readFile(new URL('IndustryLoadForm.tsx',root),'utf8')
 assert.match(load,/declarationOnly&&<section className=\{css\.declarationNotice\}/)
 assert.match(load,/market\.industry\.load\.declarationPackage/)
 assert.match(load,/market\.industry\.load\.declarationSource/)
 assert.doesNotMatch(load,/MarketSourceTrust|compareIndustryUpdateCore/,'声明包不应引入新的信任维度或升级比较分支')
})

test('声明包说明词条十语言齐全并已接进核心词表',async()=>{
 const keys=['market.industry.load.declarationPackageAria','market.industry.load.declarationPackage','market.industry.load.declarationSource']
 const core=await readFile(new URL('i18n/locales/core-pages.ts',root),'utf8')
 assert.match(core,/BUSINESS_SHARE_MESSAGE_ROWS/)
 for(const key of keys){
  const row=BUSINESS_SHARE_MESSAGE_ROWS.find(value=>value[0]===key)
  assert.ok(row,key)
  assert.equal(row.length,11,key)
  assert.ok(row.every(value=>value.trim()),key)
 }
})
