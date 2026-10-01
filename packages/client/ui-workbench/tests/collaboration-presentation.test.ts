import test from 'node:test'
import assert from 'node:assert/strict'
import { groupAccessModel, groupMemberSummary } from '../src/client/collaboration-presentation.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const translator=(values:Readonly<Record<string,string>>):TeloaTranslate=>(key,params)=>{
  const template=values[key]??key
  return template.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??`{${name}}`))
}
const zh=translator({
  'presentation.collaboration.members':'{count} 位成员',
  'presentation.collaboration.membersWithOneSaved':'{count} 位成员 · {saved} 个已保存岗位',
  'presentation.collaboration.membersWithSaved':'{count} 位成员 · {saved} 个已保存岗位',
  'collaboration.access.members.title':'成员身份','collaboration.access.members.description':'决定谁参与讨论、以什么身份出现。加入群只建立协作关系，不等于获得资料或工具权限。',
  'collaboration.access.resources.title':'群可引用资料','collaboration.access.resources.description':'群消息可以引用群内固定版本资料；引用保留来源与版本，但 Agent 不会自动读取全部群资料。',
  'collaboration.access.capabilities.title':'群默认能力','collaboration.access.capabilities.description':'为本群提供常用方法与连接入口；没有现成 Skill 时，Agent 仍可在既有权限内自主解决。',
  'collaboration.access.permissions.title':'实际权限','collaboration.access.permissions.description':'每次使用仍按AI 员工授权、连接授权与任务风险共同核验。',
})
const en=translator({'presentation.collaboration.members':'{count} members','presentation.collaboration.membersWithOneSaved':'{count} members · {saved} saved role','presentation.collaboration.membersWithSaved':'{count} members · {saved} saved roles','collaboration.access.members.title':'Member identity','collaboration.access.resources.title':'Group reference materials','collaboration.access.capabilities.title':'Default group capabilities','collaboration.access.permissions.title':'Actual permissions'})

const roles=[
  {id:'saved-role',storage:'persistent' as const},
  {id:'example-role'},
]

test('群成员摘要只统计当前群内已保存岗位，不把全部成员称为示例',()=>{
  assert.equal(groupMemberSummary(zh,['self','saved-role','example-role'],roles),'3 位成员 · 1 个已保存岗位')
  assert.equal(groupMemberSummary(en,['self','example-role'],roles),'2 members')
  assert.equal(groupMemberSummary(en,['self','saved-role'],roles),'2 members · 1 saved role')
})



test('群上下文把成员、资料、默认能力和实际权限分开解释',()=>{
  const model=groupAccessModel(zh)
  assert.deepEqual(model.map(item=>item.title),['成员身份','群可引用资料','群默认能力','实际权限'])
  assert.match(model[0]!.description,/加入群.*不等于获得资料或工具权限/)
  assert.match(model[1]!.description,/固定版本.*不会自动读取/)
  assert.match(model[2]!.description,/常用方法.*没有现成 Skill.*自主解决/)
  assert.match(model[3]!.description,/AI 员工授权.*连接授权.*任务风险/)
  assert.deepEqual(groupAccessModel(en).map(item=>item.title),['Member identity','Group reference materials','Default group capabilities','Actual permissions'])
})
