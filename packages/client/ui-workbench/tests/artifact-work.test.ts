import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTaskPreview,changeTaskPreview,withTaskExamples } from '../src/client/task-preview.ts'
import { withBusinessExamples } from '../src/client/business-work-preview.ts'
import { changeArtifactWork } from '../src/client/artifact-work.ts'
import { resolveArtifactSource } from '../src/client/artifact-source.ts'
import { sourceStamp } from '../src/client/artifact-preview.ts'
const now='2026-09-11T05:00:00Z'
const session={id:'s1',title:'本人会话',scope:'general',bindingId:'b1'},ref={kind:'session' as const,id:'s1'}
test('会话来源必须与当前绑定一致，草稿来源变化不静默保存',()=>{
  const state=emptyTaskPreview(),source=resolveArtifactSource(state,ref,session)
  const command={type:'create' as const,id:'a1',source:ref,expectedSource:sourceStamp(source),title:'工作稿',body:'本人整理的内容',now}
  assert.throws(()=>changeArtifactWork(state,command),/绑定|来源/)
  assert.throws(()=>changeArtifactWork(state,command,{...session,bindingId:'changed'}),/变化/)
  const next=changeArtifactWork(state,command,session)
  assert.equal(next.artifacts[0]!.versions[0]!.source.private,true)
})
test('已完成任务产物不能直接改写，跟进任务固定旧稿且不覆盖原结果',()=>{
  let state=changeTaskPreview(emptyTaskPreview(),{type:'create',id:'t1',title:'原任务',goal:'原目标',scope:'general',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'t1',action:'start',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'t1',action:'complete',result:'原结果',now})
  const artifact=state.artifacts[0]!,source=resolveArtifactSource(state,artifact.source)
  assert.throws(()=>changeArtifactWork(state,{type:'change',id:artifact.id,expectedSource:sourceStamp(source),change:{type:'revise',expectedVersion:1,sectionId:'result',text:'新结果',note:'改写',now}}),/跟进/)
  const next=changeArtifactWork(state,{type:'follow',id:'t2',artifact:{id:artifact.id,version:1},goal:'补充资料后修订',now})
  assert.equal(next.tasks[1]!.artifactSource?.version,1);assert.equal(next.tasks[1]!.sourceTaskId,'t1');assert.equal(next.tasks[0]!.result,'原结果')
  assert.deepEqual(next.artifacts,state.artifacts)
})
test('业务对象只关联同范围非私人稿件，保存固定版本且不复制正文',()=>{
  let state=withBusinessExamples(emptyTaskPreview(),now)
  const object=state.business.objects[0]!,objectRef={kind:'object' as const,id:object.id,scope:object.scope,objectType:object.type}
  const source=resolveArtifactSource(state,objectRef)
  state=changeArtifactWork(state,{type:'create',id:'a1',source:objectRef,expectedSource:sourceStamp(source),title:'业务稿',body:'结果',now})
  const other=state.business.objects.find(item=>item.scope!==object.scope)!
  assert.throws(()=>changeArtifactWork(state,{type:'link',artifact:{id:'a1',version:1},object:{kind:'object',id:other.id,scope:other.scope,objectType:other.type},now}),/范围/)
  state=changeArtifactWork(state,{type:'link',artifact:{id:'a1',version:1},object:objectRef,now})
  assert.equal(state.artifacts.length,1);assert.equal(state.artifacts[0]!.links[0]!.artifactVersion,1)
})

test('审批固定选定稿件版本和正文，后续修订不漂移历史审批',()=>{
  let state=withTaskExamples(emptyTaskPreview(),now)
  const ref={kind:'task' as const,id:'preview-review'},source=resolveArtifactSource(state,ref)
  state=changeArtifactWork(state,{type:'create',id:'review-draft',source:ref,expectedSource:sourceStamp(source),title:'核对说明',body:'提交的旧版正文',now})
  state=changeArtifactWork(state,{type:'review',artifact:{id:'review-draft',version:1},expectedTaskVersion:1,now})
  state=changeTaskPreview(state,{type:'submit',taskId:ref.id,id:'approval-artifact',now})
  const original=structuredClone(state.approvals.at(-1)!)
  assert.equal(original.snapshot.artifact?.version,1)
  assert.match(original.snapshot.artifactText!,/提交的旧版正文/)
  state=changeArtifactWork(state,{type:'change',id:'review-draft',expectedSource:sourceStamp(resolveArtifactSource(state,ref)),change:{type:'revise',expectedVersion:1,sectionId:'section-1',text:'新版正文',note:'继续完善',now}})
  assert.deepEqual(state.approvals.at(-1),original)
  assert.equal(state.tasks.find(item=>item.id===ref.id)!.execution,'not_started')
})
