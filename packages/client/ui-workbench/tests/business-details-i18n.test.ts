import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {BUSINESS_DETAILS_MESSAGE_ROWS} from '../src/client/i18n/locales/business-details.ts'

const url=new URL('../src/client/BusinessDetails.tsx',import.meta.url)

test('业务对象、分析和执行详情的固定文案全部来自词典',async()=>{
  const source=await readFile(url,'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'BusinessDetails.tsx'),[])
  assert.match(source,/scope:op\.policy\.scope/)
  assert.match(source,/source:op\.policy\.source/)
  for(const value of ['object.title','object.summary','field.label','field.value','run.title','run.result','run.method','op.title','op.goal','op.parameters','op.risk','op.policy.criterion'])assert.match(source,new RegExp(`\\{${value.replaceAll('.','\\.')}\\}`),value)
  assert.match(source,/businessWorkText\(receipt,t\)/)
  assert.match(source,/businessWorkText\(item,t\)/)
})

test('业务详情词典提供顺序固定的十语人工翻译',()=>{
  const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const
  const keys=new Set<string>()
  for(const row of BUSINESS_DETAILS_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    assert.ok(!keys.has(row[0]),`duplicate ${row[0]}`);keys.add(row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]!.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(BUSINESS_DETAILS_MESSAGE_ROWS.find(row=>row[0]==='business.operation.progress.verify'),['business.operation.progress.verify','效果核验','效果核驗','Verify effects','効果確認','효과 확인','Xác minh hiệu quả','Verificar efectos','Vérifier les effets','Wirkung prüfen','Verificar efeitos'])
})
