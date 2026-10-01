import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {activeHandoffCandidates,activeHandoffState} from '../src/client/task-handoff-presentation.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const current='16057272-ed9d-44a3-abe4-2ab04e056105'
const peer='26057272-ed9d-44a3-abe4-2ab04e056105'
const otherScope='36057272-ed9d-44a3-abe4-2ab04e056105'
const paused='46057272-ed9d-44a3-abe4-2ab04e056105'
const twin='56057272-ed9d-44a3-abe4-2ab04e056105'
const task={id:'66057272-ed9d-44a3-abe4-2ab04e056105',title:'核对告警',goal:'核对来源',scope:'SOC',version:2,state:'ready',storage:'persistent',object:'本机任务',need:null,request:'',authorId:'self',assigneeId:current,assigneeHistory:[current],createdAt:'2026-09-13T00:00:00Z',updatedAt:'2026-09-13T00:00:00Z',result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'未提出外部动作',execution:'not_started'} satisfies PreviewTask
const role=(id:string,name:string,changes:Partial<PreviewRole>={}):PreviewRole=>({storage:'persistent',id,name,kind:'employee',scopes:['SOC'],state:'active',version:2,duty:'核对',dataScope:'资料',executionScope:'声明',skills:[],knowledge:[],memories:[],history:[],...changes})
const roles=[role(current,'当前调查岗'),role(peer,'接续调查岗'),role(otherScope,'设计岗',{scopes:['Design']}),role(paused,'暂停岗',{state:'paused'}),role(twin,'我的分身',{kind:'twin'})]

test('主动改派候选包含本人和同范围在岗数字员工，并按完整身份排除当前负责人',()=>{
 assert.deepEqual(activeHandoffCandidates(task,roles),[
  {kind:'self',id:'self',version:null},
  {kind:'role',id:peer,name:'接续调查岗',version:2},
 ])
 assert.deepEqual(activeHandoffCandidates({...task,assigneeId:'self'},roles).map(item=>[item.kind,item.id,item.kind==='role'?item.name:null]),[
  ['role',current,'当前调查岗'],['role',peer,'接续调查岗'],
 ])
})

// 2026-09-21 用户裁定：改派候选与契约 roleSupportsScope 同口径——通用工作（general）任务对所有在岗同事开放，业务范围仍严格按岗位声明过滤。
test('通用工作任务的改派候选不按岗位业务声明过滤，业务范围任务仍严格过滤',()=>{
 const generalTask={...task,scope:'general'}
 assert.deepEqual(activeHandoffCandidates(generalTask,roles).map(item=>item.id),['self',peer,otherScope])
})

test('被动待交接优先，运行中和终态不提供主动入口，恢复态阻止重复提交',()=>{
 assert.deepEqual(activeHandoffState(task,{passivePending:true,recovering:false}),{visible:false,disabled:true,reason:'passive'})
 for(const state of ['running','completed','cancelled'] as const)assert.deepEqual(activeHandoffState({...task,state},{passivePending:false,recovering:false}),{visible:false,disabled:true,reason:'state'})
 assert.deepEqual(activeHandoffState(task,{passivePending:false,recovering:true}),{visible:true,disabled:true,reason:'recovery'})
 assert.deepEqual(activeHandoffState(task,{passivePending:false,recovering:false}),{visible:true,disabled:false,reason:null})
})

test('任务详情使用紧凑负责人入口、完整确认信息和固定边界文案',async()=>{
 const source=await readFile(new URL('../src/client/TaskHandoffs.tsx',import.meta.url),'utf8')
 assert.match(source,/useI18n\(\)/)
 assert.match(source,/task\.detail\.expandHandoff/)
 assert.match(source,/task\.detail\.currentOwnerLabel/)
 assert.match(source,/task\.detail\.successorRole/)
 assert.match(source,/handoff\.active\.boundary/)
 assert.match(source,/activeState\.reason==='recovery'/)
 assert.match(source,/if\(!activeState\.visible\)return null/)
})

test('窄屏负责人调整按单列排列且操作不溢出',async()=>{
 const css=await readFile(new URL('../src/client/TaskPage.module.css',import.meta.url),'utf8')
 const narrow=css.match(/@media\(max-width:760px\)\{[^\n]*\.assigneeControl[^\n]*\}/)?.[0]??''
 assert.match(narrow,/\.assigneeForm/)
 assert.match(narrow,/grid-template-columns:1fr/)
 assert.match(narrow,/\.assigneeActions/)
 assert.match(narrow,/width:100%/)
})

test('客户端使用独立改派 journal，自动恢复并在成功后刷新任务、岗位和被动交接',async()=>{
 const [index,frame]=await Promise.all([
  readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),
  readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
 ])
 // 改派仍用它自己那把键，只是存储层统一收进了 journal-storage.ts（G4：跨标签页共享）。
 assert.match(index,/journal\('teloa\.handoff-change\/v1'\)/)
 assert.match(frame,/if\(handoffApi\.pendingChange\(\)\)void recoverHandoffChange\(\)/)
 assert.match(frame,/Promise\.all\(\[loadTasks\(\),loadRoles\(\),loadHandoffs\(\)\]\)/)
 assert.match(frame,/mergeSavedTasks\(\[result\.task\]\)/)
})
