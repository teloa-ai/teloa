import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {businessWorkText} from '../src/client/business-work-preview.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const english:Partial<Record<Parameters<TeloaTranslate>[0],string>>={
  'business.work.history.approved':'Approved by you: {note}',
  'business.work.receipt.verified':'Original action check: the target reached the expected state.',
}
const en:TeloaTranslate=(key,params)=>english[key]!.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??''))

test('旧版固定中文历史只在读取时按当前语言呈现，不覆盖原记录',()=>{
  const legacy={text:'本人批准：保留原始说明',at:'2026-09-11T02:00:00Z'}
  const before=structuredClone(legacy)
  assert.equal(businessWorkText(legacy,en),'Approved by you: 保留原始说明')
  assert.deepEqual(legacy,before)
})

test('旧版固定回执可按当前语言呈现，未知业务文本保持原文',()=>{
  assert.equal(businessWorkText({text:'查询原操作确认：目标已达到期望状态。',at:'2026-09-11T02:00:00Z'},en),'Original action check: the target reached the expected state.')
  assert.equal(businessWorkText({text:'外部系统返回：用户自定义结果',at:'2026-09-11T02:00:00Z'},en),'外部系统返回：用户自定义结果')
})

test('业务详情统一经展示函数读取新旧历史和回执',async()=>{
  const source=await readFile(new URL('../src/client/BusinessDetails.tsx',import.meta.url),'utf8')
  assert.match(source,/businessWorkText\(receipt,t\)/)
  assert.match(source,/businessWorkText\(item,t\)/)
  assert.doesNotMatch(source,/\{receipt\.text\}/)
  assert.doesNotMatch(source,/\{item\.text\}/)
})

test('业务工作预览的失败都带稳定错误 code',async()=>{
  const source=await readFile(new URL('../src/client/business-work-preview.ts',import.meta.url),'utf8')
  assert.doesNotMatch(source,/throw Error\(/)
  assert.doesNotMatch(source,/throw new Error\(/)
})
