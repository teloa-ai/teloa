import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS} from '../src/client/i18n/locales/team-capability-catalog.ts'
import {INDUSTRY_COMPOSITION_MESSAGE_ROWS} from '../src/client/i18n/locales/industry-composition.ts'
import {BUSINESS_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-page.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const page=await readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8')

test('团队能力目录固定界面文案全部通过 i18n',()=>{
 assert.match(page,/useI18n\(\)/)
 assert.deepEqual(chineseUiLiterals(page,'TeamCapabilitiesPage.tsx'),[])
})

test('团队能力正式目录不把内存配置方案作为并列一级页签',()=>{
 assert.doesNotMatch(page,/t\('teamCapability\.navigation\.bindings'\)/)
 assert.match(page,/props\.mode==='bindings'[\s\S]+<UnavailableBindings/)
 assert.doesNotMatch(page,/\bCapabilityBindings\b/)
 assert.match(page,/props\.catalog/)
})

test('行业资源说明不再拼空间名前缀：个人版空间名恒为「我的工作空间」，拼进去对每条资源都一样，且不该在技能页出现「工作空间」字样',()=>{
 const detail=TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS.find(row=>row[0]==='teamCapability.industry.detail')
 assert.deepEqual(detail?.slice(1),Array(10).fill('{requirement}'))
 assert.doesNotMatch(page,/row\.industry\.spaceName/)
 assert.doesNotMatch(page,/工作空间/)
})

test('团队能力目录语义键提供严格十语且键唯一',()=>{
 assert.ok(TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS.length>=40)
 assert.equal(new Set(TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS.map(row=>row[0])).size,TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS.length)
 for(const row of TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  for(const value of row.slice(1))assert.ok(value.trim().length>0,row[0])
 }
 const title=TEAM_CAPABILITY_CATALOG_MESSAGE_ROWS.find(row=>row[0]==='teamCapability.title')
 assert.deepEqual(title?.slice(1),['能力','能力','Capabilities','ケイパビリティ','역량','Năng lực','Capacidades','Capacités','Leistungen','Capacidades'])
})

test('composition.action.configure 与 business.composition.configure 十一列逐字相同',()=>{
 const shared=INDUSTRY_COMPOSITION_MESSAGE_ROWS.find(row=>row[0]==='composition.action.configure')
 const business=BUSINESS_PAGE_MESSAGE_ROWS.find(row=>row[0]==='business.composition.configure')
 assert.deepEqual(shared?.slice(1),business?.slice(1))
})
