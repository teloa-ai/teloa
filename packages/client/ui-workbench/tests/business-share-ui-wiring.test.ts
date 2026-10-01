import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const root=new URL('../src/client/',import.meta.url)
const source=(name:string)=>readFile(new URL(name,root),'utf8')

test('业务范围页只经 WorkbenchFrame 装配分享 API，并把入口传给范围台账',async()=>{
 const [page,frame,form]=await Promise.all([source('BusinessPage.tsx'),source('WorkbenchFrame.tsx'),source('BusinessShareForm.tsx')])
 assert.match(page,/import \{BusinessShareForm\} from '\.\/BusinessShareForm\.js'/)
 assert.match(page,/<BusinessShareForm scope=\{target\.scope\} api=\{businessShareApi\} openMarket=\{market\}/)
 assert.match(frame,/createBusinessShareApi\(createBusinessShareSource\(/)
 assert.match(frame,/businessShareApi=\{businessShareApi\}/)
 assert.match(form,/api\.plan\(input\)/)
 assert.match(form,/api\.download\(item\)/)
 assert.match(form,/api\.fix\(item\)/)
})

test('分享表单所有用户可见决策都走词典，并复用市场的声明摘要组件',async()=>{
 const [form,locale,summary]=await Promise.all([source('BusinessShareForm.tsx'),source('i18n/locales/business-share.ts'),source('IndustryContents.tsx')])
 for(const key of ['business.share.title','business.share.empty','business.share.safe','business.share.localOnly','business.share.englishFallback','business.share.download','business.share.fix','business.share.openMarket'])assert.match(locale,new RegExp("'"+key+"'"))
 assert.match(form,/setNotice\(t\('business\.share\.fixed'\)\)/)
 assert.match(form,/notice===t\('business\.share\.fixed'\).*openMarket/)
 assert.match(form,/BusinessDeclaration definition=\{row\.definition!/)
 assert.match(summary,/export function BusinessDeclaration/)
 assert.doesNotMatch(form,/dangerouslySetInnerHTML/)
})
