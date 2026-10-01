import assert from 'node:assert/strict'
import test from 'node:test'
import {ROSTER_OTHER_SECTION, rosterHasMultiScope, rosterSections, rosterTotal} from '../src/client/team-roster-grouping.ts'
import type {BusinessScopeLabel} from '../src/client/business-directory.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'

const labels:BusinessScopeLabel[]=[
  {scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0},
  {scope:'SOC',title:'安全运营',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0},
]

const role=(id:string,scopes:string[]):PreviewRole=>({id,name:id,kind:'employee',scopes:scopes as PreviewRole['scopes'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]})

test('分区集合与顺序跟 labels 的顺序一致',()=>{
  const roles=[role('a',['general']),role('b',['SOC'])]
  const sections=rosterSections(roles,labels,'其他')
  assert.deepEqual(sections.map(section=>section.id),['general','SOC'])
})

test('跨两个范围的岗位在两个分区各出现一次',()=>{
  const roles=[role('a',['general','SOC'])]
  const sections=rosterSections(roles,labels,'其他')
  assert.deepEqual(sections.map(section=>section.id),['general','SOC'])
  assert.deepEqual(sections[0]!.members.map(member=>member.id),['a'])
  assert.deepEqual(sections[1]!.members.map(member=>member.id),['a'])
})

test('未登记范围与空 scopes 都进「其他」分区且排最后',()=>{
  const roles=[role('a',['general']),role('b',['Design']),role('c',[])]
  const sections=rosterSections(roles,labels,'其他')
  assert.deepEqual(sections.map(section=>section.id),['general',ROSTER_OTHER_SECTION])
  const other=sections.at(-1)!
  assert.equal(other.title,'其他')
  assert.equal(other.kind,'other')
  assert.deepEqual(other.members.map(member=>member.id).sort(),['b','c'])
})

test('成员为空的分区不出现在返回值里',()=>{
  const roles=[role('a',['general'])]
  const sections=rosterSections(roles,labels,'其他')
  assert.deepEqual(sections.map(section=>section.id),['general'])
})

test('rosterTotal 对跨范围岗位只数一次',()=>{
  const roles=[role('a',['general','SOC']),role('b',['general'])]
  assert.equal(rosterTotal(roles),2)
})

test('rosterHasMultiScope 只在真的跨两个以上分区时为 true',()=>{
  assert.equal(rosterHasMultiScope([role('a',['general','SOC'])],labels),true)
  assert.equal(rosterHasMultiScope([role('a',['general'])],labels),false)
  // 未登记范围 + 已登记范围也算跨了两个分区（其一进「其他」）。
  assert.equal(rosterHasMultiScope([role('a',['general','Design'])],labels),true)
  assert.equal(rosterHasMultiScope([role('a',[])],labels),false)
})
