import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessDashboardResource,readBusinessConfigurationCandidateV2} from '@teloa/contract'
import {mapBusinessDashboardConfiguration} from '../src/work/business-dashboard-resource-mapping.ts'

import {portableDashboardFixture} from './fixtures/business-dashboard-resource.ts'
const target=(scope:string)=>readBusinessConfigurationCandidateV2({format:'teloa.business-configuration/v2',scope,title:'目标业务',sources:[{sourceId:'records-'+scope.replaceAll('_','-'),kind:'local-records'}],definitions:[],pages:[]})

test('同一看板在两个业务中分别使用平台记录来源，所有引用闭合且不复制源范围',()=>{
 const resource=portableDashboardFixture(),before=structuredClone(resource)
 const a=mapBusinessDashboardConfiguration(resource,target('business_one'))
 const b=mapBusinessDashboardConfiguration(resource,target('business_two'))
 assert.deepEqual(resource,before)
 for(const candidate of [a,b]){
  assert.ok(candidate.definitions.every(row=>row.definition.domain===candidate.scope))
  const object=candidate.definitions.find(row=>row.kind==='object-type')!
  assert.equal(object.kind,'object-type')
  assert.equal(object.definition.sourceId,'records-'+candidate.scope.replaceAll('_','-'))
  assert.equal(candidate.pages.length,2)
 }
 assert.notEqual(a.scope,b.scope)
 assert.deepEqual(mapBusinessDashboardConfiguration(resource,a),a,'重复准备不增加定义或页面')
})

test('追加看板保留已有对象名称、字段和自定义标题，结构不同必须拒绝覆盖',()=>{
 const resource=portableDashboardFixture(),empty=target('business_one')
 const initial=mapBusinessDashboardConfiguration(resource,empty)
 const customized=structuredClone(initial)
 const object=customized.definitions.find(row=>row.kind==='object-type')!
 object.definition.title='本人告警'
 assert.deepEqual(mapBusinessDashboardConfiguration(resource,customized),customized)
 object.definition.unit='次'
 assert.throws(()=>mapBusinessDashboardConfiguration(resource,customized),{code:'teloa/conflict'})
})

test('显式对象映射同步更新视图和记录页；未知映射键与重复目标拒绝',()=>{
 const mapped=mapBusinessDashboardConfiguration(portableDashboardFixture(),target('business_one'),{alert:'incident'})
 assert.equal(mapped.definitions.find(row=>row.kind==='object-type')?.definition.id,'incident')
 const view=mapped.definitions.find(row=>row.kind==='view')!
 assert.equal(view.definition.objectType,'incident')
 assert.ok(mapped.pages.some(page=>page.kind==='records'&&page.objectType==='incident'))
 assert.throws(()=>mapBusinessDashboardConfiguration(portableDashboardFixture(),target('business_one'),{missing:'incident'}),{code:'teloa/conflict'})
})

test('本人改过的看板布局不会被同资源重新添加覆盖，长标识也不静默折叠',()=>{
 const resource=portableDashboardFixture(),mapped=mapBusinessDashboardConfiguration(resource,target('business_one'))
 const dashboard=mapped.definitions.find(row=>row.kind==='dashboard')!
 dashboard.definition.layout[0]!.h=4
 assert.throws(()=>mapBusinessDashboardConfiguration(resource,mapped),{code:'teloa/conflict'})
 const long=structuredClone(resource)
 long.configuration.pages[0]!.id='a'.repeat(119)
 const result=mapBusinessDashboardConfiguration(long,target('business_two'))
 assert.ok(result.pages.every(page=>page.id.length<=120))
})
