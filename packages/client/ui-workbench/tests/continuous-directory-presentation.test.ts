import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {continuousDirectoryMode, continuousModeLabel, visiblePreviewPlans} from '../src/client/continuous-directory-presentation.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

const zh=((key:string)=>({'presentation.continuous.mode.sandbox':'界面沙盒 · 数据不会写入计划或执行服务','presentation.continuous.mode.saved':'已保存计划与真实执行'}[key]??key)) as TeloaTranslate
const en=((key:string)=>({'presentation.continuous.mode.sandbox':'Interface sandbox · Data is not written to plan or execution services','presentation.continuous.mode.saved':'Saved plans and real runs'}[key]??key)) as TeloaTranslate

const plans=[{id:'saved-a'},{id:'example-a'},{id:'saved-b'}]

test('正式持续工作目录只选择真实已保存计划',()=>{
  assert.equal(continuousDirectoryMode(true),'saved')
  assert.deepEqual(visiblePreviewPlans(plans,new Set(['saved-a','saved-b']),'saved').map(plan=>plan.id),['saved-a','saved-b'])
})

test('沙盒只选择页面示例并与真实计划隔离',()=>{
  assert.deepEqual(visiblePreviewPlans(plans,new Set(['saved-a','saved-b']),'sandbox').map(plan=>plan.id),['example-a'])
  assert.equal(continuousModeLabel(zh,'sandbox'),'界面沙盒 · 数据不会写入计划或执行服务')
  assert.equal(continuousModeLabel(en,'sandbox'),'Interface sandbox · Data is not written to plan or execution services')
})

test('没有真实计划服务时整个持续工作视图明确进入沙盒',()=>{
  assert.equal(continuousDirectoryMode(false),'sandbox')
  assert.equal(continuousModeLabel(en,'saved'),'Saved plans and real runs')
})

test('已保存计划只呈现当前可用操作，不展示永久禁用的编辑、交接和手动触发按钮',async()=>{
  const source=await readFile(new URL('../src/client/ContinuousPage.tsx',import.meta.url),'utf8')
  assert.doesNotMatch(source,/disabled=\{persisted/)
  assert.doesNotMatch(source,/continuous\.detail\.handoff\.saveUnavailable/)
  assert.doesNotMatch(source,/continuous\.detail\.triggerUnavailable/)
  assert.doesNotMatch(source,/<option value="event" disabled=\{persistent\}>/)
})
