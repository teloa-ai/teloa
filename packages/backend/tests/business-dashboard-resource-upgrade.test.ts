import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessConfigurationCandidateV2} from '@teloa/contract'
import {dashboardBody} from './fixtures/business-dashboard.ts'
import {mergeBusinessDashboardResourceUpgrade} from '../src/work/business-dashboard-resource-upgrade.ts'

const configuration=()=>readBusinessConfigurationCandidateV2(dashboardBody().configuration)
const title=(candidate:ReturnType<typeof configuration>,kind:string,value:string)=>{const row=candidate.definitions.find(row=>row.kind===kind)!;row.definition.title=value}
test('来源只更新未被本地修改的定义；本地业务元数据、独立页面和修改保留，输入不被写入',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 current.title='我的业务';title(current,'dashboard','本地首页');current.pages.push({...current.pages[0]!,id:'local',title:'我的告警'})
 title(candidate,'view','新版本状态');candidate.pages[0]!.title='新版告警记录'
 const snapshots=structuredClone({baseline,current,candidate}),result=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate})
 assert.deepEqual(result.conflicts,[]);assert.ok(result.configuration)
 assert.equal(result.configuration.title,'我的业务');assert.equal(result.configuration.definitions.find(row=>row.kind==='view')?.definition.title,'新版本状态')
 assert.equal(result.configuration.definitions.find(row=>row.kind==='dashboard')?.definition.title,'本地首页')
 assert.deepEqual(result.configuration.pages.map(row=>[row.id,row.title]),[['alerts','新版告警记录'],['home','总览'],['local','我的告警']])
 assert.deepEqual({baseline,current,candidate},snapshots)
})
test('双方不同修改必须逐实体裁决；没有裁决不返回可采用配置，明确保留或采用后才能闭合',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 title(current,'view','我的状态');title(candidate,'view','新的状态')
 current.pages[0]!.title='我的记录';candidate.pages[0]!.title='新的记录'
 const pending=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate})
 assert.equal(pending.configuration,null);assert.deepEqual(pending.conflicts.map(row=>row.key),['definition:view:states','page:alerts'])
 const chosen=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate,choices:{'definition:view:states':'keep-local','page:alerts':'use-incoming'}})
 assert.deepEqual(chosen.conflicts,[]);assert.ok(chosen.configuration)
 assert.equal(chosen.configuration.definitions.find(row=>row.kind==='view')?.definition.title,'我的状态');assert.equal(chosen.configuration.pages[0]!.title,'新的记录')
 for(const choices of [{'definition:view:states':'auto'},{'definition:view:missing':'keep-local'}])assert.throws(()=>mergeBusinessDashboardResourceUpgrade({baseline,current,candidate,choices}),{code:'teloa/invalid-input'})
})
test('相同修改不冲突；来源新增与本地新增按实体合并；相同标识不同新增必须裁决',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 title(current,'view','同一改动');title(candidate,'view','同一改动')
 current.pages.push({...current.pages[0]!,id:'local',title:'本地页面'});candidate.pages.push({...candidate.pages[0]!,id:'incoming',title:'新来源页面'})
 const result=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate})
 assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.configuration?.pages.map(row=>row.id),['alerts','home','local','incoming'])
 candidate.pages.push({...candidate.pages[0]!,id:'local',title:'另一来源页面'})
 assert.deepEqual(mergeBusinessDashboardResourceUpgrade({baseline,current,candidate}).conflicts.map(row=>row.key),['page:local'])
})
test('来源删除只删除未改配置实体；本地删除也保留，删除和另一方修改必须裁决',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 candidate.definitions=candidate.definitions.filter(row=>row.kind==='object-type');candidate.pages=candidate.pages.filter(row=>row.kind==='records');candidate.homePageId='alerts'
 const result=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate})
 assert.deepEqual(result.configuration?.definitions.map(row=>row.kind),['object-type']);assert.deepEqual(result.configuration?.pages.map(row=>row.id),['alerts'])
 assert.equal(result.configuration?.homePageId,'alerts')
 const locallyDeleted=configuration(),updated=configuration();locallyDeleted.pages=locallyDeleted.pages.filter(row=>row.id!=='alerts');updated.pages[0]!.title='新来源记录'
 const pending=mergeBusinessDashboardResourceUpgrade({baseline,current:locallyDeleted,candidate:updated})
 assert.equal(pending.configuration,null);assert.equal(pending.conflicts[0]?.key,'page:alerts');assert.equal(pending.conflicts[0]?.current,null)
 assert.equal(mergeBusinessDashboardResourceUpgrade({baseline,current:locallyDeleted,candidate:updated,choices:{'page:alerts':'keep-local'}}).configuration?.pages.some(row=>row.id==='alerts'),false)
 assert.equal(mergeBusinessDashboardResourceUpgrade({baseline,current:locallyDeleted,candidate:updated,choices:{'page:alerts':'use-incoming'}}).configuration?.pages.some(row=>row.id==='alerts'),true)
})
test('来源缺失不能伪造基线或候选，目标范围不同拒绝；混合后悬空引用不能冒充有效配置',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 for(const input of [{baseline:null,current,candidate},{baseline,current,candidate:undefined}])assert.throws(()=>mergeBusinessDashboardResourceUpgrade(input),{code:'teloa/source-unavailable'})
 const other=readBusinessConfigurationCandidateV2(dashboardBody('OTHER').configuration)
 assert.throws(()=>mergeBusinessDashboardResourceUpgrade({baseline,current,candidate:other}),{code:'teloa/invalid-input'})
 title(current,'dashboard','本地看板');candidate.definitions=candidate.definitions.filter(row=>row.kind==='object-type');candidate.pages=candidate.pages.filter(row=>row.kind==='records');candidate.homePageId='alerts'
 assert.throws(()=>mergeBusinessDashboardResourceUpgrade({baseline,current,candidate,choices:{'definition:dashboard:overview':'keep-local'}}),{code:'teloa/invalid-input'})
})
test('首页选择也按三方比较，双方修改不同首页须本人明确裁决',()=>{
 const baseline=configuration(),current=configuration(),candidate=configuration()
 current.homePageId='alerts';candidate.pages.push({...candidate.pages[0]!,id:'incoming',title:'新的首页'});candidate.homePageId='incoming'
 const pending=mergeBusinessDashboardResourceUpgrade({baseline,current,candidate})
 assert.equal(pending.configuration,null);assert.deepEqual(pending.conflicts.map(row=>row.key),['metadata:homePageId'])
 assert.equal(mergeBusinessDashboardResourceUpgrade({baseline,current,candidate,choices:{'metadata:homePageId':'keep-local'}}).configuration?.homePageId,'alerts')
 assert.equal(mergeBusinessDashboardResourceUpgrade({baseline,current,candidate,choices:{'metadata:homePageId':'use-incoming'}}).configuration?.homePageId,'incoming')
})
