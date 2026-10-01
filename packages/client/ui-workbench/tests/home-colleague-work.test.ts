import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {homeColleagueWork} from '../src/client/home-colleague-work.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const stamp='2026-09-18T09:00:00.000Z'
function task(id:string,assigneeId:string,overrides:Partial<PreviewTask>={}):PreviewTask{
 return {id,title:id,goal:'核对固定事实',scope:'general',object:'本机任务',version:1,state:'running',need:null,request:'',authorId:'self',assigneeId,assigneeHistory:[assigneeId],createdAt:stamp,updatedAt:stamp,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'',execution:'not_started',...overrides}
}

test('首页同事在做只计入已保存、交给数字员工且未结束的任务',()=>{
 const result=homeColleagueWork([
  task('saved-running','role-a',{storage:'persistent',updatedAt:'2026-09-18T08:00:00.000Z'}),
  task('saved-waiting','role-b',{storage:'persistent',state:'waiting',updatedAt:'2026-09-18T09:00:00.000Z'}),
  task('saved-second','role-a',{storage:'persistent',state:'blocked',updatedAt:'2026-09-18T07:00:00.000Z'}),
  task('self','self',{storage:'persistent'}),
  task('example','role-c'),
  task('completed','role-d',{storage:'persistent',state:'completed'}),
  task('cancelled','role-e',{storage:'persistent',state:'cancelled'}),
 ])
 assert.equal(result.count,3)
 assert.equal(result.colleagueCount,2)
 assert.deepEqual(result.latest.map(item=>item.id),['saved-waiting','saved-running'])
})

test('首页同事在做无符合任务时如实返回空态',()=>{
 assert.deepEqual(homeColleagueWork([task('self','self',{storage:'persistent'}),task('completed','role',{storage:'persistent',state:'completed'})]),{count:0,colleagueCount:0,latest:[]})
})

test('工作台把持久化任务台账交给首页，而非从岗位或会话推断',async()=>{
 const [frame,home,presentation]=await Promise.all([
  readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/home-colleague-work.ts',import.meta.url),'utf8'),
 ])
 assert.match(frame,/<WorkHome[\s\S]*workTasks=\{tasks\.tasks\}[\s\S]*colleagues=\{tasks\.roles\}[\s\S]*openTasks=\{\(\)=>actions\.navigate\('tasks'\)\}/)
 assert.match(home,/homeColleagueWork\(workTasks\)/)
 assert.match(presentation,/task\.storage==='persistent'&&task\.assigneeId!=='self'/)
})
