import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import type {PlanApi, SavedPlan} from '../src/client/plan-api.ts'

/** 执行当前源码的真实设置工厂；本文件不调用组件，只隔离未使用的展示依赖。 */
const source=readFileSync(new URL('../src/client/AutoDreamSettingsPage.tsx',import.meta.url),'utf8')
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
const exported:Record<string,unknown>={}
new Function('require','exports',code)(()=>({}),exported)
const {createAutoDreamSettingApi}=exported as Pick<typeof import('../src/client/AutoDreamSettingsPage.tsx'),'createAutoDreamSettingApi'>

const stamp='2026-09-20T00:00:00.000Z'
type SavedRolePlan=Extract<SavedPlan,{roleId:string}>
const plan=(patch:Partial<SavedRolePlan>={}):SavedRolePlan=>({
 id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',title:'Auto Dream · 每日小结',goal:'目标',
 scope:'general',dataScope:'数据范围',delivery:'交付说明',roleId:'22222222-2222-4222-8222-222222222222',roleVersion:1,
 trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'23:30',timezone:'Asia/Singapore'},notificationPolicy:'silent',
 source:{kind:'system-digest',roleId:'22222222-2222-4222-8222-222222222222'},version:1,configVersion:1,
 state:'active',archivedReason:null,archivedAt:null,createdAt:stamp,updatedAt:stamp,
 ...patch,
})
const manualPlan=plan({id:'33333333-3333-4333-8333-333333333333',source:{kind:'manual'}})

function makePlanApi(rows:SavedPlan[],overrides:Partial<PlanApi> = {}):Pick<PlanApi,'list'|'change'|'update'>{
 return {
  list:async()=>rows,
  change:async()=>{throw Error('change 未被覆写')},
  update:async()=>{throw Error('update 未被覆写')},
  ...overrides,
 } as Pick<PlanApi,'list'|'change'|'update'>
}

test('list() 只挑 source.kind===system-digest 的行，manual 计划不混入',async()=>{
 const api=createAutoDreamSettingApi(makePlanApi([plan(),manualPlan]))
 const rows=await api.list()
 assert.equal(rows.length,1)
 assert.equal(rows[0]!.source.kind,'system-digest')
})

test('不再提供批量启停入口，改时间不调用启用或暂停动作',async()=>{
 const changes:unknown[]=[]
 const paused=plan({state:'paused'}),active=plan({id:'44444444-4444-4444-8444-444444444444'})
 const updates:string[]=[]
 const api=createAutoDreamSettingApi(makePlanApi([paused,active],{
  change:async(...args)=>{changes.push(args);return plan()},
  update:async(row)=>{updates.push(row.id);return row},
 }))
 assert.equal('setEnabled' in api,false)
 await api.setTrigger([],'08:00','UTC')
 assert.deepEqual(updates,[paused.id,active.id])
 assert.deepEqual(changes,[])
})

test('时间：调 update 并原样回填其余字段，trigger 同时带上新 time 与 timezone',async()=>{
 const calls:unknown[]=[]
 const row=plan()
 const api=createAutoDreamSettingApi(makePlanApi([row],{update:async(target,fields)=>{calls.push([target.id,fields]);return plan()}}))
 await api.setTrigger([],'08:00','UTC')
 assert.equal(calls.length,1)
 const [id,fields]=calls[0] as [string,Record<string,unknown>]
 assert.equal(id,row.id)
 assert.deepEqual(fields,{title:row.title,goal:row.goal,dataScope:row.dataScope,delivery:row.delivery,trigger:{...row.trigger,time:'08:00',timezone:'UTC'},notificationPolicy:row.notificationPolicy})
})

test('时间：基于最新 list() 而非调用方传入的旧快照：挂载后新增的计划也会被同步改时间',async()=>{
 const calls:unknown[]=[]
 const mounted=plan({id:'44444444-4444-4444-8444-444444444444'})
 const addedLater=plan({id:'55555555-5555-4555-8555-555555555555'})
 let listCalls=0
 const api=createAutoDreamSettingApi(makePlanApi([],{
  list:async()=>{listCalls++;return listCalls===1?[mounted]:[mounted,addedLater]},
  update:async(target,fields)=>{calls.push(target.id);return plan()},
 }))
 const mountRows=await api.list()
 await api.setTrigger(mountRows,'08:00','UTC')
 assert.deepEqual(calls,[mounted.id,addedLater.id])
})

test('notificationPolicy 缺省时回退 silent（system-digest 计划理论上恒为 silent，这里只兜底类型）',async()=>{
 const calls:unknown[]=[]
 const {notificationPolicy:_omit,...rest}=plan()
 const row=rest as SavedPlan
 const api=createAutoDreamSettingApi(makePlanApi([row],{update:async(target,fields)=>{calls.push(fields);return plan()}}))
 await api.setTrigger([],'08:00','Asia/Singapore')
 assert.equal((calls[0] as {notificationPolicy:string}).notificationPolicy,'silent')
})
