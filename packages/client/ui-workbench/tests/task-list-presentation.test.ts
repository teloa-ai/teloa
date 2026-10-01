import test from 'node:test'
import assert from 'node:assert/strict'
import type {PreviewTask} from '../src/client/task-preview.ts'
import {groupTaskRows,nextListIndex,pinRank,sortTaskRows,taskObjectLabel,type TaskRowAttention} from '../src/client/task-list-presentation.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'

const task=(id:string,patch:Partial<PreviewTask>={}):PreviewTask=>({id,title:id,goal:'',scope:'general',object:'obj',version:1,state:'ready',need:null,request:'',authorId:'me',assigneeId:'me',assigneeHistory:[],createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'security.risk.low'},execution:'not_started',...patch} as PreviewTask)
const attention=(reason:TaskRowAttention['reason']):TaskRowAttention=>({kinds:[],reason})

test('任务对象占位标签随语言变化，业务对象原文不翻译',()=>{
  const local=task('local',{storage:'persistent',object:'本机任务'}),general=task('general',{object:'通用任务'}),business=task('business',{storage:'persistent',object:'客户业务对象'})
  const en=(key:Parameters<typeof translateMessage>[1])=>translateMessage('en',key)
  const zh=(key:Parameters<typeof translateMessage>[1])=>translateMessage('zh-CN',key)
  assert.equal(taskObjectLabel(local,en),'Local task')
  assert.equal(taskObjectLabel(local,zh),'本机任务')
  assert.equal(taskObjectLabel(general,en),'General task')
  assert.equal(taskObjectLabel(general,zh),'通用任务')
  assert.equal(taskObjectLabel(business,en),'客户业务对象')
})

test('置顶权重：approval < error < review < blocked < 无',()=>{
  assert.equal(pinRank(attention('approval'),'ready'),0)
  assert.equal(pinRank(attention('error'),'ready'),1)
  assert.equal(pinRank(attention('review'),'ready'),2)
  assert.equal(pinRank(attention('blocked'),'blocked'),3)
  assert.equal(pinRank(attention(null),'running'),4)
})

test('sortTaskRows 先按置顶权重，同权重按 updatedAt 降序，再按 id 升序',()=>{
  const rows=[
    {task:task('d',{updatedAt:'2026-09-21T00:00:00.000Z'}),attention:attention(null)},
    {task:task('b',{updatedAt:'2026-09-19T00:00:00.000Z',state:'blocked'}),attention:attention('blocked')},
    {task:task('c',{updatedAt:'2026-09-22T00:00:00.000Z'}),attention:attention(null)},
    {task:task('a',{updatedAt:'2026-09-18T00:00:00.000Z'}),attention:attention('approval')},
    {task:task('e',{updatedAt:'2026-09-18T00:00:00.000Z'}),attention:attention('error')},
    {task:task('r',{updatedAt:'2026-09-18T00:00:00.000Z'}),attention:attention('review')},
    {task:task('c2',{updatedAt:'2026-09-22T00:00:00.000Z'}),attention:attention(null)},
  ]
  assert.deepEqual(sortTaskRows(rows).map(row=>row.task.id),['a','e','r','b','c','c2','d'])
  // 纯函数：入参顺序不被改写。
  assert.deepEqual(rows.map(row=>row.task.id),['d','b','c','a','e','r','c2'])
})

test('groupTaskRows 把群内回应任务折成一组，只看正式时整组不返回',()=>{
  const routed=(id:string)=>({task:task(id,{source:{groupId:'g',messageId:'m',rootId:'r',text:'',trigger:'routed'}})})
  const manual=(id:string)=>({task:task(id,{source:{groupId:'g',messageId:'m',rootId:'r',text:'',trigger:'manual'}})})
  const rows=[{task:task('f1')},routed('r1'),manual('f2'),routed('r2')]
  const all=groupTaskRows(rows,'all')
  assert.deepEqual(all.formal.map(row=>row.task.id),['f1','f2'])
  assert.deepEqual(all.routed.map(row=>row.task.id),['r1','r2'])
  const formal=groupTaskRows(rows,'formal')
  assert.deepEqual(formal.formal.map(row=>row.task.id),['f1','f2'])
  assert.deepEqual(formal.routed,[])
})

test('nextListIndex 处理 ↑↓/Home/End，其它键返回 undefined',()=>{
  assert.equal(nextListIndex('ArrowDown',0,3),1)
  assert.equal(nextListIndex('ArrowDown',2,3),2)
  assert.equal(nextListIndex('ArrowUp',0,3),0)
  assert.equal(nextListIndex('ArrowUp',2,3),1)
  assert.equal(nextListIndex('End',0,3),2)
  assert.equal(nextListIndex('Home',2,3),0)
  assert.equal(nextListIndex('Enter',0,3),undefined)
  assert.equal(nextListIndex('Escape',0,3),undefined)
})
