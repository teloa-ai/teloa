import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTaskPreview, changeTaskPreview } from '../src/client/task-preview.ts'
import { changeContinuousWork, withContinuousExamples } from '../src/client/continuous-work.ts'
const now='2026-09-11T05:00:00Z'
test('任务完成与主要产物同存，重复提交保留同一引用且不覆盖结果',()=>{
  let state=changeTaskPreview(emptyTaskPreview(),{type:'create',id:'t1',title:'核对',goal:'核对来源',scope:'general',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'t1',action:'start',now})
  const command={type:'progress' as const,taskId:'t1',action:'complete' as const,result:'已核对公开资料',now}
  state=changeTaskPreview(state,command)
  assert.equal(state.artifacts.length,1);assert.equal(state.tasks[0]!.artifact?.id,state.artifacts[0]!.id)
  assert.equal(state.artifacts[0]!.versions[0]!.sections[0]!.text,'已核对公开资料')
  assert.equal(changeTaskPreview(state,command),state)
  assert.throws(()=>changeTaskPreview(state,{...command,result:'替换历史结果'}),/结果|状态/)
})
test('执行完成固定工作稿，失败执行不生成成功产物',()=>{
  let state=withContinuousExamples(emptyTaskPreview(),now)
  state=changeContinuousWork(state,{type:'enabled',planId:'plan-general-event',enabled:true,expectedRevision:1,now})
  state=changeContinuousWork(state,{type:'trigger',planId:'plan-general-event',id:'r1',occurrenceId:'o1',input:'资料 A v1',now})
  const command={type:'finish' as const,runId:'r1',expectedRevision:1,outcome:'completed' as const,result:'完成核对',output:'正文工作稿',now}
  state=changeContinuousWork(state,command)
  assert.equal(state.artifacts.length,1);assert.equal(state.continuous.runs[0]!.artifact?.version,1)
  assert.equal(state.artifacts[0]!.versions[0]!.sections[1]!.text,'正文工作稿')
  assert.equal(changeContinuousWork(state,command),state)
  state=changeContinuousWork(state,{type:'trigger',planId:'plan-general-event',id:'r2',occurrenceId:'o2',input:'资料 B',now})
  state=changeContinuousWork(state,{...command,runId:'r2',outcome:'failed',result:'读取失败',output:''})
  assert.equal(state.artifacts.length,1)
})
