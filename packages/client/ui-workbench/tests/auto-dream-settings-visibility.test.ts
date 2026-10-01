import type {AutoDreamRecentApi,AutoDreamRecentRow} from '../src/client/auto-dream-recent-api.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import * as contract from '@teloa/contract'
import type {PlanApi,SavedPlan} from '../src/client/plan-api.ts'
import type {AutoDreamSettingApi} from '../src/client/AutoDreamSettingsPage.tsx'

/**
 * 第三轮修复复现与回归：AutoDreamSettings 挂载点（GeneralSettings 内的 `settings.general.item`）
 * 承载在一个只用 CSS 隐藏、从不随 `state.view` 卸载的 `<section>` 下，组件原来的
 * `useEffect(()=>{load()},[api])` 只在应用启动那一刻拉一次 `api.list()`——启动时通常还没有
 * 在岗同事，拉到空列表后就永远卡死（开关 disabled，`run()` 的 `finally load()` 也从未被触发）。
 *
 * 修法：WorkbenchFrame.tsx 新增一条模块级可见性广播（`publishSettingsPanelVisible`/
 * `subscribeSettingsPanelVisible`），AutoDreamSettings 订阅后只在「设置页当前可见」时才
 * `load()`。三层第三方 slot 契约（sidebar.settings/settings.section/settings.general.item）
 * 的 owner props 都被上游包锁成固定形状，没法沿 renderSlot 夹带一个 active 字段，因此没有走
 * props 链，改走同文件内的这条广播（细节见 WorkbenchFrame.tsx 内 AutoDreamSettings 前的注释）。
 *
 * 本文件真实运行 WorkbenchFrame.tsx 的 AutoDreamSettings 组件函数与其 useEffect，只替换钩子
 * 调度（手法与 page-create-render.test.ts / saved-collaboration-topic-draft.test.ts 一致），
 * 不经过 jsdom。WorkbenchFrame.tsx 内其余几十个仅供 WorkbenchFrame/WorkbenchSidebar 使用的依赖
 * 在本测试里从未被 AutoDreamSettings 实际调用，一律喂一个惰性代理占位即可安全跳过。
 */

const stamp='2026-09-21T00:00:00.000Z'
const plan=(patch:Partial<SavedPlan> = {}):SavedPlan=>({
 id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',title:'Auto Dream · 每日小结',goal:'目标',
 scope:'general',dataScope:'数据范围',delivery:'交付说明',roleId:'22222222-2222-4222-8222-222222222222',roleVersion:1,
 trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'23:30',timezone:'Asia/Singapore'},notificationPolicy:'silent',
 source:{kind:'system-digest',roleId:'22222222-2222-4222-8222-222222222222'},version:1,configVersion:1,
 state:'active',archivedReason:null,archivedAt:null,createdAt:stamp,updatedAt:stamp,
 ...patch,
})

type Props={api:AutoDreamSettingApi;recent?:AutoDreamRecentApi;openRole?:(id:string)=>void}
type Element=React.ReactElement<Record<string,any>>
const elements=(node:React.ReactNode):Element[]=>{
 if(Array.isArray(node))return node.flatMap(elements)
 if(!React.isValidElement<Record<string,any>>(node))return []
 return [node,...elements(node.props.children)]
}

/** 执行真实的 AutoDreamSettings 组件函数与真实 effect 调度；只有它自己的钩子被手动实现。 */
function mount(initial:Props){
 let props=initial
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks={...React,
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initialValue:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initialValue})},
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{
   const index=cursor++,previous=effects.get(index)
   if(previous&&deps.every((value,depIndex)=>Object.is(value,previous.deps[depIndex])))return
   pending.push(()=>{previous?.cleanup?.();effects.set(index,{deps,cleanup:run()??undefined})})
  },
 }
 const t=(key:string,params?:Record<string,string|number>)=>params?key+':'+JSON.stringify(params):key
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const inert=new Proxy({},{get:()=>()=>null})
 const stub=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id==='lucide-react')return inert
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  // WorkbenchFrame.tsx 是巨型外壳文件，其余几十个相对/包依赖只供 WorkbenchFrame/WorkbenchSidebar
  // 使用；AutoDreamSettings 本身从不触碰它们，统一给个惰性占位，属性访问/调用都安全地什么也不做。
  return inert
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/AutoDreamSettingsPage.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(stub,exported,hooks)
 const Component=exported.AutoDreamSettingsPage as (props:Props)=>React.ReactNode
 const publishSettingsPanelVisible=exported.publishSettingsPanelVisible as (next:boolean)=>void
 const render=():React.ReactNode=>{
  let guard=0
  do{
   assert.ok(guard++<20,'组件不应无限重渲染')
   dirty=false;cursor=0;pending=[]
   tree=Component(props)
   for(const run of pending)run()
  }while(dirty)
  return tree
 }
 const flush=async()=>{for(let round=0;round<8;round++){await Promise.resolve();render()}return tree}
 const find=(match:(el:Element)=>boolean)=>{const matches=elements(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!}
 return {render,flush,find,publishSettingsPanelVisible}
}

function makeApi(listImpl:()=>Promise<SavedPlan[]>):{api:AutoDreamSettingApi;calls:{list:number}}{
 const calls={list:0}
 const api:AutoDreamSettingApi={
  list:async()=>{calls.list++;return listImpl()},
  setEnabled:async()=>{throw Error('setEnabled 未被覆写')},
  setTrigger:async()=>{throw Error('setTrigger 未被覆写')},
 }
 return {api,calls}
}

test('设置页不可见时挂载：不拉取计划，开关保持 disabled',async()=>{
 const {api,calls}=makeApi(async()=>[])
 const app=mount({api})
 await app.flush()
 assert.equal(calls.list,0,'设置页尚不可见就不该拉取')
 const toggle=app.find(el=>el.type==='input'&&el.props.role==='switch')
 assert.equal(toggle.props.disabled,true)
})

test('设置页由不可见变为可见：重新拉取全量计划，开关随之可用并反映最新状态',async()=>{
 // 挂载时 visible=false，effect 里 load() 被跳过，listImpl 一次都不会跑；
 // 唯一一次真正的 list() 发生在 publish(true) 之后，因此这里直接喂一条 active 计划。
 const {api,calls}=makeApi(async()=>[plan({state:'active'})])
 const app=mount({api})
 await app.flush()
 assert.equal(calls.list,0)

 app.publishSettingsPanelVisible(true)
 await app.flush()

 assert.equal(calls.list,1,'设置页一旦可见就必须重新 list()')
 const toggle=app.find(el=>el.type==='input'&&el.props.role==='switch')
 assert.equal(toggle.props.disabled,false)
 assert.equal(toggle.props['aria-checked'],true)
})

test('设置页反复隐藏/再次显示：每次显示都用最新全量重新拉取，不吃上一次显示时的旧快照',async()=>{
 let call=0
 // 挂载时 visible=false 不发起请求，所以下标 0 就是「第一次显示」拉到的数据（只有一条 paused）；
 // 下标 1 是「隐藏后台外新增了一位同事」再显示时拉到的数据（新增一条 active）。
 const rows=[[plan({id:'44444444-4444-4444-8444-444444444444',state:'paused'})],[plan({id:'44444444-4444-4444-8444-444444444444',state:'paused'}),plan({id:'55555555-5555-4555-8555-555555555555',state:'active'})]]
 const {api,calls}=makeApi(async()=>{const value=rows[call]!;call=Math.min(call+1,rows.length-1);return value})
 const app=mount({api})
 await app.flush()

 app.publishSettingsPanelVisible(true)
 await app.flush()
 assert.equal(calls.list,1)
 assert.equal(app.find(el=>el.type==='input'&&el.props.role==='switch').props.disabled,false)
 assert.equal(app.find(el=>el.type==='input'&&el.props.role==='switch').props['aria-checked'],false,'第一次显示时台外还没有 active 计划')

 app.publishSettingsPanelVisible(false)
 await app.flush()
 app.publishSettingsPanelVisible(true)
 await app.flush()

 assert.equal(calls.list,2,'再次显示必须再拉一次，而不是复用上一次显示时的快照')
 const toggle=app.find(el=>el.type==='input'&&el.props.role==='switch')
 assert.equal(toggle.props['aria-checked'],true,'第二次拉到的新计划必须反映在开关上')
})

test('页内两行：开关行与生成时刻行的标题、说明与控件都在，且不再渲染升级期提示 dailyLog.skipped',async()=>{
 const {api}=makeApi(async()=>[plan({state:'active'})])
 const app=mount({api})
 app.publishSettingsPanelVisible(true)
 await app.flush()
 const texts=elements(app.render()).flatMap(el=>typeof el.props.children==='string'?[el.props.children]:[])
 for(const key of ['autoDream.name','dailyLog.switchTitle','dailyLog.switchHint','dailyLog.triggerTitle','dailyLog.triggerHint'])assert.ok(texts.includes(key),'缺少 '+key)
 assert.ok(!texts.includes('dailyLog.skipped'),'升级期提示不该再常驻')
 assert.ok(!texts.includes('dailyLog.timeHint'))
 assert.equal(app.find(el=>el.type==='input'&&el.props.type==='time').props.value,'23:30')
 const select=app.find(el=>el.type==='select')
 assert.equal(select.props.value,'Asia/Singapore')
 assert.equal(elements(select).filter(el=>el.type==='option').length,3)
})

test('页根 section 的 aria-label 是产品名 autoDream.name（浏览器脚本按 region 名定位）',async()=>{
 const {api}=makeApi(async()=>[])
 const app=mount({api})
 const root=app.find(el=>el.type==='section'&&el.props['aria-label']==='autoDream.name')
 assert.ok(root)
})

test('index.ts 把 Auto Dream 注册为 settings.section（order 7，紧随「上网」的 6），不再作为通用设置的子项',()=>{
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.match(source,/name:'settings\.section',id:'teloa-auto-dream',order:7,label:\(\)=>requireI18n\(\)\.t\('autoDream\.name'\)/)
 assert.doesNotMatch(source,/'settings\.general\.item',id:'teloa-auto-dream'/)
 assert.doesNotMatch(source,/id:'teloa-auto-dream',order:-90/)
})

const recentRow=(patch:Partial<AutoDreamRecentRow>):AutoDreamRecentRow=>({roleId:'22222222-2222-4222-8222-222222222222',name:'林析',kind:'employee',days:Array.from({length:7},(_,i)=>({day:'2026-09-'+(15+i),kept:i%2===0})),today:'generated',hasPlan:true,...patch})
function makeRecent(rows:AutoDreamRecentRow[]){const calls={load:0};return {recent:{load:async()=>{calls.load++;return rows}},calls}}

test('日志读取失败显示未知，刷新后恢复真实状态且不播报 0/7',async()=>{
 const {api}=makeApi(async()=>[plan()]);let calls=0
 const unavailable=recentRow({today:'unavailable',days:Array.from({length:7},(_,i)=>({day:'2026-09-'+(15+i),kept:null}))})
 const app=mount({api,recent:{load:async()=>[++calls===1?unavailable:recentRow({})]}})
 app.publishSettingsPanelVisible(true);await app.flush()
 assert.equal(app.find(el=>el.props.role==='img').props['aria-label'],'autoDream.recent.unavailable')
 assert.ok(elements(app.render()).some(el=>el.props.children==='autoDream.recent.unavailable'))
 app.find(el=>el.type==='button'&&el.props.children==='autoDream.recent.refresh').props.onClick()
 await app.flush()
 assert.equal(calls,2)
 assert.equal(app.find(el=>el.props.role==='img').props['aria-label'],'4/7')
})

test('「最近 7 天」只在设置页可见时拉取：不可见零次，可见后随 rows 各拉一次',async()=>{
 const {api}=makeApi(async()=>[plan({state:'active'})]),{recent,calls}=makeRecent([recentRow({})])
 const app=mount({api,recent})
 await app.flush()
 assert.equal(calls.load,0)
 app.publishSettingsPanelVisible(true);await app.flush()
 assert.equal(calls.load,1)
 const row=app.find(el=>el.props['data-role-id']==='22222222-2222-4222-8222-222222222222')
 assert.equal(elements(row).filter(el=>el.props['data-day']!==undefined).length,7)
 assert.equal(elements(row).filter(el=>String(el.props.className??'').includes('dayKept')).length,4)
 assert.ok(elements(app.render()).some(el=>el.props.children==='autoDream.recent.generated'))
})
test('缺计划提示行只在有在岗同事没有计划时出现，按钮把第一位缺计划的同事交给 openRole',async()=>{
 const opened:string[]=[]
 const {api}=makeApi(async()=>[plan({state:'active'})])
 const withMissing=makeRecent([recentRow({}),recentRow({roleId:'55555555-5555-4555-8555-555555555555',name:'周衡',hasPlan:false,today:'none'})])
 const app=mount({api,recent:withMissing.recent,openRole:id=>{opened.push(id)}})
 app.publishSettingsPanelVisible(true);await app.flush()
 const action=app.find(el=>el.type==='button'&&el.props.children==='autoDream.missingPlanAction')
 action.props.onClick()
 assert.deepEqual(opened,['55555555-5555-4555-8555-555555555555'])
 assert.ok(elements(app.render()).some(el=>[el.props.children].flat().includes('autoDream.missingPlan:{"count":1}')))
 const allHave=makeRecent([recentRow({})])
 const app2=mount({api,recent:allHave.recent,openRole:()=>{}})
 app2.publishSettingsPanelVisible(true);await app2.flush()
 assert.equal(elements(app2.render()).filter(el=>el.type==='button'&&el.props.children==='autoDream.missingPlanAction').length,0)
})
test('零在岗岗位时显示 autoDream.recent.empty，不渲染任何 7 天行',async()=>{
 const {api}=makeApi(async()=>[]),{recent}=makeRecent([])
 const app=mount({api,recent})
 app.publishSettingsPanelVisible(true);await app.flush()
 assert.ok(elements(app.render()).some(el=>el.props.children==='autoDream.recent.empty'))
 assert.equal(elements(app.render()).filter(el=>el.props['data-role-id']!==undefined).length,0)
})
