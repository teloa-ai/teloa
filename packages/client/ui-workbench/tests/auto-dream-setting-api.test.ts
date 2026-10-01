import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import type {PlanApi, SavedPlan} from '../src/client/plan-api.ts'

/**
 * 功能验证 评审修复轮 1 · L1：autoDreamSettingApi 复用 planApi 后补最小测试。
 * createAutoDreamSettingApi 是纯逻辑工厂（WorkbenchFrame.tsx 导出），走编译产物 + CSS Modules 代理
 * 就能直接单测，不必挂整个 WorkbenchFrame 组件树（手法与 team-roster-i18n.test.ts 一致）。
 *
 * 第二轮修复（浏览器脚本第七轮复跑发现）：AutoDreamSettings 组件挂载时 `api.list()` 一次性快照 rows，
 * 之后点开关一直用这份旧快照调 setEnabled(rows,...)；挂载后新建同事的系统摘要计划不在快照里，永远
 * 不会被暂停/启用。修法：setEnabled/setTrigger 内部一律重新调 planApi.list() 取最新全量，不再依赖
 * 调用方传入的 rows（签名保留只为兼容，参数已不参与目标选取）。以下用例相应更新。
 */
// WorkbenchFrame.js 编译产物经 CollaborationPage.js 引到 SavedCollaborationPage.js，后者现在真的
// import @deepseek-ai/dsh-client-ui-primitives（群消息按 Markdown 渲染）。那是 DSH 平台模块，运行时由
// 宿主注入，它自带的 katex.min.css/anser/shiki/mdast 一串依赖仓内没有，Node 下真解析会直接炸模块加载；
// 这里同 .module.css/.svg 一样短路成桩，本文件不渲染消息正文，用不到真实 MarkdownText。
registerHooks({
 resolve:(specifier,context,next)=>specifier==='@deepseek-ai/dsh-client-ui-primitives'?{url:'teloa-test-stub:markdown-text',shortCircuit:true}:/\.(module\.css|svg)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url==='teloa-test-stub:markdown-text'?{format:'module',shortCircuit:true,source:'export const MarkdownText=()=>null'}:url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:url.endsWith('.svg')?{format:'module',shortCircuit:true,source:'export default ""'}:next(url,context),
})
const {createAutoDreamSettingApi}=await import('../lib/types/client/AutoDreamSettingsPage.js')

const stamp='2026-09-20T00:00:00.000Z'
const plan=(patch:Partial<SavedPlan>={}):SavedPlan=>({
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

test('开关基于最新 list() 而非调用方传入的旧快照：挂载后新增的计划也会被切换',async()=>{
 const calls:unknown[]=[]
 const mounted=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const addedLater=plan({id:'55555555-5555-4555-8555-555555555555',state:'active'})
 let listCalls=0
 const api=createAutoDreamSettingApi(makePlanApi([],{
  list:async()=>{listCalls++;return listCalls===1?[mounted]:[mounted,addedLater]},
  change:async(planId,expectedVersion,action)=>{calls.push([planId,expectedVersion,action]);return plan()},
 }))
 const mountRows=await api.list() // 模拟组件挂载时 list() 首次返回：此时只有 1 条
 assert.deepEqual(mountRows.map(r=>r.id),[mounted.id])
 // 挂载后台外新建了一位同事，其系统摘要计划这才出现；组件手里的 rows 仍是挂载时那份旧快照。
 await api.setEnabled(mountRows,false)
 assert.deepEqual(calls,[[mounted.id,mounted.version,'pause'],[addedLater.id,addedLater.version,'pause']])
})

test('开：对每条 paused 的调 change(id,version,\'enable\')，active 的不重复调',async()=>{
 const calls:unknown[]=[]
 const paused=plan({state:'paused'}),active=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const api=createAutoDreamSettingApi(makePlanApi([paused,active],{change:async(planId,expectedVersion,action)=>{calls.push([planId,expectedVersion,action]);return plan()}}))
 await api.setEnabled([],true)
 assert.deepEqual(calls,[[paused.id,paused.version,'enable']])
})

test('关：对每条 active 的调 change(id,version,\'pause\')，paused 的不重复调',async()=>{
 const calls:unknown[]=[]
 const paused=plan({state:'paused'}),active=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const api=createAutoDreamSettingApi(makePlanApi([paused,active],{change:async(planId,expectedVersion,action)=>{calls.push([planId,expectedVersion,action]);return plan()}}))
 await api.setEnabled([],false)
 assert.deepEqual(calls,[[active.id,active.version,'pause']])
})

test('关：三条计划第二条首次 change 因版本漂移失败，不中止后续，随后按最新 version 重试一次并成功',async()=>{
 const calls:unknown[]=[]
 const p1=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const p2=plan({id:'55555555-5555-4555-8555-555555555555',state:'active'})
 const p3=plan({id:'66666666-6666-4666-8666-666666666666',state:'active'})
 const latestRows=[p1,{...p2,version:2},p3]
 let p2ChangeCalls=0
 const api=createAutoDreamSettingApi(makePlanApi(latestRows,{
  change:async(planId,expectedVersion,action)=>{
   calls.push([planId,expectedVersion,action])
   if(planId===p2.id){
    p2ChangeCalls++
    if(p2ChangeCalls===1){const error=Object.assign(new Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'});throw error}
   }
   return plan()
  },
 }))
 await api.setEnabled([],false)
 // setEnabled 起手即用 planApi.list() 取最新全量，latestRows 里 p2 已是 version 2，
 // 所以首次调用就带 version 2；此处的失败模拟的是"提交瞬间又被别处改了一次"，不是版本已知过期。
 assert.deepEqual(calls,[
  [p1.id,p1.version,'pause'],
  [p2.id,2,'pause'],
  [p2.id,2,'pause'],
  [p3.id,p3.version,'pause'],
 ])
})

test('关：重试前发现该计划已被别处改到目标态（paused），跳过重试且不算失败',async()=>{
 const calls:unknown[]=[]
 const p1=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const p2=plan({id:'55555555-5555-4555-8555-555555555555',state:'active'})
 const p3=plan({id:'66666666-6666-4666-8666-666666666666',state:'active'})
 const conflict=Object.assign(new Error('已被别处暂停'),{rejected:true,code:'teloa/conflict'})
 let listCalls=0
 const api=createAutoDreamSettingApi(makePlanApi([],{
  // 起手那次 list() 里 p2 还是 active（正常入选目标）；重试时再查一次 list() 才发现已被别处暂停到位。
  list:async()=>{listCalls++;return listCalls===1?[p1,p2,p3]:[p1,{...p2,version:2,state:'paused' as const},p3]},
  change:async(planId,expectedVersion,action)=>{
   calls.push([planId,expectedVersion,action])
   if(planId===p2.id)throw conflict
   return plan()
  },
 }))
 await api.setEnabled([],false)
 assert.deepEqual(calls,[
  [p1.id,p1.version,'pause'],
  [p2.id,p2.version,'pause'],
  [p3.id,p3.version,'pause'],
 ])
})

test('关：重试仍失败时把错误上抛，但其余条目已成功暂停',async()=>{
 const calls:unknown[]=[]
 const p1=plan({id:'44444444-4444-4444-8444-444444444444',state:'active'})
 const p2=plan({id:'55555555-5555-4555-8555-555555555555',state:'active'})
 const p3=plan({id:'66666666-6666-4666-8666-666666666666',state:'active'})
 const latestRows=[p1,{...p2,version:2},p3]
 const finalError=Object.assign(new Error('仍然冲突'),{rejected:true,code:'teloa/version-conflict'})
 const api=createAutoDreamSettingApi(makePlanApi(latestRows,{
  change:async(planId,expectedVersion,action)=>{
   calls.push([planId,expectedVersion,action])
   if(planId===p2.id)throw finalError
   return plan()
  },
 }))
 let caught:unknown
 try{await api.setEnabled([],false)}catch(error){caught=error}
 assert.equal(caught,finalError)
 assert.deepEqual(calls,[
  [p1.id,p1.version,'pause'],
  [p2.id,2,'pause'],
  [p2.id,2,'pause'],
  [p3.id,p3.version,'pause'],
 ])
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
