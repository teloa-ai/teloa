import assert from 'node:assert/strict'
import test from 'node:test'
import {homeWorkAssigneeOptions,resolveHomeWorkAssignee} from '../src/client/home-work-assignee.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'

const role=(patch:Partial<PreviewRole>):PreviewRole=>({
  id:'11111111-1111-4111-8111-111111111111',name:'调查岗',kind:'employee',scopes:['SOC'],state:'active',version:3,
  duty:'调查',dataScope:'告警',executionScope:'只读',skills:[],knowledge:[],memories:[],history:[],storage:'persistent',...patch,
})

test('首页工作负责人只列出已保存且在岗的数字员工',()=>{
  const example=role({id:'22222222-2222-4222-8222-222222222222',name:'页面示例'})
  delete example.storage
  const rows=homeWorkAssigneeOptions([
    role({}),
    example,
    role({id:'33333333-3333-4333-8333-333333333333',name:'暂停岗位',state:'paused'}),
    role({id:'44444444-4444-4444-8444-444444444444',name:'我的分身',kind:'twin'}),
  ])
  assert.deepEqual(rows,[{id:'11111111-1111-4111-8111-111111111111',name:'调查岗',version:3,scopes:['SOC']}])
})

test('首页工作负责人必须匹配核对后的业务范围和岗位版本',()=>{
  const options=homeWorkAssigneeOptions([role({})])
  assert.equal(resolveHomeWorkAssignee(options,'self','SOC'),undefined)
  assert.deepEqual(resolveHomeWorkAssignee(options,'11111111-1111-4111-8111-111111111111','SOC'),{
    roleId:'11111111-1111-4111-8111-111111111111',expectedVersion:3,
  })
  assert.throws(()=>resolveHomeWorkAssignee(options,'11111111-1111-4111-8111-111111111111','Design'),/当前业务/)
  assert.throws(()=>resolveHomeWorkAssignee(options,'missing','SOC'),/负责人/)
})

// 2026-09-21 用户裁定：与契约 roleSupportsScope 同口径——通用工作（general）对所有在岗正式同事开放，业务范围仍严格按岗位声明过滤。
test('首页工作负责人在通用工作范围下不按岗位业务声明过滤',()=>{
  const options=homeWorkAssigneeOptions([role({})]) // scopes:['SOC']
  assert.deepEqual(resolveHomeWorkAssignee(options,'11111111-1111-4111-8111-111111111111','general'),{
    roleId:'11111111-1111-4111-8111-111111111111',expectedVersion:3,
  })
})
