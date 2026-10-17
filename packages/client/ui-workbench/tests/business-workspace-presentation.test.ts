import test from 'node:test'
import assert from 'node:assert/strict'
import {businessWorkspaceProjection,businessWorkspaceGroups} from '../src/client/business-workspace-presentation.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {AttentionItem} from '../src/client/attention-item.ts'
import type {Group} from '@teloa/contract'

test('总览只汇总当前业务的保存对象；取消项不作为完成，例子不混进待办',()=>{
 const task=(id:string,scope:string,state:string,storage='persistent')=>({id,scope,state,storage,updatedAt:'2026-10-11T01:00:00.000Z',assigneeId:'employee'}) as PreviewTask
 const role=(id:string,scopes:string[],state:string)=>({id,scopes,state,storage:'persistent',kind:'employee'}) as PreviewRole
 const attention=(id:string,scope:string,persistence:string)=>({id,scope,persistence,occurredAt:'2026-10-11T01:00:00.000Z'}) as AttentionItem
 const result=businessWorkspaceProjection('sales',[task('one','sales','running'),task('two','sales','completed'),task('cancel','sales','cancelled'),task('other','SOC','running'),task('example','sales','running','example')],[role('employee',['sales'],'active'),role('other',['SOC'],'active'),role('retired',['sales'],'retired')],[attention('need','sales','saved'),attention('sample','sales','example'),attention('other','SOC','saved')])
 assert.deepEqual(result.current.map(row=>row.id),['one'])
 assert.deepEqual(result.completed.map(row=>row.id),['two'])
 assert.deepEqual(result.roles.map(row=>row.id),['employee'])
 assert.deepEqual(result.attention.map(row=>row.id),['need'])
 assert.deepEqual(businessWorkspaceGroups([{id:'own',scope:'sales',archived:false},{id:'other',scope:'SOC',archived:false},{id:'old',scope:'sales',archived:true}] as Group[],'sales').map(row=>row.id),['own'])
})

test('通用协作沿岗位支持范围契约接纳所有已保存员工，具体业务仍精确过滤',()=>{
 const roles=[{id:'sales',kind:'employee',storage:'persistent',state:'active',scopes:['sales']},{id:'SOC',kind:'employee',storage:'persistent',state:'paused',scopes:['SOC']},{id:'twin',kind:'twin',storage:'persistent',state:'active',scopes:['general']},{id:'example',kind:'employee',storage:'example',state:'active',scopes:['general']},{id:'retired',kind:'employee',storage:'persistent',state:'retired',scopes:['sales']}] as PreviewRole[]
 assert.deepEqual(businessWorkspaceProjection('general',[],roles,[]).roles.map(role=>role.id),['sales','SOC'])
 assert.deepEqual(businessWorkspaceProjection('sales',[],roles,[]).roles.map(role=>role.id),['sales'])
})
