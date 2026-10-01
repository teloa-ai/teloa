import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskApi} from '../src/client/task-api.ts'
import {taskAttentionDescription} from '../src/client/task-attention-presentation.ts'
const fields={title:'调查任务',goal:'核对现有证据',scope:'general',groupId:null,skills:[]},id='12345678-1234-4234-8234-123456789012',at='2026-09-11T00:00:00Z'
const row={...fields,id,ownerId:'owner',version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:at,updatedAt:at}
test('交办固定岗位版本，刷新后可恢复原请求且不能改派为本人',async()=>{
 let raw:string|null=null;const requests:unknown[]=[],assignee={roleId:id,expectedVersion:2},journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 await assert.rejects(createTaskApi(async(_m,p)=>{requests.push(p);throw Error('断线')},journal).create(fields,assignee),/断线/)
 const api=createTaskApi(async(method,p)=>{requests.push(p);return {...row,assigneeRoleId:id,assigneeRoleVersion:2}},journal)
 assert.deepEqual(api.pendingAssignee(),assignee)
 await assert.rejects(api.create(fields),/原内容/)
 await api.recoverCreate();assert.deepEqual(requests[0],requests[1]);assert.deepEqual((requests[1] as {assignee:unknown}).assignee,assignee);assert.equal(raw,null)
})
test('交办新任务响应不能丢失负责人',async()=>{
 const api=createTaskApi(async()=>row)
 await assert.rejects(api.create(fields,{roleId:id,expectedVersion:2}),/负责人/)
})
test('创建丢回包后重建客户端仍用原请求，改变目标不能重复创建',async()=>{
 let raw:string|null=null,first=true;const requests:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(method:string,input:unknown)=>{assert.equal(method,'tasks/create');requests.push(input);if(first){first=false;throw Error('回包丢失')}return row}
 await assert.rejects(createTaskApi(call,journal).create(fields),/回包丢失/)
 const api=createTaskApi(call,journal);assert.deepEqual(api.pendingFields(),fields)
 await assert.rejects(api.create({...fields,goal:'另一目标'}),/原内容/)
 assert.deepEqual(await api.create(fields),row);assert.deepEqual(requests[0],requests[1]);assert.equal(raw,null)
})
test('重复目录身份和损坏状态不能被接受，恢复日志失败时不发送创建',async()=>{
 await assert.rejects(createTaskApi(async()=>[row,row]).list(),/重复/)
 await assert.rejects(createTaskApi(async()=>[{...row,state:'imagined'}]).list(),/格式/)
 let calls=0
 const api=createTaskApi(async()=>{calls++;return row},{read:()=>null,write:()=>{throw Error('存储失败')},clear:()=>{}})
 await assert.rejects(api.create(fields),/存储失败/);assert.equal(calls,0)
})
test('编辑响应必须匹配任务、版本与目标，错误响应不能更新页面',async()=>{
 const fields={title:'修改名称',goal:'修改目标'},saved={...row,...fields,version:2}
 const requests:unknown[]=[]
 const api=createTaskApi(async(method,payload)=>{assert.equal(method,'tasks/edit');requests.push(payload);return saved})
 assert.deepEqual(await api.edit(id,1,fields),saved)
 assert.deepEqual(requests,[{taskId:id,expectedVersion:1,fields}])
 for(const bad of [{...saved,version:3},{...saved,title:'其他目标'},{...saved,id:'87654321-1234-4234-8234-123456789012'}])await assert.rejects(createTaskApi(async()=>bad).edit(id,1,fields),/不一致/)
})
test('结项记录必须属于目标任务和有效成果版本',async()=>{
 const completion={taskId:id,taskVersion:3,artifactId:id,artifactVersion:2,note:'确认交付',completedAt:at}
 assert.deepEqual(await createTaskApi(async()=>completion).completion(id),completion)
 for(const invalid of [{...completion,taskId:'other'},{...completion,artifactVersion:0},{...completion,completedAt:'bad'}])await assert.rejects(createTaskApi(async()=>invalid).completion(id),/格式/)
})
test('需要你快照覆盖全部任务并严格校验状态与原因',async()=>{
 const blocked={...row,state:'blocked',assigneeRoleId:id,assigneeRoleVersion:2},waiting={...row,id:'87654321-1234-4234-8234-123456789012',state:'waiting'}
 const value={items:[{task:blocked,attention:{kind:'error',reason:'execution-failed'}},{task:waiting,attention:{kind:'review',reason:'task-waiting'}}]}
 const calls:unknown[][]=[],api=createTaskApi(async(method,payload)=>{calls.push([method,payload]);return value})
 assert.deepEqual(await api.attention(),value);assert.deepEqual(calls,[['tasks/attention',{}]])
 for(const bad of [
  {items:[value.items[0],value.items[0]]},
  {items:[{task:blocked,attention:null}]},
  {items:[{task:waiting,attention:{kind:'error',reason:'task-blocked'}}]},
  {items:[{task:row,attention:{kind:'review',reason:'execution-completed'}}]},
  {items:[{task:{...blocked,assigneeRoleId:null,assigneeRoleVersion:null},attention:{kind:'error',reason:'execution-failed'}}]},
  {items:[{task:blocked,attention:{kind:'error',reason:'unknown'}}]},
  {items:[{task:{...waiting,state:['waiting']},attention:null}]},
  {items:[{task:{...waiting,id:'------------------------------------'},attention:null}]},
  {items:[{task:{...blocked,assigneeRoleId:'------------------------------------'},attention:{kind:'error',reason:'execution-failed'}}]},
 ])await assert.rejects(createTaskApi(async()=>bad).attention(),/需要你/)
})
test('需要你快照保留任务服务的连接错误',async()=>{
 const failure=Error('连接已断开，请稍后重试。')
 await assert.rejects(createTaskApi(async()=>{throw failure}).attention(),error=>error===failure)
})
test('运行配置失败可提醒已交办的可恢复任务，并使用明确文案',async()=>{
 const attention={kind:'error' as const,reason:'execution-configuration-failed' as const}
 for(const state of ['ready','paused','blocked','waiting'] as const){
  const task={...row,state,assigneeRoleId:id,assigneeRoleVersion:1}
  const result=await createTaskApi(async()=>({items:[{task,attention}]})).attention()
  assert.equal(result.items[0]?.attention?.reason,attention.reason)
 }
 assert.equal(taskAttentionDescription(attention.reason,key=>key==='task.attention.reason.executionConfigurationFailed'?'Runtime setup is incomplete. Review it before preparing again.':key),'Runtime setup is incomplete. Review it before preparing again.')
 await assert.rejects(createTaskApi(async()=>({items:[{task:row,attention}]})).attention(),/需要你/)
})
