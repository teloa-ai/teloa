import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {attentionPersistenceKey,attentionSourceKey,type AttentionItem} from '../src/client/attention-item.ts'
import {currentAttentionKinds,visibleCurrentAttentionDirectory} from '../src/client/example-directory-presentation.ts'

const item=(patch:Partial<AttentionItem>):AttentionItem=>({id:'task:1',kind:'review',source:'task',persistence:'saved',target:{kind:'task',id:'1'},title:'季度复核',reason:{kind:'text',text:'执行完成，需要核对结果'},scope:'general',occurredAt:'2026-09-13T08:00:00.000Z',...patch})

test('需要你只保留真实待处理事项，并从当前事项动态生成类型页签',()=>{
  const items=[
    item({id:'task:1',kind:'approval'}),
    item({id:'business:1',kind:'error',source:'business',target:{kind:'business',target:{scope:'SOC',section:'analysis',id:'run-1'}},title:'资产关联失败',reason:{kind:'text',text:'连接不可用'},scope:'SOC'}),
    item({id:'example:1',kind:'review',persistence:'example'}),
  ]
  const current=visibleCurrentAttentionDirectory(items)
  assert.deepEqual(current.map(row=>row.id),['task:1','business:1'])
  assert.deepEqual(currentAttentionKinds(current),['approval','error'])
})

test('目录为每条界面示例提供明确且可国际化的边界标签',()=>{
  assert.equal(attentionPersistenceKey('example'),'attention.persistence.example')
  assert.equal(attentionPersistenceKey('saved'),undefined)
  assert.equal(attentionPersistenceKey('local-recovery'),undefined)
})

test('统一来源枚举为目录提供十语言 message key',()=>{
  assert.deepEqual((['task','handoff','business','plan','binding','installation','local-recovery','server-recovery'] as const).map(attentionSourceKey),[
    'attention.source.task','attention.source.handoff','attention.source.business','attention.source.plan','attention.source.binding','attention.source.installation','attention.source.localRecovery','attention.source.serverRecovery',
  ])
})

test('需要你入口会读取所有正式来源，并在任务、外部动作、交接和计划目录均确认后才宣告完整',()=>{
  const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
  assert.ok(frame.includes("if(['home','team','plans','attention','spaces'].includes(state.view))void loadSavedPlans()"))
  assert.ok(frame.includes("known:taskAttentionKnown&&!taskLoadError&&securityAttentionKnown&&handoffsKnown&&!handoffError&&savedPlanDirectory==='ready'"))
  // 会话页带着会话对象详情时也要装载：右栏页签的正文就是整张任务页，它要凭这份台账才敢说「已核对」。
  assert.ok(frame.includes("if(['home','tasks','attention'].includes(state.view)||conversationLedger)void loadSecurityAttention().catch"))
  assert.doesNotMatch(frame,/installations:\[\]/)
})
