import test from 'node:test'
import assert from 'node:assert/strict'
import {describeSavedPlanSource} from '../src/client/plan-source-presentation.ts'
const copy:Record<string,string>={
 'p6.planSource.manual.label':'手动创建',
 'p6.planSource.manual.summary':'由本人创建，未关联市场模板。',
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
