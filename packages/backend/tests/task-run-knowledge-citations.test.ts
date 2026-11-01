import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {taskRunKnowledgeInput,readRunKnowledgeInput,readRunKnowledge} from '../src/work/task-run-knowledge.ts'
import {readTaskReferenceCitationPath} from '@teloa/contract'
const taskId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',text='原固定资料正文'
const rows=[{id,version:1,title:'资料',sourceId:'local_material_test',sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['general'],text}]
test('初始模型资料提供规范引用；存储快照保持原结构并可验证旧输入',()=>{
 const original=structuredClone(rows),input=taskRunKnowledgeInput(taskId,rows)
 assert.deepEqual(rows,original)
 assert.deepEqual(readRunKnowledgeInput(taskId,input.contents),readRunKnowledge(rows))
 assert.deepEqual(readRunKnowledgeInput(taskId,rows),readRunKnowledge(rows))
 assert.deepEqual(readTaskReferenceCitationPath(input.contents[0]!.citationPath),{taskId,resourceId:id,resourceVersion:1,sourceVersion:rows[0]!.sourceVersion})
 assert.match(input.notice,/citationPath/)
 assert.throws(()=>readRunKnowledgeInput(taskId,[{...input.contents[0],citationPath:input.contents[0]!.citationPath.replace('/1/','/2/')}]))
 assert.throws(()=>readRunKnowledgeInput(taskId,[{...input.contents[0],owner:'forged'}]))
 assert.throws(()=>taskRunKnowledgeInput(taskId,[{...rows[0]!,text:'已替换'}]))
})

test('真实持久Run读取器兼容原资料输入并核验新增引用身份',async()=>{
 const {readStoredTaskRun}=await import('../src/work/task-runs.ts')
 const roleId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555',nativeRequestId='66666666-6666-4666-8666-666666666666',sessionId='fixed-task-session'
 const command={requestId,taskId,expectedTaskVersion:1,roleId,expectedRoleVersion:1,sessionId,expectedLinkVersion:1}
 const input={task:{id:taskId,version:1,title:'任务',goal:'核对资料',scope:'general'},role:{id:roleId,version:1,name:'员工',duty:'核对',dataScope:'只读',executionScope:'只读'}}
 const stored={id:runId,owner_id:'owner',request_id:requestId,native_request_id:nativeRequestId,task_id:taskId,task_version:1,role_id:roleId,role_version:1,session_id:sessionId,link_version:1,state:'prepared',evidence:null,allowed_tools:[],role_skills:[],role_memory:[],role_knowledge:readRunKnowledge(rows),request_spec:command,created_at:new Date('2026-10-30T00:00:00Z')}
 for(const knowledge of [{notice:'旧资料说明',contents:rows},taskRunKnowledgeInput(taskId,rows)]){
  const inputText=JSON.stringify({...input,knowledge}),run=readStoredTaskRun({...stored,input_text:inputText})
  assert.equal(run.inputText,inputText);assert.deepEqual(run.knowledge,stored.role_knowledge)
 }
 const knowledge=taskRunKnowledgeInput(taskId,rows);knowledge.contents[0]!.citationPath=knowledge.contents[0]!.citationPath.replace('/1/','/2/')
 assert.throws(()=>readStoredTaskRun({...stored,input_text:JSON.stringify({...input,knowledge})}),{code:'teloa/storage-corrupt'})
})
