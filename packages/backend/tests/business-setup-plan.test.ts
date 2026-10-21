import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'

import * as api from '../src/work/business-setup-plan-selection.ts'
import {readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidateV2} from '@teloa/contract'
const config=(fields:unknown[])=>readBusinessConfigurationCandidateV2({format:'teloa.business-configuration/v2',scope:'support',title:'客户支持',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v2',id:'ticket',version:'1.0.0',domain:'support',title:'工单',unit:'条',lead:'跟进工单',sourceId:'records',fields}}],pages:[{id:'tickets',title:'工单',kind:'records',objectType:'ticket',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'tickets'})
const name={name:'name',label:'名称',from:'名称',type:'text',required:true}
const date={name:'date',label:'上线日期',from:'上线日期',type:'datetime',required:false}
test('整体方案复用配置修订、预览与采用的同一数据库事务入口',()=>{
 assert.equal(typeof BusinessConfigurationService.prototype.applyInTransaction,'function')
 assert.equal(typeof BusinessConfigurationDraftService.prototype.reviseInTransaction,'function')
 assert.equal(typeof BusinessConfigurationPreviewService.prototype.previewInTransaction,'function')
})
test('逐字段拒绝保留原定义，其余字段可单独采用',()=>{
 assert.equal(typeof api.businessSetupConfigurationChanges,'function','完整方案必须提供真实字段差异')
 const before=config([name]),after=config([name,date]),changes=api.businessSetupConfigurationChanges(before,after)
 const added=changes.find(row=>row.label.includes('上线日期'))
 assert.ok(added)
 const selected=api.selectBusinessSetupConfiguration(before,after,[added.id])
 assert.deepEqual((selected.definitions[0]!.definition as {fields:unknown[]}).fields,[name])
 assert.deepEqual(api.selectBusinessSetupConfiguration(before,after,[]),after)
})
test('拒绝被页面引用的新增定义时必须重新验证完整候选',()=>{
 assert.equal(typeof api.selectBusinessSetupConfiguration,'function')
 const before:BusinessConfigurationCandidateV2={...config([name]),definitions:[],pages:[]};delete before.homePageId
 const after=config([name])
 const change=api.businessSetupConfigurationChanges(before,after).find(row=>row.entity==='definition')
 assert.throws(()=>api.selectBusinessSetupConfiguration(before,after,[change!.id]),{code:'teloa/invalid-input'})
})

test('拒绝页面内容改动保持原位置；纯排序具有独立差异，可采纳或恢复',()=>{
 const before=config([name]);before.pages.push({...before.pages[0]!,id:'follow-up',title:'跟进'})
 const changed=structuredClone(before);changed.pages[0]!.title='新工单标题'
 const content=api.businessSetupConfigurationChanges(before,changed).find(c=>c.id==='page:tickets')!
 assert.deepEqual(api.selectBusinessSetupConfiguration(before,changed,[content.id]).pages.map(p=>p.id),['tickets','follow-up'])
 const reordered=structuredClone(before);reordered.pages.reverse()
 const order=api.businessSetupConfigurationChanges(before,reordered).find(c=>c.id==='business:page-order')
 assert.ok(order,'纯页面排序也必须是可审阅的独立变更')
 assert.deepEqual(api.selectBusinessSetupConfiguration(before,reordered,[]).pages.map(p=>p.id),['follow-up','tickets'])
 assert.deepEqual(api.selectBusinessSetupConfiguration(before,reordered,[order.id]).pages.map(p=>p.id),['tickets','follow-up'])
})
