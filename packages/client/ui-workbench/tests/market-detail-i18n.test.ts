import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {sandboxMarket,type MarketItem} from '../src/client/market-preview.ts'

test('内置市场详情提供中英文并让其他语言回退英文',async()=>{
  const presentation=await import('../src/client/market-home-presentation.ts')
  const detailCopy=Reflect.get(presentation,'localizedMarketItemDetailCopy') as undefined|((item:MarketItem,locale:string)=>MarketItem)
  assert.equal(typeof detailCopy,'function')
  for(const item of sandboxMarket().items.filter(item=>item.visibility==='public')){
    const simplified=detailCopy!(item,'zh-CN'),english=detailCopy!(item,'en'),japanese=detailCopy!(item,'ja')
    assert.deepEqual({requirements:simplified.requirements,output:simplified.output,author:simplified.author,license:simplified.license,compatibility:simplified.compatibility,components:simplified.components},{requirements:item.requirements,output:item.output,author:item.author,license:item.license,compatibility:item.compatibility,components:item.components},item.id+' zh-CN')
    assert.doesNotMatch(JSON.stringify({requirements:english.requirements,output:english.output,author:english.author,license:english.license,compatibility:english.compatibility,components:english.components}),/\p{Script=Han}/u,item.id+' en')
    assert.deepEqual(japanese,english,item.id+' ja fallback')
  }
})

test('未声明详情本地化的导入或持久化内容保持原文',async()=>{
  const presentation=await import('../src/client/market-home-presentation.ts')
  const detailCopy=Reflect.get(presentation,'localizedMarketItemDetailCopy') as (item:MarketItem,locale:string)=>MarketItem
  const imported:MarketItem={id:'imported',kind:'template',title:'用户标题',version:'1',scope:'general',visibility:'personal',summary:'用户说明',requirements:['用户输入'],output:'用户输出',author:'用户作者',license:'用户许可',source:{kind:'created'},owner:'Teloa',compatibility:'用户兼容性说明',components:[{name:'用户组件',required:true,status:'用户状态'}]}
  assert.deepEqual(detailCopy(imported,'ja'),imported)
})

test('市场详情视图不直接渲染可本地化的原始字段',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  assert.match(source,/localizedMarketItemDetailCopy\(item,locale\)/)
  for(const pattern of [/item\.requirements\.map/,/>\{item\.output\}<\//,/item\.components/,/\{item\.compatibility\}/,/>\{item\.author\}<\//,/>\{item\.license\}<\//])assert.doesNotMatch(source,pattern)
})
