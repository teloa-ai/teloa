import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {BUSINESS_CUSTOMIZATION_MESSAGE_ROWS} from '../src/client/i18n/locales/business-customization.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const {CORE_PAGE_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/core-pages.js') as {CORE_PAGE_MESSAGE_ROWS:ReadonlyArray<readonly string[]>}
const sources=await Promise.all([
 readFile(new URL('../src/client/BusinessCustomization.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/business-customization-api.ts',import.meta.url),'utf8'),
 readFile(new URL('../src/client/business-customization-presentation.ts',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8'),
])

test('会话定制面板使用十一列词表，不直接写固定中文',()=>{
 assert.deepEqual(chineseUiLiterals(sources[0]!),[])
 const keys=new Set(CORE_PAGE_MESSAGE_ROWS.map(row=>row[0]))
 for(const row of BUSINESS_CUSTOMIZATION_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(row.every(value=>value.trim()),row[0])
  assert.notEqual(row[3],row[1],row[0]+' 英文不能直接复用中文')
  assert.ok(keys.has(row[0]),'未接入核心词表：'+row[0])
  assert.ok(sources.some(source=>source.includes("'"+row[0]+"'")),'未接线：'+row[0])
 }
})
