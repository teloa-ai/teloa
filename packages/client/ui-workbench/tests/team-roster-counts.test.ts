import assert from 'node:assert/strict'
import test from 'node:test'
import {rosterCounts, roleNowDoing, roleIsBusy, taskClosed} from '../src/client/team-roster-counts.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const now='2026-09-16T01:00:00Z'
const role=(id:string):PreviewRole=>({id,name:id,kind:'employee',scopes:['general'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]})
const twin=(id:string):PreviewRole=>({...role(id),kind:'twin'})
const task=(overrides:Partial<PreviewTask>&Pick<PreviewTask,'id'|'assigneeId'>):PreviewTask=>({
  title:'t',goal:'g',scope:'general',object:'o',version:1,state:'running',need:null,request:'',authorId:'self',
  assigneeHistory:[overrides.assigneeId],createdAt:now,updatedAt:now,result:'',evidence:[],history:[],supplements:[],
  approvalRequired:false,risk:'',execution:'not_started',...overrides,
})

test('taskClosed 只认 completed 和 cancelled',()=>{
  assert.equal(taskClosed('completed'),true)
  assert.equal(taskClosed('cancelled'),true)
  assert.equal(taskClosed('running'),false)
  assert.equal(taskClosed('waiting'),false)
})

test('people 是成员数，与是否有工作无关',()=>{
  const members=[role('a'),role('b'),role('c')]
  assert.equal(rosterCounts(members,[]).people,3)
})

test('busy 数人不数事：一人三件未结束工作只算一位',()=>{
  const members=[role('a')]
  const tasks=[task({id:'t1',assigneeId:'a',state:'running'}),task({id:'t2',assigneeId:'a',state:'waiting'}),task({id:'t3',assigneeId:'a',state:'blocked'})]
  assert.equal(rosterCounts(members,tasks).busy,1)
})

test('completed 和 cancelled 不算忙',()=>{
  const members=[role('a')]
  const tasks=[task({id:'t1',assigneeId:'a',state:'completed'}),task({id:'t2',assigneeId:'a',state:'cancelled'})]
  assert.equal(rosterCounts(members,tasks).busy,0)
})

test('waiting 数事：taskNeeds(task).length>0 的工作件数，含 handoff 推出的那一类',()=>{
  const members=[role('a')]
  const tasks=[
    task({id:'t1',assigneeId:'a',need:'approval'}),
    task({id:'t2',assigneeId:'a',need:null,handoff:{fromId:'b',reason:'r',at:now}}),
    task({id:'t3',assigneeId:'a',need:null}),
  ]
  assert.equal(rosterCounts(members,tasks).waiting,2)
})

test('一位成员的两件待办算两件',()=>{
  const members=[role('a')]
  const tasks=[task({id:'t1',assigneeId:'a',need:'approval'}),task({id:'t2',assigneeId:'a',need:'materials'})]
  assert.equal(rosterCounts(members,tasks).waiting,2)
})

test('分身保留在名单人数里，但不进入数字员工忙碌与待办统计',()=>{
  const members=[twin('self-twin')]
  const tasks=[task({id:'draft',assigneeId:'self-twin',need:'approval',state:'running'})]
  assert.deepEqual(rosterCounts(members,tasks),{people:1,busy:0,waiting:0})
})

test('不属于任何成员的工作不计入',()=>{
  const members=[role('a')]
  const tasks=[task({id:'t1',assigneeId:'outsider',need:'approval',state:'running'})]
  const counts=rosterCounts(members,tasks)
  assert.equal(counts.busy,0)
  assert.equal(counts.waiting,0)
})

test('只吃传进来的 tasks：调用方传过滤后的数组，被过滤掉的那条不混进正式计数',()=>{
  const members=[role('a')]
  const allTasks=[task({id:'sample',assigneeId:'a',need:'approval',state:'running'})]
  const filtered=allTasks.filter(item=>item.id!=='sample')
  const counts=rosterCounts(members,filtered)
  assert.equal(counts.busy,0)
  assert.equal(counts.waiting,0)
})

test('roleNowDoing 取 updatedAt 最新的一条，忽略已结束的工作',()=>{
  const tasks=[
    task({id:'t1',assigneeId:'a',title:'旧工作',updatedAt:'2026-09-14T00:00:00Z'}),
    task({id:'t2',assigneeId:'a',title:'新工作',updatedAt:'2026-09-15T00:00:00Z'}),
    task({id:'t3',assigneeId:'a',title:'刚完成但最新',updatedAt:'2026-09-16T00:00:00Z',state:'completed'}),
  ]
  assert.equal(roleNowDoing('a',tasks),'新工作')
})

test('roleNowDoing 无未结束工作时返回 undefined',()=>{
  const tasks=[task({id:'t1',assigneeId:'a',state:'completed'})]
  assert.equal(roleNowDoing('a',tasks),undefined)
  assert.equal(roleNowDoing('missing',[]),undefined)
})

test('roleIsBusy 与 busy 计数同一判据',()=>{
  assert.equal(roleIsBusy('a',[task({id:'t1',assigneeId:'a',state:'running'})]),true)
  assert.equal(roleIsBusy('a',[task({id:'t1',assigneeId:'a',state:'cancelled'})]),false)
  assert.equal(roleIsBusy('a',[]),false)
})
