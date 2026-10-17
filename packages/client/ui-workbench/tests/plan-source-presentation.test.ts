import test from 'node:test'
import assert from 'node:assert/strict'
import {describeSavedPlanSource} from '../src/client/plan-source-presentation.ts'
const copy:Record<string,string>={
 'p6.planSource.manual.label':'手动创建',
 'p6.planSource.manual.summary':'由本人创建，未关联市场模板。',
 'p6.planSource.conversation.label':'会话中创建',
 'p6.planSource.conversation.summary':'来自原会话中的工作安排。',
 'p6.planSource.market.label':'市场模板',
 'p6.planSource.market.summary':'基于已保存的市场固定内容创建。',
 'autoDream.name':'Auto Dream',
 'dailyLog.timeHint':'每天这个时刻生成，默认 23:30（新加坡时间）。',
}
const t=(key:string)=>copy[key]??key

test('已保存的手工计划明确说明未关联市场模板',()=>{
 assert.deepEqual(describeSavedPlanSource({kind:'manual'},t),{
  kind:'manual',
  label:'手动创建',
  summary:'由本人创建，未关联市场模板。',
 })
})

test('会话创建计划沿持久来源区分原会话，不能误标手动创建或推测当前会话',()=>{
 assert.deepEqual(describeSavedPlanSource({kind:'manual',sessionId:'original-session'},t),{
  kind:'conversation',label:'会话中创建',summary:'来自原会话中的工作安排。',sessionId:'original-session',
 })
})

test('系统计划来源标注为 Auto Dream，不误导为手动或市场模板',()=>{
 const source={kind:'system-digest' as const,roleId:'22222222-2222-4222-8222-222222222222'}
 assert.deepEqual(describeSavedPlanSource(source,t),{
  kind:'system-digest',
  label:'Auto Dream',
  summary:'每天这个时刻生成，默认 23:30（新加坡时间）。',
 })
})

test('市场计划只展示持久来源中的固定内容与资源身份，不推测模板名称',()=>{
 const source={kind:'market-content' as const,contentId:'44444444-4444-4444-8444-444444444444',contentHash:'a'.repeat(64),resourceId:'daily-review',resourceVersion:'2.3.0'}
 assert.deepEqual(describeSavedPlanSource(source,t),{
  kind:'market-content',
  label:'市场模板',
  summary:'基于已保存的市场固定内容创建。',
  contentId:source.contentId,
  contentHash:source.contentHash,
  resourceId:'daily-review',
  resourceVersion:'2.3.0',
 })
})

test('成果方法来源保留固定成果版本，不误标为市场或手动计划',()=>{
 const source={kind:'method-reuse' as const,artifactId:'22222222-2222-4222-8222-222222222222',version:2,basisHash:'b'.repeat(64),taskId:'33333333-3333-4333-8333-333333333333'}
 assert.deepEqual(describeSavedPlanSource(source,t),{kind:'method-reuse',label:'p6.planSource.method.label',summary:'p6.planSource.method.summary',artifactId:source.artifactId,version:2,basisHash:source.basisHash})
})
