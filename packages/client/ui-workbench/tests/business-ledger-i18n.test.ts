import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {BUSINESS_DEFINITION_MESSAGE_ROWS} from '../src/client/i18n/locales/business-definitions.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

// core-pages.ts 自己按 `.js` 后缀互相引用，直接从 src 加载会 ERR_MODULE_NOT_FOUND；取 tsc 产物。
const {CORE_PAGE_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/core-pages.js') as {CORE_PAGE_MESSAGE_ROWS:ReadonlyArray<readonly string[]>}

const componentUrl=new URL('../src/client/BusinessLedger.tsx',import.meta.url)

test('台账组件的固定文案全部来自十一列词表，零中文字面量',async()=>{
 const source=await readFile(componentUrl,'utf8')
 assert.match(source,/useI18n\(/)
 assert.deepEqual(chineseUiLiterals(source),[])
 for(const row of BUSINESS_DEFINITION_MESSAGE_ROWS)assert.equal(row.length,11,row[0])
})

test('十一列逐列有真实译文，不留空位也不拿中文顶替其余九种语言',()=>{
 for(const row of BUSINESS_DEFINITION_MESSAGE_ROWS){
  assert.ok(row.every(value=>value.trim()),row[0]+' 有空列')
  assert.notEqual(row[3],row[1],row[0]+' 的英文与中文逐字相同')
  assert.notEqual(row[4],row[1],row[0]+' 的日文与中文逐字相同')
 }
})

test('台账词条接进核心词表且键不与既有词条相撞',()=>{
 const keys=CORE_PAGE_MESSAGE_ROWS.map(row=>row[0])
 assert.equal(new Set(keys).size,keys.length,'核心词表出现重复键')
 for(const [key] of BUSINESS_DEFINITION_MESSAGE_ROWS)assert.ok(keys.includes(key),'未接进核心词表：'+key)
})

test('台账词表里的每个键都被组件真实引用，不留只挂了词条却没接线的键',async()=>{
 // 读取失败那几条键落在 `business-ledger-api.ts` 的 `businessLedgerFailureKey` 里（按错误码选），也算接线。
 const wired=(await Promise.all([componentUrl,new URL('../src/client/BusinessPage.tsx',import.meta.url),new URL('../src/client/business-ledger-api.ts',import.meta.url)].map(url=>readFile(url,'utf8')))).join('\n')
 for(const [key] of BUSINESS_DEFINITION_MESSAGE_ROWS)assert.ok(wired.includes("'"+key+"'"),'未接线的词条：'+key)
})

test('参数化文案的占位符与调用处逐字对齐',async()=>{
 const source=await readFile(componentUrl,'utf8')
 const rows=new Map(BUSINESS_DEFINITION_MESSAGE_ROWS.map(row=>[row[0],row]))
 for(const [key,names] of [['business.ledger.coverage',['count','at']],['business.ledger.coverage.never',['count']],['business.ledger.missingFields',['fields']],['business.ledger.rowsShown',['total','count']],['business.ledger.action.explain',['template','count']],['business.ledger.match',['field','value']]] as const){
  const row=rows.get(key)!
  for(const locale of row.slice(1))for(const name of names)assert.ok(locale.includes('{'+name+'}'),key+' 缺占位符 '+name)
  assert.match(source,new RegExp("t\\('"+key.replace(/\./g,'\\.')+"',\\{"),key+' 没有按参数调用')
 }
})

test('下钻筛选提示条两行：中文照规格、英文列无中日韩字符',()=>{
 const rows=new Map(BUSINESS_DEFINITION_MESSAGE_ROWS.map(row=>[row[0],row]))
 for(const [key,zh] of [['business.ledger.match','只看 {field} 为「{value}」的对象'],['business.ledger.matchClear','看全部']] as const){
  const row=rows.get(key)
  assert.ok(row,'缺词条：'+key)
  assert.equal(row[1],zh,key)
  assert.doesNotMatch(row[3]!,/[぀-ヿ㐀-鿿가-힯]/,key+' en')
 }
})
