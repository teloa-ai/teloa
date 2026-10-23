import test from 'node:test'
import assert from 'node:assert/strict'
import {groupRunStopTargets} from '../src/client/group-routing-api.ts'
import {groupWorkTaskStateLabel} from '../src/client/task-list-presentation.ts'

const recipient=(id:string,phase:string,runId:string|null,executionMode:'reply'|'work'='work')=>({roleId:id,name:'员工'+id,phase,taskId:runId?'task-'+id:null,runId,resultMessageId:null,executionMode})
const status=(recipients:readonly unknown[])=>({messageId:'m',attemptVersion:1,phase:'running',recipients,hintCode:null,canRetry:false}) as never

test('GRP-05 只有仍在运行的接收者给出停止目标；已完成/待核对结果不给停止入口',()=>{
 const targets=groupRunStopTargets(status([
  recipient('a','running','run-a'),
  recipient('b','queued',null),
  recipient('c','awaiting-review','run-c'),
  recipient('d','completed','run-d'),
  recipient('e','awaiting-approval','run-e','reply'),
 ]))
 assert.deepEqual(targets.map(item=>[item.roleId,item.runId,item.phase]),[
  ['a','run-a','running'],
  ['e','run-e','awaiting-approval'],
 ])
 assert.deepEqual(groupRunStopTargets(status([recipient('x','completed','run-x')])),[])
})

const fakeT=(key:string,params?:Record<string,unknown>)=>key+(params?':'+JSON.stringify(params):'')
test('GRP-07 群工作任务等待态显示「等待你核对结果」，与群消息行一致；普通等待仍显示等待中',()=>{
 assert.equal(groupWorkTaskStateLabel({state:'waiting',source:{executionMode:'work'} as never},fakeT),'group.status.phase.awaiting-review')
 assert.equal(groupWorkTaskStateLabel({state:'waiting',source:{executionMode:'reply'} as never},fakeT),'status.waiting')
 assert.equal(groupWorkTaskStateLabel({state:'running',source:{executionMode:'work'} as never},fakeT),'status.running')
})
