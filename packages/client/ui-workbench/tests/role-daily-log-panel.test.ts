import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import * as React from 'react'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {RoleDailyLog, RoleDailyLogKind, RoleDailyLogSummary, RoleMemory} from '@teloa/contract'
import type {RoleDailyLogApi} from '../src/client/role-daily-log-api.ts'
import type {RoleMemoryApi} from '../src/client/role-memory-api.ts'

/**
 * 功能验证（2026-09-21 AutoDream 一期与群提及）：同事「工作日志」页签与判断力样本分组。
 * 两套手法：
 * - RoleDailyLogPanel 需要真实的列表 → 详情两级异步加载与交互，走「真实运行组件函数 + 手动 hooks 调度」
 *   （手法与 group-mention.test.ts / page-create-render.test.ts 一致），因为 react-dom/server 不跑 effect。
 * - TeamPage.tsx 的「它记得的事 / 工作日志」页签只是静态结构，走 team-roster-i18n.test.ts 的路子：
 *   编译产物 + renderToStaticMarkup + 真实 I18nProvider/translateMessage。
 */

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)

// ── RoleDailyLogPanel：真实组件函数 + 手动 hooks 调度 ──────────────────────────────
type Props={trigger?:{time:string;timezone:'Asia/Singapore'|'Asia/Shanghai'|'UTC'};now?:()=>string;roleId:string;kind:RoleDailyLogKind;api:RoleDailyLogApi;memoryApi:RoleMemoryApi|undefined;promote?:(log:RoleDailyLog,value:{title:string;markdown:string})=>Promise<void>}

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
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id.endsWith('.module.css'))return {default:cssProxy}
    if(id==='lucide-react')return {Play:()=>null,ShieldCheck:()=>null,MessageSquare:()=>null,FileText:()=>null,MoreHorizontal:()=>null,TriangleAlert:()=>null}
  if(id.endsWith('auto-dream-day.js'))return {autoDreamObservationDay:(nowIso:string)=>nowIso.slice(0,10)}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({t:zh,locale:'zh-CN',dateTime:(value:string)=>String(value).slice(0,10)})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>cause instanceof Error?cause.message:String(cause)}
  throw Error('未声明的组件依赖：'+id)
 }
 const source=readFileSync(new URL('../src/client/RoleDailyLogPanel.tsx',import.meta.url),'utf8')
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,hooks)
 const Component=exported.RoleDailyLogPanel as (props:Props)=>React.ReactNode
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
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 const contentOf=(node:React.ReactNode):string=>{
  if(Array.isArray(node))return node.map(contentOf).join('')
  if(React.isValidElement<Record<string,any>>(node))return contentOf((node.props as {children?:React.ReactNode}).children)
  return typeof node==='string'||typeof node==='number'?String(node):''
 }
 return {
  render,flush,
  wholeContent:()=>contentOf(render()),
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

const byContent=(app:ReturnType<typeof mount>,text:string)=>(el:React.ReactElement<Record<string,any>>)=>app.contentOf(el)===text&&!React.Children.toArray(el.props.children).some(child=>React.isValidElement(child)&&app.contentOf(child)===text)

const roleId='11111111-1111-4111-8111-111111111111'
const logKeptId='22222222-2222-4222-8222-222222222222'
const logDiscardedId='33333333-3333-4333-8333-333333333333'
const candidateId='44444444-4444-4444-8444-444444444444'
const validHintMemoryId='55555555-5555-4555-8555-555555555555'
const staleHintMemoryId='66666666-6666-4666-8666-666666666666'
const revisedBody='这是被修订成果的完整正文内容，绝不应该出现在证据行里。'
const stamp='2026-09-20T23:30:00.000Z'

const summaryKept:RoleDailyLogSummary={id:logKeptId,kind:'daily-digest',day:'2026-09-20',state:'kept',title:'今日小结',createdAt:stamp}
const summaryDiscarded:RoleDailyLogSummary={id:logDiscardedId,kind:'daily-digest',day:'2026-09-19',state:'discarded',title:'昨日小结',createdAt:stamp}
const logDetail:RoleDailyLog={
 id:logKeptId,ownerId:'local:owner',roleId,roleVersion:2,kind:'daily-digest',day:'2026-09-20',state:'kept',
 runId:'77777777-7777-4777-8777-777777777777',title:'今日小结',markdown:'今天核对了三张工单，均已完成。',
 scopeIds:[],
 evidence:[
  {kind:'run',id:'run-1',version:1,title:'处理了工单#501'},
  {kind:'revision',id:'artifact-1',version:2,title:'季度报告修订'},
 ],
 pruneHints:[
  {memoryId:validHintMemoryId,memoryStateVersion:2,reason:'与今天证据不符，建议撤回'},
  {memoryId:staleHintMemoryId,memoryStateVersion:2,reason:'旧建议，已过期'},
 ],
 createdAt:stamp,discardedAt:null,
}
const memoryFixture=(patch:Partial<RoleMemory>):RoleMemory=>({
 id:'x',ownerId:'local:owner',roleId,roleVersion:2,title:'记忆',state:'confirmed',stateVersion:2,
 source:{kind:'daily-digest',id:logKeptId,version:1},sourceTitle:'今日小结',sourceAvailable:true,
 visibility:{kind:'private',scopeIds:[]},proposedBy:{kind:'self'},
 content:{version:1,contentHash:'a'.repeat(64),bytes:6,markdown:'候选内容',createdAt:stamp},
 candidateAt:stamp,confirmedAt:stamp,withdrawnAt:null,
 ...patch,
})
const candidateMemory=memoryFixture({id:candidateId,title:'今天新学到的经验',state:'candidate',stateVersion:1,confirmedAt:null})
const validHintMemory=memoryFixture({id:validHintMemoryId,title:'旧结论A',stateVersion:2})
const staleHintMemory=memoryFixture({id:staleHintMemoryId,title:'旧结论B',stateVersion:3})

function makeApi(overrides:Partial<RoleDailyLogApi> = {}):RoleDailyLogApi{
 return {
  pending:()=>false,recoveryMessage:()=>undefined,discardPending:()=>{},
  recover:async()=>logDetail,
  list:async()=>[summaryKept,summaryDiscarded],
  get:async()=>logDetail,
  discard:async()=>({...logDetail,state:'discarded',discardedAt:stamp}),
  ...overrides,
 } as RoleDailyLogApi
}
function makeMemoryApi():RoleMemoryApi{
 return {
  list:async()=>[candidateMemory,validHintMemory,staleHintMemory],
  confirm:async(id:string)=>({...candidateMemory,id,state:'confirmed',stateVersion:2}),
  withdraw:async(id:string)=>({...validHintMemory,id,state:'withdrawn',stateVersion:3}),
  pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false,
 } as unknown as RoleMemoryApi
}

test('列表按 day 倒序展示，已丢弃行显示丢弃态；列表尾固定保留说明',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 assert.ok(app.find(byContent(app,'今日小结')))
 assert.ok(app.find(el=>el.type==='button'&&app.contentOf(el).includes('昨日小结')))
 assert.ok(app.wholeContent().includes(zh('create.draft.discarded')))
 assert.ok(app.find(byContent(app,zh('dailyLog.recentCount',{count:2}))))
})

test('日志详情四节标题逐字等于「当日证据」「相关记忆」「建议撤回」，自动保存提示固定出现',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 const row=app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结'))
 row.props.onClick();app.render()
 await app.flush()
 assert.ok(app.find(byContent(app,zh('dailyLog.evidenceCount',{count:2}))))
 assert.equal(zh('dailyLog.evidence'),'当日证据')
 assert.ok(app.find(byContent(app,zh('dailyLog.candidateCount',{count:3}))))
 assert.equal(zh('dailyLog.candidates'),'相关记忆')
 assert.ok(app.find(byContent(app,zh('dailyLog.pruneHintsCount',{count:2}))))
 assert.equal(zh('dailyLog.pruneHints'),'建议撤回')
 assert.ok(app.find(byContent(app,zh('dailyLog.candidateHint'))))
})

test('失效建议显示「这条建议已失效。」且按钮 disabled；有效建议按钮可用',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render()
 await app.flush()
 assert.ok(app.find(byContent(app,'这条建议已失效。')))
 assert.equal(zh('dailyLog.pruneStale'),'这条建议已失效。')
 const withdrawButtons=app.findAll(el=>el.type==='button'&&app.contentOf(el)===zh('team.memory.withdraw'))
 assert.ok(withdrawButtons.some(button=>button.props.disabled===true),'失效建议对应的撤回按钮必须 disabled')
 assert.ok(withdrawButtons.some(button=>!button.props.disabled),'有效建议对应的撤回按钮必须可用')
})

test('revision 类证据行不出现被改成果的正文；候选与证据栏都不含成果原文',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render()
 await app.flush()
 assert.doesNotMatch(app.wholeContent(),new RegExp(revisedBody))
 assert.match(app.wholeContent(),/季度报告修订工作成果 · v2/,'revision 证据应显示标题与版本号，不显示正文')
})

test('kind=habit-digest 且传 promote 时渲染「记下来」表单，提交调用 promote(log,{title,markdown})',async()=>{
 const promoted:{log:RoleDailyLog;value:{title:string;markdown:string}}[]=[]
 const promote=async(log:RoleDailyLog,value:{title:string;markdown:string})=>{promoted.push({log,value})}
 const app=mount({roleId,kind:'habit-digest',api:makeApi(),memoryApi:makeMemoryApi(),promote})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render()
 await app.flush()
 assert.ok(app.findAll(byContent(app,zh('habitLog.promote'))).length>0,'应渲染「记下来」')
 assert.ok(app.find(byContent(app,zh('habitLog.promoteLimit'))))
 assert.ok(app.wholeContent().includes(zh('habitLog.private')))
 const submit=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote'))
 await submit.props.onClick()
 await app.flush()
 assert.equal(promoted.length,1)
 assert.equal(promoted[0]!.log.id,logKeptId)
 assert.equal(promoted[0]!.value.title,'今日小结')
})

test('不传 promote（同事 daily-digest）不渲染「记下来」',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render()
 await app.flush()
 assert.equal(app.findAll(byContent(app,zh('habitLog.promote'))).length,0)
})

test('空态：list() 返回 [] 时显示 dailyLog.empty',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi({list:async()=>[]}),memoryApi:makeMemoryApi()})
 await app.flush()
 assert.ok(app.find(byContent(app,zh('dailyLog.empty'))))
})

test('丢弃这份日志：点击调用 api.discard，成功后该行与详情都置为已丢弃',async()=>{
 const discardCalls:string[]=[]
 const api=makeApi({discard:async(logId:string)=>{discardCalls.push(logId);return {...logDetail,state:'discarded',discardedAt:stamp}}})
 const app=mount({roleId,kind:'daily-digest',api,memoryApi:makeMemoryApi()})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render()
 await app.flush()
 const discardButton=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('dailyLog.discard')&&el.props['aria-label']===undefined)
 await discardButton.props.onClick()
 await app.flush()
 assert.deepEqual(discardCalls,[logKeptId])
 assert.ok(app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')&&app.contentOf(el).includes(zh('create.draft.discarded'))),'列表行应置灰为已丢弃')
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el)===zh('dailyLog.discard')&&el.props['aria-label']===undefined).length,0,'已丢弃后不应再出现可点的丢弃按钮')
})

test('源码不使用 dangerouslySetInnerHTML',()=>{
 const source=readFileSync(new URL('../src/client/RoleDailyLogPanel.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})

test('CSS 不写死会在窄屏溢出的固定宽度，行/证据用 flex-wrap 与 overflow-wrap 兜底',()=>{
 const css=readFileSync(new URL('../src/client/RoleDailyLogPanel.module.css',import.meta.url),'utf8')
 assert.doesNotMatch(css,/(?<![\w-])width:\s*[4-9]\d{2,}px/,'不应写死超过 390px 视口会溢出的固定宽度')
 assert.match(css,/flex-wrap/,'行/证据列表应允许换行')
 assert.match(css,/overflow-wrap:anywhere/,'长文本需要 overflow-wrap 兜底')
 assert.match(css,/min-width:0/,'flex 容器需要 min-width:0 才不会把窄屏撑破')
})

// ── TeamPage.tsx 的「它记得的事 / 工作日志」页签：编译产物 + renderToStaticMarkup ──────────────────────
const {RoleDetail}=await import('../lib/types/client/TeamPage.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {emptyTaskPreview}=await import('../lib/types/client/task-preview.js')
const {emptyCollaboration}=await import('../lib/types/client/collaboration-preview.js')

const runtime={t:zh,subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const noop=()=>{}
const noopNode=()=>null
const employeeRole={
 id:'role-1',name:'安全分析师',kind:'employee',scopes:['general'],state:'active',version:2,storage:'persistent',
 duty:'负责安全告警的初筛与结论输出。',dataScope:'仅限安全日志',executionScope:'不直接改动线上系统',
 skills:[],knowledge:[],responsibility:undefined,memories:[],history:[],
}
const renderRoleDetail=()=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(RoleDetail as never,{
 work:{},resourceApi:{},memoryApi:{recoveryMessage:()=>undefined,pending:()=>false,list:async()=>[]},
 dailyLogApi:undefined,runtimeConfigs:undefined,capabilityState:undefined,persistence:undefined,
 conversations:noopNode,input:{draft:undefined,editing:true},update:noop,role:employeeRole,
 state:{...emptyTaskPreview(),roles:[employeeRole]},collaboration:emptyCollaboration(),change:noop,back:noop,
 openTask:noop,openGroup:noop,resources:noop,nativeSettings:noop,capabilities:noopNode,plans:noopNode,
} as never)))

test('同事主页 memory 组的「编辑」态出现「它记得的事 / 工作日志」两个页签，role="tablist" 在位',()=>{
 const html=renderRoleDetail()
 assert.match(html,/role="tablist"/)
 assert.match(html,/role="tab"/)
 assert.ok(html.includes(zh('team.profile.group.memory')))
 assert.ok(html.includes(zh('dailyLog.entry')))
 assert.match(html,/aria-selected="true"[^>]*>它记得的事<\/button>/,'默认应停在「它记得的事」')
 assert.match(html,/aria-selected="false"[^>]*>工作日志<\/button>/,'「工作日志」页签默认未选中')
})

test('memory 组页签支持键盘 ←→/Home/End：moveMemoryTab 四个分支齐全且都 preventDefault',async()=>{
 const source=await (await import('node:fs/promises')).readFile(new URL('../src/client/TeamPage.tsx',import.meta.url),'utf8')
 const line=source.slice(source.indexOf('const moveMemoryTab ='),source.indexOf('};',source.indexOf('const moveMemoryTab =')))
 for(const key of ['ArrowRight','ArrowLeft','Home','End'])assert.match(line,new RegExp(`event\\.key === '${key}'`),`moveMemoryTab 缺少 ${key} 分支`)
 assert.equal(line.match(/event\.preventDefault\(\)/g)?.length,4,'四个方向都要 preventDefault，否则宿主页面会跟着滚动/翻页')
 assert.match(source,/onKeyDown=\{moveMemoryTab\}/,'页签按钮必须接上 moveMemoryTab')
})

test('左列按 day 倒序：已丢弃行灰显并显示丢弃态；表头「最近 60 天 · N 份」取代原保留说明',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 const rows=app.findAll(el=>el.type==='button'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('day'))
 assert.equal(rows.length,2)
 assert.ok(app.contentOf(rows[0]!).includes('今日小结'));assert.ok(app.contentOf(rows[1]!).includes('昨日小结')&&app.contentOf(rows[1]!).includes(zh('create.draft.discarded')),'已丢弃行保留标题并追加丢弃态（既有丢弃用例 :237 依赖标题仍在）')
 assert.ok(rows[1]!.props.className.split(' ').includes('dayOff'),'已丢弃行应灰显')
 assert.ok(!rows[0]!.props.className.split(' ').includes('dayOff'))
 assert.equal(app.findAll(byContent(app,zh('dailyLog.recentCount',{count:2}))).length,1)
 assert.equal(app.findAll(byContent(app,'只保留最近 60 天。')).length,0)
})
test('状态点：kept 实心、discarded 空心（dot / dotOff 类）',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush()
 const dots=app.findAll(el=>el.type==='i'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('dot'))
 assert.equal(dots.length,2)
 assert.ok(!dots[0]!.props.className.split(' ').includes('dotOff'))
 assert.ok(dots[1]!.props.className.split(' ').includes('dotOff'))
})
test('传入 trigger 与 now 时，观察日等于 day 的那一行标「今天 · MM-DD」；不传 trigger 不标',async()=>{
 const trigger={time:'23:30',timezone:'Asia/Singapore' as const}
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi(),trigger,now:()=>'2026-09-20T12:00:00.000Z'})
 await app.flush()
 assert.equal(app.findAll(byContent(app,zh('dailyLog.today',{date:'2026-09-20'}))).length,1)
 const plain=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await plain.flush()
 assert.equal(plain.findAll(el=>plain.contentOf(el).startsWith('今天 · ')).length,0)
})

const openDetail=async(app:ReturnType<typeof mount>)=>{app.find(el=>el.type==='button'&&app.contentOf(el).includes('今日小结')).props.onClick();app.render();await app.flush()}

test('眉行：面板名 · 生成时间；习惯观察追加「只有你能看到」',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush();await openDetail(app)
 const eyebrow=app.find(el=>el.type==='p'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('eyebrow'))
 assert.equal(app.contentOf(eyebrow),zh('dailyLog.title')+' · 2026-09-20')
 const habit=mount({roleId,kind:'habit-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await habit.flush();await openDetail(habit)
 const habitEyebrow=habit.find(el=>el.type==='p'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('eyebrow'))
 assert.equal(habit.contentOf(habitEyebrow),zh('habitLog.title')+' · 2026-09-20 · '+zh('habitLog.private'))
})
test('证据段标题带计数并逐条带类型图标；相关记忆包含自动生效项与旧候选',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush();await openDetail(app)
 assert.ok(app.find(byContent(app,zh('dailyLog.evidenceCount',{count:2}))))
 assert.ok(app.find(byContent(app,zh('dailyLog.candidateCount',{count:3}))))
 const evidenceRows=app.findAll(el=>el.type==='li'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('evidence'))
 assert.equal(evidenceRows.length,2)
 assert.match(app.contentOf(evidenceRows[1]!),/季度报告修订工作成果 · v2$/)
})
test('建议撤回是一条警示提示行：标题带条数、提示句常驻；零条时整段不出现',async()=>{
 const app=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await app.flush();await openDetail(app)
 const warn=app.find(el=>el.type==='section'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('warn'))
 assert.ok(app.contentOf(warn).includes(zh('dailyLog.pruneHintsCount',{count:2})))
 assert.ok(app.contentOf(warn).includes(zh('dailyLog.pruneHintHint')))
 const none=mount({roleId,kind:'daily-digest',api:makeApi({get:async()=>({...logDetail,pruneHints:[]})}),memoryApi:makeMemoryApi()})
 await none.flush();await openDetail(none)
 assert.equal(none.findAll(el=>el.type==='section'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('warn')).length,0)
})
test('「···」菜单：丢弃在菜单里；有未完成请求时多出「核对未完成请求」并调用 api.recover',async()=>{
 let recovered=0
 const app=mount({roleId,kind:'daily-digest',api:makeApi({pending:()=>true,recover:async()=>{recovered++;return {...logDetail,state:'discarded',discardedAt:stamp}}}),memoryApi:makeMemoryApi()})
 await app.flush();await openDetail(app)
 const summary=app.find(el=>el.type==='summary')
 assert.equal(summary.props['aria-label'],zh('dailyLog.more'))
 const menu=app.find(el=>el.props.role==='menu')
 assert.ok(app.findAll(el=>el.type==='button'&&app.contentOf(el)===zh('dailyLog.discard')).length===1)
 const recover=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('dailyLog.recover'))
 assert.ok(app.contentOf(menu).includes(zh('dailyLog.recover')))
 await recover.props.onClick();await app.flush()
 assert.equal(recovered,1)
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el)===zh('dailyLog.discard')).length,0,'恢复回包已丢弃后不再出现丢弃项')
})

test('空态：左列「最近 60 天 · 0 份」，右侧标题 + 说明；传 trigger 时多一句下次生成时刻，不传则没有',async()=>{
 const trigger={time:'06:00',timezone:'Asia/Singapore' as const}
 const app=mount({roleId,kind:'daily-digest',api:makeApi({list:async()=>[]}),memoryApi:makeMemoryApi(),trigger,now:()=>'2026-09-20T12:00:00.000Z'})
 await app.flush()
 assert.ok(app.find(byContent(app,zh('dailyLog.recentCount',{count:0}))))
 assert.ok(app.find(byContent(app,zh('dailyLog.emptyTitle'))))
 assert.ok(app.find(byContent(app,zh('dailyLog.empty'))))
 assert.ok(app.find(byContent(app,zh('dailyLog.emptyNext',{time:'06:00',timezone:'Asia/Singapore'}))))
 const plain=mount({roleId,kind:'daily-digest',api:makeApi({list:async()=>[]}),memoryApi:makeMemoryApi()})
 await plain.flush()
 assert.equal(plain.findAll(el=>plain.contentOf(el).startsWith('下次生成时刻')).length,0)
 const habit=mount({roleId,kind:'habit-digest',api:makeApi({list:async()=>[]}),memoryApi:makeMemoryApi()})
 await habit.flush()
 assert.ok(habit.find(byContent(habit,zh('habitLog.emptyTitle'))))
 assert.equal(habit.findAll(byContent(habit,zh('dailyLog.empty'))).length,0,'习惯观察空态不说「工作证据」')
})

test('习惯观察详情：「记下来」是一条折叠行，summary 写着还能记几条；同事日志不渲染折叠行',async()=>{
 const promote=async()=>{}
 const app=mount({roleId,kind:'habit-digest',api:makeApi(),memoryApi:makeMemoryApi(),promote})
 await app.flush();await openDetail(app)
 const fold=app.find(el=>el.type==='details'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('fold'))
 const summary=app.find(el=>el.type==='summary'&&app.contentOf(el)===zh('habitLog.promoteFold',{count:3}))
 assert.ok(fold&&summary)
 assert.equal(summary.props['aria-disabled'],undefined)
 const employee=mount({roleId,kind:'daily-digest',api:makeApi(),memoryApi:makeMemoryApi()})
 await employee.flush();await openDetail(employee)
 assert.equal(employee.findAll(el=>el.type==='details'&&typeof el.props.className==='string'&&el.props.className.split(' ').includes('fold')).length,0)
})
test('记满 3 条后：summary 切成 habitLog.promoteLimit 并 aria-disabled，提交按钮 disabled，表单仍在树里',async()=>{
 const promote=async()=>{}
 const app=mount({roleId,kind:'habit-digest',api:makeApi(),memoryApi:makeMemoryApi(),promote})
 await app.flush();await openDetail(app)
 for(let round=0;round<3;round++){await app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote')).props.onClick();await app.flush()}
 const summary=app.find(el=>el.type==='summary'&&app.contentOf(el)===zh('habitLog.promoteLimit'))
 assert.equal(app.contentOf(summary),zh('habitLog.promoteLimit'))
 assert.equal(summary.props['aria-disabled'],true)
 assert.equal(app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote')).props.disabled,true)
 assert.equal(app.findAll(byContent(app,zh('habitLog.promoteLimit'))).length,1,'限额说明恰出现一次')
})
