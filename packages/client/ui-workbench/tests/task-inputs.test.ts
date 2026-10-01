import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTaskPreview,changeTaskPreview } from '../src/client/task-preview.ts'
import { readTaskInputs,editTaskInputs,clearTaskInputs,reviewTaskInputs,assertTaskInputsCurrent } from '../src/client/task-inputs.ts'
const now='2026-09-11T10:00:00Z'
const task=(id:string)=>changeTaskPreview(emptyTaskPreview(),{type:'create',id,title:'同名任务',goal:'核对来源',scope:'general',now}).tasks[0]!
test('同名任务的未提交输入按稳定身份隔离',()=>{
  const a=task('A'),b=task('B'),forms=editTaskInputs({},a,{result:'甲的结果',source:'甲的资料'})
  assert.equal(readTaskInputs(forms,b).fields.result,'')
  const next=editTaskInputs(forms,b,{result:'乙的结果'})
  assert.equal(readTaskInputs(next,a).fields.result,'甲的结果')
  assert.equal(readTaskInputs(next,b).fields.result,'乙的结果')
})
test('目标版本或负责身份改变不能静默沿用旧草稿',()=>{
  const a=task('A'),forms=editTaskInputs({},a,{result:'旧结论'}),next={...a,version:2,goal:'追加核对条件'}
  const edited=editTaskInputs(forms,next,{result:'继续整理旧结论'})
  assert.equal(readTaskInputs(edited,next).goal,'核对来源')
  assert.throws(()=>assertTaskInputsCurrent(readTaskInputs(edited,next),next),/复核/)
  const reviewed=reviewTaskInputs(edited,next)
  assert.doesNotThrow(()=>assertTaskInputsCurrent(readTaskInputs(reviewed,next),next))
  assert.equal(readTaskInputs(reviewed,next).fields.result,'继续整理旧结论')
  assert.throws(()=>assertTaskInputsCurrent(readTaskInputs(reviewed,next),{...next,assigneeId:'other'}),/复核/)
})
test('提交补充资料只清理该表单，不覆盖交接说明或其他任务结果',()=>{
  const a=task('A'),b=task('B')
  let forms=editTaskInputs({},a,{source:'记录 1',materialNote:'待查资料',handoffNote:'交接重点',assignee:'role-2'})
  forms=editTaskInputs(forms,b,{result:'另一任务结果'})
  forms=clearTaskInputs(forms,a.id,['source','materialNote'])
  assert.equal(readTaskInputs(forms,a).fields.source,'')
  assert.equal(readTaskInputs(forms,a).fields.handoffNote,'交接重点')
  assert.equal(readTaskInputs(forms,b).fields.result,'另一任务结果')
})
test('结束任务不能复核或提交遗留输入，内容仍可读取',()=>{
  const a=task('A'),forms=editTaskInputs({},a,{result:'尚未提交'}),closed={...a,state:'cancelled' as const}
  assert.throws(()=>reviewTaskInputs(forms,closed),/结束/)
  assert.throws(()=>assertTaskInputsCurrent(readTaskInputs(forms,closed),closed),/结束/)
  assert.equal(readTaskInputs(forms,closed).fields.result,'尚未提交')
})
