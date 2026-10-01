import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname,join,resolve as resolvePath} from 'node:path'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import * as React from 'react'
import * as contract from '@teloa/contract'

/**
 * 任务页重做 功能验证：执行记录/结项/任务知识/跳过与执行历史五个既有子组件改为「内容面」——
 * 只加可选 prop `face` 与只读回调 `onRuns/onRecord/onMaterials/onPage`，读写口一字不动。
 * 渲染手法与 web-access-view.test.ts 一致（`ts.transpileModule` + 手写 hooks 调度器），
 * 这里把 helper 抄成本文件私有函数，不动那份测试。
 */

registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)

const clientDir=fileURLToPath(new URL('../src/client/',import.meta.url))
const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
const iconsProxy=new Proxy({},{get:()=>(()=>null)})
const clsxModule={__esModule:true,default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
const i18nProviderModule={useI18n:()=>({t:zh,locale:'zh-CN',dateTime:(value:string)=>String(value).slice(0,10)})}
const i18nErrorsModule={localizeWorkError:(_locale:string,cause:unknown)=>cause instanceof Error?cause.message:String(cause)}

function transpile(absPath:string):string{
 const source=readFileSync(absPath,'utf8')
 return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText
}

function resolveSibling(fromAbsPath:string,specifier:string):string{
 const withoutExt=specifier.replace(/\.js$/,'')
 const base=resolvePath(dirname(fromAbsPath),withoutExt)
 for(const ext of ['.ts','.tsx'])if(existsSync(base+ext))return base+ext
 throw Error('resolve 失败：'+specifier+'（from '+fromAbsPath+'）')
}

function specialCase(id:string,reactBinding:unknown):unknown{
 if(id==='react')return reactBinding
 if(id==='clsx')return clsxModule
 if(id==='lucide-react')return iconsProxy
 if(id.endsWith('.module.css'))return {default:cssProxy}
 if(id.endsWith('i18n/provider.js'))return i18nProviderModule
 if(id.endsWith('i18n/errors.js'))return i18nErrorsModule
 if(id==='@teloa/contract')return contract
 return undefined
}

const pureCache=new Map<string,any>()
function loadPure(absPath:string):any{
 if(pureCache.has(absPath))return pureCache.get(absPath)
 const moduleObj={exports:{} as any}
 pureCache.set(absPath,moduleObj.exports)
 const req=(id:string):any=>{
  const special=specialCase(id,React)
  if(special!==undefined)return special
  if(id.startsWith('.'))return loadPure(resolveSibling(absPath,id))
  throw Error('未声明的共享依赖：'+id+'（from '+absPath+'）')
 }
 new Function('require','module','exports','React',transpile(absPath))(req,moduleObj,moduleObj.exports,React)
 pureCache.set(absPath,moduleObj.exports)
 return moduleObj.exports
}

/** 每次 mount 都新建一份 hooks：入口组件文件本身不缓存，避免不同测试串状态。 */
function mountComponent(relFile:string,exportName:string,props:any){
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks:any={...React,
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initialValue:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initialValue})},
  useId:()=>{const index=cursor++;if(!(index in slots))slots[index]='test-id-'+index;return slots[index]},
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{
   const index=cursor++,previous=effects.get(index)
   if(previous&&deps.every((value,depIndex)=>Object.is(value,previous.deps[depIndex])))return
   pending.push(()=>{previous?.cleanup?.();effects.set(index,{deps,cleanup:run()??undefined})})
  },
 }
 const absPath=join(clientDir,relFile)
 const req=(id:string):any=>{
  const special=specialCase(id,hooks)
  if(special!==undefined)return special
  if(id.startsWith('.'))return loadPure(resolveSibling(absPath,id))
  throw Error('未声明的组件依赖：'+id+'（from '+relFile+'）')
 }
 const moduleObj={exports:{} as any}
 new Function('require','module','exports','React',transpile(absPath))(req,moduleObj,moduleObj.exports,hooks)
 const Component=moduleObj.exports[exportName] as (value:unknown)=>React.ReactNode
 const render=():React.ReactNode=>{
  let guard=0
  do{assert.ok(guard++<20,'组件不应无限重渲染');dirty=false;cursor=0;pending=[];tree=Component(props);for(const run of pending)run()}while(dirty)
  return tree
 }
 const flush=async():Promise<React.ReactNode>=>{for(let round=0;round<8;round++){await Promise.resolve();render()}return tree}
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (value:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 const contentOf=(node:React.ReactNode):string=>{
  if(Array.isArray(node))return node.map(contentOf).join('')
  if(React.isValidElement<Record<string,any>>(node))return contentOf((node.props as {children?:React.ReactNode}).children)
  return typeof node==='string'||typeof node==='number'?String(node):''
 }
 return {
  render,flush,
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

// ── TaskExecutions 造法（与 web-access-view.test.ts 同形） ──────────────────────────────
const runFixture=(overrides:any={}):any=>({
 id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 taskId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 sessionId:'session-1',
 nativeRequestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 state:'ended',
 reason:'completed',
 stopRequestedAt:null,
 taskVersion:1,
 roleVersion:1,
 goal:'处理客户工单',
 roleName:'客服员工',
 createdAt:'2026-09-20T10:00:00.000Z',
 skills:[],
 knowledge:[],
 ...overrides,
})
function makeRunApi(rows:any[]):any{
 return {
  pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false,
  list:async()=>rows,
  prepare:async()=>{throw Error('未使用')},
  recoverPrepare:async()=>{throw Error('未使用')},
  discardPrepare:()=>{},
  withdraw:async(row:any)=>row,start:async(row:any)=>row,stop:async(row:any)=>row,reconcile:async(row:any)=>row,
  flow:async()=>null,
  recoverSubagent:async(row:any)=>row,
 }
}
const runProps=(row:any,extra:any={}):any=>({taskId:row.taskId,taskVersion:1,taskState:'ready',assigned:true,api:makeRunApi([row]),open:async()=>{},changed:()=>{},...extra})

test('运行首次读取失败后刷新成功仍向父级回传完整快照',async()=>{
 const row=runFixture(),received:any[][]=[]
 let listCalls=0
 const api={...makeRunApi([row]),list:async()=>{if(++listCalls===1)throw Error('首次读取失败');return [row]}}
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row,{api,face:'timeline',onRuns:(rows:any[],verified:boolean)=>{if(verified)received.push(rows)}}))
 await app.flush()
 assert.equal(received.length,0,'失败不能伪造空快照')
 app.find(el=>el.type==='button'&&app.contentOf(el)===zh('taskExecution.refresh')).props.onClick()
 await app.flush()
 assert.equal(listCalls,2)
 assert.deepEqual(received.at(-1),[row],'刷新成功必须同步父详情')
})

test('TaskExecutions face=timeline：onRuns 收到一条 run；无 <h3>；section.title 为 boundary 文案；准备按钮带 data-teloa-focus="prepare"',async()=>{
 const row=runFixture()
 const received:any[][]=[]
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row,{face:'timeline',onRuns:(rows:any[])=>{received.push(rows)}}))
 await app.flush()
 assert.ok(received.length>=1,'onRuns 应至少被调用一次')
 assert.equal(received[received.length-1]!.length,1,'最后一次 onRuns 应收到长度 1 的数组')
 assert.equal(received[received.length-1]![0].id,row.id)
 assert.equal(app.findAll(el=>el.type==='h3').length,0,'face=timeline 时不渲染 <h3>')
 const section=app.find(el=>el.type==='section'&&el.props['aria-label']===zh('taskExecution.aria'))
 assert.equal(section.props.title,zh('taskExecution.boundary'),'boundary 说明改挂 section 的 title')
 assert.equal(app.findAll(el=>el.type==='p'&&app.contentOf(el)===zh('taskExecution.boundary')).length,0,'boundary 段落不再渲染')
 const prepare=app.find(el=>el.type==='button'&&el.props['data-teloa-focus']==='prepare')
 assert.equal(app.contentOf(prepare),zh('taskExecution.prepare'))
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el).includes(zh('taskExecution.refresh'))).length,1,'刷新按钮仍在')
})

test('TaskExecutions 不传 face：仍渲染 <h3> 标题（回归保护），不传 onRuns 也不报错',async()=>{
 const row=runFixture()
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row))
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='h3'&&app.contentOf(el)===zh('taskExecution.title')).length,1)
 assert.equal(app.findAll(el=>el.type==='p'&&app.contentOf(el)===zh('taskExecution.boundary')).length,1,'默认面仍渲染 boundary 段落')
})

// ── 源码断言：只读回调与导出键表 ──────────────────────────────
const read=(file:string)=>readFileSync(join(clientDir,file),'utf8')

test('TaskExecutions.tsx 导出 taskRunPhaseKeys/taskRunReasonKeys，模块内 phases/reasons 别名保留',()=>{
 const source=read('TaskExecutions.tsx')
 assert.match(source,/export \{taskRunPhaseKeys,taskRunReasonKeys\} from '\.\/task-run-presentation.js'/)
 assert.match(source,/const phases=taskRunPhaseKeys,reasons=taskRunReasonKeys/)
 assert.match(source,/onRunsRef\.current\?\.\(rows,loaded&&!busy&&!error\)/)
 assert.match(source,/face\?:'timeline'/)
})

test('TaskCompletion/TaskKnowledge/PlanSkipHistory/PlanExecutionHistory 只读回调落点',()=>{
 const completion=read('TaskCompletion.tsx')
 assert.match(completion,/useEffect\(\(\)=>\{onRecordRef\.current\?\.\(record\)\},\[record\]\)/,'结项记录以 latest-ref 镜像本地 record 状态上报')
 assert.match(completion,/face\?:'timeline'/)
 const knowledge=read('TaskKnowledge.tsx')
 assert.match(knowledge,/onMaterialsRef\.current\?\.\(rows\)/)
 assert.match(knowledge,/face\?:'rail'/)
 for(const file of ['PlanSkipHistory.tsx','PlanExecutionHistory.tsx']){
  const source=read(file)
  assert.match(source,/useEffect\(\(\)=>\{if\(page\)onPageRef\.current\?\.\(page\)\},\[page\]\)/,file)
  assert.doesNotMatch(source,/setState\([^\n]*onPage/,file+'：上报不得写在 setState 更新函数里')
  assert.match(source,/face\?:'timeline'/,file)
 }
})

// ── TaskCompletion：onRecord 镜像本地 record ──────────────────────────────
test('TaskCompletion 传 running 任务：onRecord 恰好收到一次 null（读写口 api.complete 未被触碰）',async()=>{
 const received:any[]=[]
 const task={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,updatedAt:'2026-09-20T10:00:00.000Z',state:'running',assigneeId:'self',storage:'persistent'}
 const api={list:async()=>[],read:async()=>{throw Error('running 态不应读结项记录')},complete:async()=>{throw Error('未使用')}}
 const app=mountComponent('TaskCompletion.tsx','TaskCompletion',{task,api,open:()=>{},face:'timeline',onRecord:(record:any)=>{received.push(record)}})
 await app.flush()
 assert.deepEqual(received,[null])
 assert.equal(app.findAll(el=>el.type==='h3').length,0)
 assert.equal(app.findAll(el=>el.type==='form').length,1,'结项表单仍在')
})

// ── PlanSkipHistory：首页与追加页都经同一 effect 上报 ──────────────────────────────
const skipPlanId='11111111-1111-4111-8111-111111111111',skipClaimId='22222222-2222-4222-8222-222222222222',skipTaskId='33333333-3333-4333-8333-333333333333'
const skipItem={planId:skipPlanId,planVersion:3,configVersion:2,occurrenceId:'2026-09-12T09:00[Asia/Singapore]',scheduledAt:'2026-09-12T01:00:00.000Z',skippedAt:'2026-09-12T01:00:02.000Z',reason:'previous-task-unfinished',blockingClaimId:skipClaimId,taskId:skipTaskId}
const skipOlder={...skipItem,configVersion:1,occurrenceId:'2026-09-12T08:00[Asia/Singapore]'}
test('PlanSkipHistory 两页：首页 onPage 收 1 条，点「加载更多」后再收一次且 items 为合并长度 2',async()=>{
 const received:any[]=[]
 const firstPage={items:[skipItem],cursor:{skippedAt:skipItem.skippedAt,configVersion:2,occurrenceId:skipItem.occurrenceId}},secondPage={items:[skipOlder]}
 const api={skips:async(_planId:string,_limit?:number,cursor?:unknown)=>cursor?secondPage:firstPage}
 const app=mountComponent('PlanSkipHistory.tsx','PlanSkipHistory',{planId:skipPlanId,planVersion:3,api,openTask:()=>{},face:'timeline',onPage:(page:any)=>{received.push(page)}})
 await app.flush()
 assert.equal(received.length,1)
 assert.equal(received[0].items.length,1)
 assert.equal(app.findAll(el=>el.type==='h3').length,0)
 const more=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('planSkip.loadMore'))
 more.props.onClick()
 await app.flush()
 assert.equal(received.length,2,'追加页合并后应再上报一次')
 assert.equal(received[1].items.length,2,'第二次上报 items 为合并长度')
 assert.equal(received[1].cursor,undefined)
})

test('五个内容面文件均无 dangerouslySetInnerHTML',()=>{
 for(const file of ['TaskExecutions.tsx','TaskCompletion.tsx','TaskKnowledge.tsx','PlanSkipHistory.tsx','PlanExecutionHistory.tsx'])assert.doesNotMatch(read(file),/dangerouslySetInnerHTML/,file)
})

test('任务页装配回传运行快照，并挂入时间线和属性内容面',()=>{
 const source=read('WorkbenchFrame.tsx')
 const executions=source.slice(source.indexOf('executions={(task,onRuns)=>'),source.indexOf('knowledge={task=>'))
 assert.match(executions,/TaskExecutions/)
 assert.match(executions,/onRuns=\{onRuns\} face="timeline"/)
 assert.match(source,/<TaskKnowledge[^>]+face="rail"[^>]+api=\{taskMaterialApi\}[^>]+resources=\{resourceApi\}/)
})

test('运行快照回传同状态下的原因变化与空列表，加载前不伪造已确认空快照',async()=>{
 const row=runFixture()
 let rows=[row],resolveList:((rows:any[])=>void)|undefined
 const api={...makeRunApi([]),list:()=>new Promise<any[]>(resolve=>{resolveList=resolve})}
 const received:any[][]=[]
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row,{api,face:'timeline',onRuns:(value:any[],verified:boolean)=>{if(verified)received.push(value)}}))
 app.render()
 assert.equal(received.length,0,'未加载的内容面不得清空父时间线而触发反复卸载')
 resolveList!(rows)
 await app.flush()
 assert.equal(received.length,1)
 assert.equal(received[0],rows)
 rows=[{...row,reason:'error',endedAt:'2026-09-21T01:00:00.000Z'}]
 app.find(el=>el.type==='button'&&app.contentOf(el)===zh('taskExecution.refresh')).props.onClick()
 resolveList!(rows)
 await app.flush()
 assert.equal(received.at(-1)![0].reason,'error')
 app.find(el=>el.type==='button'&&app.contentOf(el)===zh('taskExecution.refresh')).props.onClick()
 resolveList!([])
 await app.flush()
 assert.deepEqual(received.at(-1),[],'成功读取空列表也要同步给父级')
})

test('已读到空运行列表后，重新读取及刷新失败撤回已确认空状态',async()=>{
 const row=runFixture(),received:{rows:any[];verified:boolean}[]=[]
 let fail=false,resolveList:((rows:any[])=>void)|undefined
 const api={...makeRunApi([]),list:()=>fail?Promise.reject(Error('连接断开')):new Promise<any[]>(resolve=>{resolveList=resolve})}
 const props=runProps(row,{api,face:'timeline',onRuns:(rows:any[],verified:boolean)=>received.push({rows,verified})})
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',props)
 app.render();resolveList!([]);await app.flush()
 assert.equal(received.at(-1)!.verified,true)
 props.taskState='running';app.render()
 assert.equal(received.at(-1)!.verified,false,'重读期间不得说没有执行')
 resolveList!([]);await app.flush()
 assert.equal(received.at(-1)!.verified,true)
 fail=true
 app.find(el=>el.type==='button'&&app.contentOf(el)===zh('taskExecution.refresh')).props.onClick()
 await app.flush()
 assert.equal(received.at(-1)!.verified,false,'失败必须撤销已确认空状态')
})
