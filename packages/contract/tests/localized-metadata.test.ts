import test from 'node:test'
import assert from 'node:assert/strict'
import {localizedMetadata,resolveLocalizedMetadata} from '../src/localized-metadata.ts'

const metadata=()=>({original:'稳定原文',defaultLocale:'en',locales:{'de-DE':'Deutsch',pt:'Português',en:'English','zh-Hant':'繁體中文','zh-TW':{fallback:'zh-Hant'}}})

test('按精确 locale、同语言默认、defaultLocale、稳定原文顺序解析并返回实际命中 locale',()=>{
 assert.deepEqual(resolveLocalizedMetadata(metadata(),'de-DE'),{value:'Deutsch',locale:'de-DE'})
 assert.deepEqual(resolveLocalizedMetadata(metadata(),'pt-BR'),{value:'Português',locale:'pt'})
 assert.deepEqual(resolveLocalizedMetadata(metadata(),'ja-JP'),{value:'English',locale:'en'})
 assert.deepEqual(resolveLocalizedMetadata({...metadata(),defaultLocale:'fr',locales:{fr:{fallback:'es'},es:{fallback:'zh-Hant'},'zh-Hant':'繁體中文'}},'ko'),{value:'繁體中文',locale:'zh-Hant'})
 assert.deepEqual(resolveLocalizedMetadata({original:'稳定原文',defaultLocale:'en',locales:{}},'fr'),{value:'稳定原文',locale:null})
})

test('精确地区 fallback 保留最终实际命中的 locale',()=>{
 assert.deepEqual(resolveLocalizedMetadata(metadata(),'zh-TW'),{value:'繁體中文',locale:'zh-Hant'})
})

test('规范化 locale map 且拒绝非法 locale、空值、重复规范键、未知 fallback 与环',()=>{
 assert.deepEqual(localizedMetadata({original:'Original',defaultLocale:'EN-us',locales:{'en-US':'English'}}),{original:'Original',defaultLocale:'en-US',locales:{'en-US':'English'}})
 for(const invalid of [
  {original:'',defaultLocale:'en',locales:{en:'English'}},
  {original:'Original',defaultLocale:'bad_locale',locales:{}},
  {original:'Original',defaultLocale:'en',locales:{en:'  '}},
  {original:'Original',defaultLocale:'en',locales:{'en-US':'A','en-us':'B'}},
  {original:'Original',defaultLocale:'en',locales:{en:{fallback:'fr'}}},
  {original:'Original',defaultLocale:'en',locales:{en:{fallback:'fr'},fr:{fallback:'en'}}},
 ])assert.throws(()=>localizedMetadata(invalid),/本地化|locale|fallback|原文/)
})

test('locale map 使用稳定 code-unit 排序而不调用宿主 localeCompare',()=>{
 const original=String.prototype.localeCompare
 String.prototype.localeCompare=function(){throw Error('不应依赖宿主 locale 排序')}
 try{
  const result=localizedMetadata({original:'Original',defaultLocale:'en',locales:{'zh-Hant':'繁體',en:'English',de:'Deutsch'}})
  assert.deepEqual(Object.keys(result.locales),['de','en','zh-Hant'])
 }finally{String.prototype.localeCompare=original}
})
