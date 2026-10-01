import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {BUSINESS_FORM_MESSAGE_ROWS} from '../src/client/i18n/locales/business-forms.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const root=new URL('../src/client/',import.meta.url)
const files=['BusinessForms.tsx','BusinessDataSourceSummary.tsx','BusinessSpaceForm.tsx'] as const

test('业务表单与数据来源摘要不固定简体中文、服务错误或中文日期',async()=>{
  for(const file of files){
    const source=await readFile(new URL(file,root),'utf8')
    assert.match(source,/useI18n\(/,file)
    assert.deepEqual(chineseUiLiterals(source,file),[],file)
    assert.doesNotMatch(source,/error\.message|cause\.message|toLocaleString\(['"]zh-CN/,file)
  }
})

test('业务表单词典覆盖十套主语言',()=>{
  const keys=new Set<string>()
  for(const row of BUSINESS_FORM_MESSAGE_ROWS){
    assert.equal(row.length,11,row[0])
    assert.ok(!keys.has(row[0]),`duplicate ${row[0]}`)
    keys.add(row[0])
    for(const value of row.slice(1))assert.ok(value.trim(),row[0])
  }
})
