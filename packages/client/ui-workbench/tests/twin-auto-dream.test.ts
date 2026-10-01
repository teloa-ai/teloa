import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import * as React from 'react'
import type {PreviewRole, TeamChange} from '../src/client/role-preview.ts'

/**
 * 功能验证（2026-09-21 AutoDream 一期与群提及）：分身主页加「Auto Dream · 习惯观察」页签。
 * 两套手法都与 role-daily-log-panel.test.ts 一致：
 * - TwinProfile.tsx 没有异步效果，走「真实组件函数 + 手动 hooks 调度」即可覆盖点击与键盘交互，不需要 flush()。
 * - 「记下来」端到端断言需要 RoleDailyLogPanel 真实的列表→详情两级异步加载，走「真实运行组件函数 +
 *   手动 hooks 调度 + flush()」，独立 mount 一份 RoleDailyLogPanel（不复用 TwinProfile 的 hooks 派发器），
 *   接上真实 role-memory-api.ts 的 createRoleMemoryApi + 假 call，只断言端点名与载荷契约。
 *
 * 背景：RoleDailyLogPanel.tsx 一度只在类型里声明 kind/promote、函数体从未使用（T10 review 发现，
 * HIGH 严重度），已回派给 T10 单独修——本任务 Files（TwinProfile.tsx/TwinProfile.module.css/本测试）
 * 不含 RoleDailyLogPanel.tsx，未越界代修。T10 提交后本文件补齐了「记下来」端到端断言（见文末）。
 */

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {twinDisplayName}=await import('../lib/types/client/team-presentation.js')
const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)

type Props={
 profileName:string
 role:PreviewRole
 draft:{body:string;version:number;editorId:string;updatedAt:string}|undefined
 update:(draft:unknown)=>void
 save:(command:TeamChange)=>boolean
 talk?:()=>Promise<void>
 talkDisabledReason?:string
 conversations:React.ReactNode
 samples:React.ReactNode
 habits?:React.ReactNode
}

function mount(initial:Props){
 let props=initial
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 const hooks={...React,
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initialValue:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initialValue})},
  // TwinProfile.tsx 用 useId 拼 tab id 前缀；单实例测试不需要跨渲染唯一，返回稳定字符串即可。
  useId:()=>'twin-test-id',
 }
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id==='lucide-react')return {Fingerprint:()=>null,LockKeyhole:()=>null}
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({t:zh,locale:'zh-CN',dateTime:(value:string)=>String(value).slice(0,10)})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>cause instanceof Error?cause.message:String(cause)}
  if(id.endsWith('team-presentation.js'))return {twinDisplayName}
  // 代拟稿写入路径不是本任务范围（T11 未改一行），给个占位标记即可，不重实现 TwinDraftEditor。
  if(id.endsWith('TwinDraftEditor.js'))return {TwinDraftEditor:()=>React.createElement('div',{'data-twin-draft-editor-stub':'1'})}
  throw Error('未声明的组件依赖：'+id)
 }
 const source=readFileSync(new URL('../src/client/TwinProfile.tsx',import.meta.url),'utf8')
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,hooks)
 const Component=exported.TwinProfile as (props:Props)=>React.ReactNode
 const render=():React.ReactNode=>{
  let guard=0
  do{
   assert.ok(guard++<20,'组件不应无限重渲染')
   dirty=false;cursor=0
   tree=Component(props)
  }while(dirty)
  return tree
 }
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
  render,
  setProps:(patch:Partial<Props>)=>{props={...props,...patch};dirty=true},
  wholeContent:()=>contentOf(render()),
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

const baseRole=(patch:Partial<PreviewRole> = {}):PreviewRole=>({
 id:'twin',name:'我的分身',kind:'twin',scopes:['general'],state:'active',version:3,storage:'persistent',
 duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',
 dataScope:'本人可见且明确提供的资料。',executionScope:'仅代拟；不能代批、冒充本人或直接外发。',
 skills:['交班代拟'],knowledge:[],memories:[],
 history:[{text:'载入同事界面示例',actorId:'self',at:'2026-01-01T00:00:00.000Z'}],
 ...patch,
} as PreviewRole)

const baseProps=(patch:Partial<Props> = {}):Props=>({
 profileName:'Max',
 role:baseRole(),
 draft:undefined,
 update:()=>{},
 save:()=>true,
 conversations:null,
 samples:React.createElement('div',{'data-samples-marker':'1'},'判断力样本占位'),
 ...patch,
})

const tabButton=(app:ReturnType<typeof mount>,name:string)=>app.find(el=>el.props.role==='tab'&&app.contentOf(el)===name)
const tabPanelByLabelledby=(app:ReturnType<typeof mount>,suffix:string)=>app.find(el=>el.props.role==='tabpanel'&&typeof el.props['aria-labelledby']==='string'&&el.props['aria-labelledby'].endsWith(suffix))

test('分身主页出现四个页签，第三个标题逐字等于「Auto Dream · 习惯观察」',()=>{
 const app=mount(baseProps({habits:React.createElement('div',{'data-habits-marker':'1'})}))
 const tabs=app.findAll(el=>el.props.role==='tab')
 assert.equal(tabs.length,4,'分身主页应有四个页签')
 assert.equal(app.contentOf(tabs[2]!),'Auto Dream · 习惯观察')
 assert.equal(app.contentOf(tabs[2]!),zh('habitLog.title'))
})

test('习惯观察面板顶部两行逐字等于 hint 与 private 词条，不新开色值（复用 note 类）',()=>{
 const app=mount(baseProps({habits:React.createElement('div',{'data-habits-marker':'1'},'真实日志内容')}))
 const panel=tabPanelByLabelledby(app,'-tab-habits')
 const lines=(function collectNotes(node:React.ReactNode):string[]{
  const out:string[]=[]
  const walk=(n:React.ReactNode):void=>{
   if(Array.isArray(n)){n.forEach(walk);return}
   if(!React.isValidElement<Record<string,any>>(n))return
   if(n.props.className==='note')out.push(app.contentOf(n))
   walk((n.props as {children?:React.ReactNode}).children)
  }
  walk(node)
  return out
 })(panel)
 assert.deepEqual(lines,['只看你自己的操作：放行与拒绝、对成果的修订、交办的写法、群里的纠正。','只有你能看到'])
 assert.deepEqual(lines,[zh('habitLog.hint'),zh('habitLog.private')])
 assert.ok(app.contentOf(panel).includes('真实日志内容'),'habits 传入的节点应原样渲染在面板里')
})

test('habits 不传时第三个页签按钮 disabled，但页签总数仍是四个（不做条件分支，keep 键盘环绕下标不漂）',()=>{
 const app=mount(baseProps({habits:undefined}))
 const tabs=app.findAll(el=>el.props.role==='tab')
 assert.equal(tabs.length,4)
 assert.equal(tabs[2]!.props.disabled,true,'habits 未传时第三个页签按钮应 disabled')
 assert.equal(tabs[0]!.props.disabled,false,'其余三个页签不应受影响')
 assert.equal(tabs[1]!.props.disabled,false)
 assert.equal(tabs[3]!.props.disabled,false)
})

test('键盘 ←→ 从「授权边界」环回「代拟工作」（数组长度驱动，四项环绕）',()=>{
 const app=mount(baseProps({habits:React.createElement('div',null)}))
 // 先点到「授权边界」（第四个页签）。
 const boundaryTab=tabButton(app,zh('team.twin.tab.boundary'))
 boundaryTab.props.onClick()
 const afterClick=app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.boundary'))
 assert.equal(afterClick.props['aria-selected'],true)
 // 从「授权边界」按 → 应环回「代拟工作」（TWIN_TABS.length===4，索引 3→0）。
 const preventDefault=()=>{}
 afterClick.props.onKeyDown({key:'ArrowRight',preventDefault})
 const draftTab=app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.draft'))
 assert.equal(draftTab.props['aria-selected'],true,'→ 应从最后一项环回第一项')
 // 反向：从「代拟工作」按 ← 应环回「授权边界」。
 draftTab.props.onKeyDown({key:'ArrowLeft',preventDefault})
 const boundaryAgain=app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.boundary'))
 assert.equal(boundaryAgain.props['aria-selected'],true,'← 应从第一项环回最后一项')
})

test('habits 未传时键盘 ←→/Home/End 跳过 disabled 的第三个页签，不会「选中」一个点不了的页签（修复轮 1 M1）',()=>{
 const app=mount(baseProps({habits:undefined}))
 const preventDefault=()=>{}
 const samplesTab=tabButton(app,zh('team.detail.tab.judgment'))
 // 从「判断力样本」（第二项）按 → 应跳过 disabled 的「习惯观察」，直接落在「授权边界」。
 samplesTab.props.onKeyDown({key:'ArrowRight',preventDefault})
 const boundaryTab=app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.boundary'))
 assert.equal(boundaryTab.props['aria-selected'],true,'→ 应跳过 disabled 页签落在「授权边界」')
 // 反向：从「授权边界」按 ← 应跳过「习惯观察」，落回「判断力样本」。
 boundaryTab.props.onKeyDown({key:'ArrowLeft',preventDefault})
 const samplesAgain=app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.detail.tab.judgment'))
 assert.equal(samplesAgain.props['aria-selected'],true,'← 应跳过 disabled 页签落回「判断力样本」')
 // Home/End 本身就落在「代拟工作」「授权边界」，两者从不 disabled，仍应正常工作。
 samplesAgain.props.onKeyDown({key:'End',preventDefault})
 assert.equal(app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.boundary')).props['aria-selected'],true)
 app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.boundary')).props.onKeyDown({key:'Home',preventDefault})
 assert.equal(app.find(el=>el.props.role==='tab'&&app.contentOf(el)===zh('team.twin.tab.draft')).props['aria-selected'],true)
})

test('既有三个页签（代拟工作/判断力样本/授权边界）的 tabpanel/aria-labelledby/hidden 语义不退化',()=>{
 const app=mount(baseProps({habits:React.createElement('div',null)}))
 for(const suffix of ['-tab-draft','-tab-samples','-tab-boundary','-tab-habits']){
  const panel=tabPanelByLabelledby(app,suffix)
  assert.equal(panel.props.role,'tabpanel')
  assert.equal(panel.props.tabIndex,0)
 }
 // 默认当前页签是「代拟工作」：只有它的 hidden 是 false，其余三个都是 true。
 const draftPanel=tabPanelByLabelledby(app,'-tab-draft')
 const samplesPanel=tabPanelByLabelledby(app,'-tab-samples')
 const habitsPanel=tabPanelByLabelledby(app,'-tab-habits')
 const boundaryPanel=tabPanelByLabelledby(app,'-tab-boundary')
 assert.equal(draftPanel.props.hidden,false)
 assert.equal(samplesPanel.props.hidden,true)
 assert.equal(habitsPanel.props.hidden,true)
 assert.equal(boundaryPanel.props.hidden,true)
})

test('判断力样本页签仍原样渲染 samples 节点，不受新页签影响',()=>{
 const app=mount(baseProps({habits:undefined}))
 const panel=tabPanelByLabelledby(app,'-tab-samples')
 assert.ok(app.contentOf(panel).includes('判断力样本占位'))
})

test('源码不含 dangerouslySetInnerHTML',()=>{
 const source=readFileSync(new URL('../src/client/TwinProfile.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})

// ── 「记下来」端到端：真实 RoleDailyLogPanel（kind='habit-digest'）+ 真实 role-memory-api.ts ──────────
// 独立 mount，不复用上面 TwinProfile 的 hooks 派发器：RoleDailyLogPanel 有 list→detail 两级异步效果，
// 手法照抄 role-daily-log-panel.test.ts 的「真实组件函数 + 手动 hooks 调度 + flush()」。
const {createRoleMemoryApi}=await import('../lib/types/client/role-memory-api.js')

type PanelProps={roleId:string;kind:'habit-digest'|'daily-digest';api:unknown;memoryApi:unknown;promote?:(log:any,value:{title:string;markdown:string})=>Promise<void>}

function mountPanel(initial:PanelProps){
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
 const Component=exported.RoleDailyLogPanel as (props:PanelProps)=>React.ReactNode
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
 const flush=async():Promise<React.ReactNode>=>{for(let round=0;round<8;round++){await Promise.resolve();render()}return tree}
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
  flush,
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

const panelRoleId='77777777-7777-4777-8777-777777777777'
const habitLogId='88888888-8888-4888-8888-888888888888'
const habitSummary={id:habitLogId,kind:'habit-digest' as const,day:'2026-09-20',state:'kept' as const,title:'今日习惯观察',createdAt:'2026-09-20T23:30:00.000Z'}
const habitDetail={
 id:habitLogId,ownerId:'local:owner',roleId:panelRoleId,roleVersion:3,kind:'habit-digest' as const,day:'2026-09-20',state:'kept' as const,
 runId:null,title:'今日习惯观察',markdown:'今天放行了两次交办，纠正了一次群里的措辞。',
 scopeIds:[],
 evidence:[{kind:'approval' as const,id:'approval-1',version:1,title:'放行了交办#12'}],
 pruneHints:[],
 createdAt:'2026-09-20T23:30:00.000Z',discardedAt:null,
}
const habitApi={
 pending:()=>false,recoveryMessage:()=>undefined,discardPending:()=>{},
 recover:async()=>habitDetail,
 list:async()=>[habitSummary],
 get:async()=>habitDetail,
 discard:async()=>({...habitDetail,state:'discarded',discardedAt:habitDetail.createdAt}),
}
const emptyMemoryApi={list:async()=>[],confirm:async()=>{throw Error('不应调用')},withdraw:async()=>{throw Error('不应调用')},pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false}

const dailyLogId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const dailySummary={id:dailyLogId,kind:'daily-digest' as const,day:'2026-09-20',state:'kept' as const,title:'今日小结',createdAt:'2026-09-20T23:30:00.000Z'}
const dailyDetail={
 id:dailyLogId,ownerId:'local:owner',roleId:panelRoleId,roleVersion:3,kind:'daily-digest' as const,day:'2026-09-20',state:'kept' as const,
 runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',title:'今日小结',markdown:'今天核对了三张工单。',
 scopeIds:[],evidence:[],pruneHints:[],createdAt:'2026-09-20T23:30:00.000Z',discardedAt:null,
}
const dailyApi={
 pending:()=>false,recoveryMessage:()=>undefined,discardPending:()=>{},
 recover:async()=>dailyDetail,
 list:async()=>[dailySummary],
 get:async()=>dailyDetail,
 discard:async()=>({...dailyDetail,state:'discarded',discardedAt:dailyDetail.createdAt}),
}

// 已经取到 3 条 habit-digest 记忆（模拟刷新后重新拉取 memoryApi.list 的结果）：上限判据必须从 memories 反推，
// 而不是只看本地 promoteCount（本地计数刷新即归零，之前会放行第 4 次提交）。
const memoryForHabit=(id:string):any=>({
 id,ownerId:'local:owner',roleId:panelRoleId,roleVersion:3,title:'历史习惯记忆',state:'confirmed',stateVersion:2,
 source:{kind:'habit-digest',id:habitLogId,version:1},sourceTitle:habitDetail.title,sourceAvailable:true,
 visibility:{kind:'private',scopeIds:[]},proposedBy:{kind:'self'},
 content:{version:1,contentHash:'a'.repeat(64),bytes:6,markdown:'历史内容',createdAt:habitDetail.createdAt},
 candidateAt:habitDetail.createdAt,confirmedAt:habitDetail.createdAt,withdrawnAt:null,
})
const threeHabitMemoriesApi={
 list:async()=>[memoryForHabit('c1111111-1111-4111-8111-111111111111'),memoryForHabit('c2222222-2222-4222-8222-222222222222'),memoryForHabit('c3333333-3333-4333-8333-333333333333')],
 confirm:async()=>{throw Error('不应调用')},withdraw:async()=>{throw Error('不应调用')},pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false,
}

// 假 call：只接受 role-memory/create，回一份与请求一致的合法 RoleMemory（满足 role-memory-api.ts 的自检）。
function makeFakeCall(){
 const calls:{endpoint:string;payload:any}[]=[]
 const call=async(endpoint:string,payload:any)=>{
  calls.push({endpoint,payload})
  if(endpoint!=='role-memory/create')throw Error('不该调用 role-memory/create 之外的端点：'+endpoint)
  const bytes=new TextEncoder().encode(payload.markdown).byteLength
  return {
   id:'99999999-9999-4999-8999-'+String(calls.length).padStart(12,'0'),ownerId:'local:owner',
   roleId:payload.roleId,roleVersion:payload.expectedRoleVersion,title:payload.title,state:'candidate',stateVersion:1,
   source:payload.source,sourceTitle:habitDetail.title,sourceAvailable:true,visibility:payload.visibility,proposedBy:{kind:'self'},
   content:{version:1,contentHash:'a'.repeat(64),bytes,markdown:payload.markdown,createdAt:habitDetail.createdAt},
   candidateAt:habitDetail.createdAt,confirmedAt:null,withdrawnAt:null,
  }
 }
 return {calls,call}
}

test('「记下来」按钮存在，提交调用 role-memory/create（而非任何新端点），载荷含 source.kind=habit-digest 与私有可见性',async()=>{
 const {calls,call}=makeFakeCall()
 const memoryApi=createRoleMemoryApi(call as never)
 // 与 TeamPage.tsx 的 promoteHabit 同一契约：roleId/expectedRoleVersion 取自岗位，source 恒 habit-digest+日志 id+版本 1，visibility 恒私有。
 const promote=async(log:{id:string},value:{title:string;markdown:string})=>{
  await memoryApi.create({roleId:panelRoleId,expectedRoleVersion:3,title:value.title,markdown:value.markdown,source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}})
 }
 const app=mountPanel({roleId:panelRoleId,kind:'habit-digest',api:habitApi,memoryApi:emptyMemoryApi,promote})
 await app.flush()
 // 选中唯一一条日志，进入详情。
 app.find(el=>el.type==='button'&&typeof el.props.onClick==='function'&&app.contentOf(el).includes('今日习惯观察')).props.onClick()
 await app.flush()
 const submit=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote'))
 await submit.props.onClick()
 await app.flush()
 assert.equal(calls.length,1)
 assert.equal(calls[0]!.endpoint,'role-memory/create')
 assert.deepEqual(calls[0]!.payload.source,{kind:'habit-digest',id:habitLogId,version:1})
 assert.deepEqual(calls[0]!.payload.visibility,{kind:'private',scopeIds:[]})
 assert.equal(calls[0]!.payload.roleId,panelRoleId)
})

test('一份观察最多记 3 条：说明文案 habitLog.promoteLimit 常驻，第 3 次提交后按钮 disabled（客户端先一步防呆，不必等服务端拒绝才提示）',async()=>{
 const {calls,call}=makeFakeCall()
 const memoryApi=createRoleMemoryApi(call as never)
 const promote=async(log:{id:string},value:{title:string;markdown:string})=>{
  await memoryApi.create({roleId:panelRoleId,expectedRoleVersion:3,title:value.title,markdown:value.markdown,source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}})
 }
 const app=mountPanel({roleId:panelRoleId,kind:'habit-digest',api:habitApi,memoryApi:emptyMemoryApi,promote})
 await app.flush()
 app.find(el=>typeof el.props.onClick==='function'&&app.contentOf(el).includes('今日习惯观察')).props.onClick()
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===zh('habitLog.promoteLimit')).length>=1,'限额说明应在表单区常驻出现')
 for(let round=0;round<3;round++){
  const submit=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote'))
  await submit.props.onClick()
  await app.flush()
 }
 assert.equal(calls.length,3)
 const submitAfterThree=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote'))
 assert.equal(submitAfterThree.props.disabled,true,'第 3 次成功后应禁止继续提交，不发出第 4 次请求')
})

test('刷新后已满 3 条仍禁用：上限判据按 memories 里 source.kind=habit-digest 且 source.id=当前日志 反推，不依赖会话内的本地计数（修复轮 1 M2）',async()=>{
 // 全新 mount，本地 promoteCount 从 0 开始；但 memoryApi.list 已经回了 3 条属于这份日志的历史记忆——
 // 模拟「刷新页面后重新拉取」的场景，按服务端 role-memory.ts 同一口径判定已经记满。
 const app=mountPanel({roleId:panelRoleId,kind:'habit-digest',api:habitApi,memoryApi:threeHabitMemoriesApi,promote:async()=>{throw Error('不应调用：应在提交前就被 disabled 挡住')}})
 await app.flush()
 app.find(el=>typeof el.props.onClick==='function'&&app.contentOf(el).includes('今日习惯观察')).props.onClick()
 await app.flush()
 const submit=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('habitLog.promote'))
 assert.equal(submit.props.disabled,true,'刷新后已取到的 3 条历史记忆应直接让按钮 disabled，不必等本地再提交 3 次')
})

test('丢弃按钮文案按 kind 分支：habit-digest 读 habitLog.discard「丢弃这份观察」，daily-digest 仍读 dailyLog.discard「丢弃这份日志」（修复轮 1 H1）',async()=>{
 const habitApp=mountPanel({roleId:panelRoleId,kind:'habit-digest',api:habitApi,memoryApi:emptyMemoryApi})
 await habitApp.flush()
 habitApp.find(el=>typeof el.props.onClick==='function'&&habitApp.contentOf(el).includes('今日习惯观察')).props.onClick()
 await habitApp.flush()
 assert.equal(habitApp.findAll(el=>el.type==='button'&&habitApp.contentOf(el)===zh('habitLog.discard')).length,1,'习惯观察页应出现「丢弃这份观察」')
 assert.equal(habitApp.findAll(el=>el.type==='button'&&habitApp.contentOf(el)===zh('dailyLog.discard')).length,0,'习惯观察页不该再出现「丢弃这份日志」')

 const dailyApp=mountPanel({roleId:panelRoleId,kind:'daily-digest',api:dailyApi,memoryApi:emptyMemoryApi})
 await dailyApp.flush()
 dailyApp.find(el=>typeof el.props.onClick==='function'&&dailyApp.contentOf(el).includes('今日小结')).props.onClick()
 await dailyApp.flush()
 assert.equal(dailyApp.findAll(el=>el.type==='button'&&dailyApp.contentOf(el)===zh('dailyLog.discard')).length,1,'员工工作日志页应仍读「丢弃这份日志」（回归）')
 assert.equal(dailyApp.findAll(el=>el.type==='button'&&dailyApp.contentOf(el)===zh('habitLog.discard')).length,0,'员工工作日志页不该出现「丢弃这份观察」')
})

test('分身「记下来」折叠行的 summary 用 habitLog.promoteFold，已有 3 条 habit-digest 记忆时直接是已满态',async()=>{
 const app=mountPanel({roleId:panelRoleId,kind:'habit-digest',api:habitApi,memoryApi:threeHabitMemoriesApi,promote:async()=>{}})
 await app.flush()
 app.find(el=>typeof el.props.onClick==='function'&&app.contentOf(el).includes('今日习惯观察')).props.onClick()
 await app.flush()
 const summary=app.find(el=>el.type==='summary'&&app.contentOf(el)===zh('habitLog.promoteLimit'))
 assert.equal(app.contentOf(summary),zh('habitLog.promoteLimit'))
 assert.equal(summary.props['aria-disabled'],true)
})
