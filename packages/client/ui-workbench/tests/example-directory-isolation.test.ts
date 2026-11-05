import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {homeColleagueWork} from '../src/client/home-colleague-work.ts'
import {isGroupReplyConversation} from '../src/client/task-list-presentation.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'
import {currentAttentionKinds,visibleAttentionDirectory,visibleCurrentAttentionDirectory,visibleRoleDirectory,visibleTaskDirectory} from '../src/client/example-directory-presentation.ts'

const root=new URL('../src/client/',import.meta.url)

test('任务与数字员工以显式沙盒隔离示例和正式目录',async()=>{
  const [tasks,team]=await Promise.all([
    readFile(new URL('TaskPage.tsx',root),'utf8'),
    readFile(new URL('TeamPage.tsx',root),'utf8'),
  ])
  assert.match(tasks,/data-task-directory-mode=\{directoryMode\}/)
  assert.match(tasks,/visibleTaskDirectory\(state\.tasks,directoryMode\)/)
  assert.match(tasks,/visibleRoleDirectory\(state\.roles,directoryMode\)/)
  assert.match(tasks,/visibleCurrentAttentionDirectory\(attentionItems\)/)
  assert.match(tasks,/currentAttentionKinds\(visibleAttention\)/)
  assert.doesNotMatch(tasks,/filterAttentionItems\(/)
  assert.doesNotMatch(tasks,/attention\.v2\.search/)
  assert.doesNotMatch(tasks,/name="attention-scope"/)
  assert.doesNotMatch(tasks,/task\.sandbox\.exit/)
  assert.doesNotMatch(tasks,/const rows=state\.tasks\.filter/)
  assert.match(team,/data-team-directory-mode=\{directoryMode\}/)
  assert.match(team,/visibleRoleDirectory\(state\.roles,directoryMode\)/)
  assert.doesNotMatch(team,/team\.sandbox\.exit/)
  assert.doesNotMatch(team,/const rows = state\.roles\.filter/)
})

test('正式与沙盒投影按持久化边界互斥',()=>{
  const tasks=[{id:'saved',storage:'persistent'},{id:'example'}] as never
  const roles=[{id:'saved',storage:'persistent'},{id:'example'}] as never
  const attention=[{id:'saved',persistence:'saved',kind:'approval'},{id:'recovery',persistence:'local-recovery',kind:'error'},{id:'example',persistence:'example',kind:'review'}] as never
  assert.deepEqual(visibleTaskDirectory(tasks,'saved').map(item=>item.id),['saved'])
  assert.deepEqual(visibleTaskDirectory(tasks,'sandbox').map(item=>item.id),['example'])
  assert.deepEqual(visibleRoleDirectory(roles,'saved').map(item=>item.id),['saved'])
  assert.deepEqual(visibleRoleDirectory(roles,'sandbox').map(item=>item.id),['example'])
  assert.deepEqual(visibleAttentionDirectory(attention,'saved').map(item=>item.id),['saved','recovery'])
  assert.deepEqual(visibleAttentionDirectory(attention,'sandbox').map(item=>item.id),['example'])
  assert.deepEqual(visibleCurrentAttentionDirectory(attention).map(item=>item.id),['saved','recovery'])
  assert.deepEqual(currentAttentionKinds(visibleCurrentAttentionDirectory([...attention,{id:'later',persistence:'saved',kind:'approval'}] as never)),['approval','error'])
})

test('全局搜索只接收已保存任务和数字员工',async()=>{
  const frame=await readFile(new URL('WorkbenchFrame.tsx',root),'utf8')
  assert.match(frame,/tasks:tasks\.tasks\.filter\(task=>task\.storage==='persistent'\)/)
  assert.match(frame,/roles:tasks\.roles\.filter\(role=>role\.storage==='persistent'\)/)
  assert.match(frame,/marketTargets\(tasks\.roles\.filter\(role=>role\.storage==='persistent'\)/)
  const host=await readFile(new URL('index.ts',root),'utf8')
  assert.match(host,/await roleApi\.list\(\)/)
  assert.doesNotMatch(frame,/bindings=\{\{forms:bindingForms/, '正式能力页不得重新注入内存演示绑定')
  assert.match(frame,/<CollaborationPage [^\n]*roles=\{tasks\.roles\.filter\(role=>role\.storage==='persistent'\)\}/)
  assert.doesNotMatch(frame,/collaborationMode/,'协作群页只留持久一条线，不得保留模式切换')
})


test('普通群聊执行从正式任务目录和同事在做统计退出；未知来源、明确工作和已变更任务保留',()=>{
 const reply={id:'reply',storage:'persistent',state:'running',contentVersion:1,assigneeId:'role',assigneeRoleVersion:7,updatedAt:'2026-11-05T00:00:00Z',source:{groupId:'g',messageId:'m',rootId:null,text:'你好',trigger:'routed',executionMode:'reply',createdAssignee:{roleId:'role',roleVersion:7}}} as unknown as PreviewTask;
 const rows=[reply,{...reply,id:'reply-waiting',state:'waiting'}, {...reply,id:'work',source:{...reply.source!,executionMode:'work'}},{...reply,id:'unknown',source:undefined},{...reply,id:'edited',contentVersion:2},{...reply,id:'reassigned',assigneeRoleVersion:8}] as PreviewTask[];
 assert.deepEqual(visibleTaskDirectory(rows,'saved').map(row=>row.id),['work','unknown','edited','reassigned']);
 assert.equal(homeColleagueWork(rows).count,4,'普通交流不制造同事工作数，正式与未核清的工作不被隐藏');
 const conversation={purpose:'task-run',run:{taskId:'reply',taskVersion:1,roleId:'role',roleVersion:7}} as never;
 assert.equal(isGroupReplyConversation(conversation,rows),true);
 assert.equal(isGroupReplyConversation(conversation,[{...reply,contentVersion:2}]),false);
 assert.equal(isGroupReplyConversation(conversation,[]),false);
 assert.equal(isGroupReplyConversation({purpose:'ordinary'} as never,rows),false);
})
