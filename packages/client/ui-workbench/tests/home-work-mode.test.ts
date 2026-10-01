import assert from 'node:assert/strict'
import test from 'node:test'
import {homeConversationPrompt,homeTaskDraft,homeTaskScope} from '../src/client/home-work-mode.ts'

const scopeNames={general:'通用工作',SOC:'安全运营',AppSec:'应用安全',Design:'设计','space-finance':'财务'} as const

test('首页工作模式把用户范围映射为真实任务范围并生成可编辑标题',()=>{
  assert.deepEqual(homeTaskDraft('  调查支付告警\n核对来源和影响  ','SOC',scopeNames),{title:'调查支付告警',goal:'调查支付告警\n核对来源和影响',scope:'SOC'})
  assert.deepEqual(homeTaskDraft('整理会议行动项','general',scopeNames),{title:'整理会议行动项',goal:'整理会议行动项',scope:'general'})
  assert.deepEqual(homeTaskDraft('核对月结数据','space-finance',scopeNames),{title:'核对月结数据',goal:'核对月结数据',scope:'space-finance'})
})

test('首页工作模式限制自动标题长度且拒绝未知范围',()=>{
  assert.equal(homeTaskDraft('甲'.repeat(140),'Design',scopeNames).title.length,60)
  assert.equal(homeTaskScope('AppSec',scopeNames),'AppSec')
  assert.throws(()=>homeTaskDraft('处理工作','space-unknown',scopeNames),/工作范围/)
  assert.throws(()=>homeTaskScope('space-unknown',scopeNames),/工作范围/)
})

test('首页普通会话只注入业务上下文，不把它描述成授权范围',()=>{
  assert.equal(homeConversationPrompt('整理会议行动项','general',scopeNames),'整理会议行动项')
  assert.equal(homeConversationPrompt('核对月结数据','space-finance',scopeNames),'业务上下文：财务（space-finance）\n资料和工具仍按当前会话重新核验。\n\n核对月结数据')
  assert.throws(()=>homeConversationPrompt('处理工作','space-unknown',scopeNames),/工作范围/)
})
