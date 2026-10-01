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
 * 功能验证（同事上网一期）：同事「能力」页上网两项授权、运行详情上网记录节、设置里的上网节、
 * 分身页一句说明——四处界面都要跑真实组件函数才能核对交互（勾选、保存回传、草稿跨挂载存活），
 * 手法与 role-daily-log-panel.test.ts 一致：`ts.transpileModule` 把源码转成 CommonJS，
 * 用一份手写的 hooks 调度器驱动 useState/useEffect/useRef/useId/useSyncExternalStore。
 *
 * 与该文件不同的是这里要跑四个不同组件，于是把「加载一个纯逻辑依赖模块」（跨 mount 共享缓存，
 * 因为它们本来就是无状态的纯函数，`web-access-drafts.ts` 的模块级单例还必须共享，
 * 「卸载再重挂草稿仍在」才有意义验证）与「加载一个入口组件」（每次 mount 都拿一份全新的 hooks，
 * 互不串状态）拆成两层。
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
// __esModule:true 让 tsc esModuleInterop 的 __importDefault helper 原样放行，不再套一层 {default:...}
// （否则 clsx_1.default 会拿到 {default:fn} 而不是 fn 本身，css 默认导入同理）。
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

/** 'react'/'clsx'/'lucide-react'/'*.module.css'/i18n 的 provider 与 errors/'@teloa/contract' 六类特判，两层加载器共用。 */
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

// 纯逻辑依赖模块（role-tool-grant-presentation.ts、task-run-*.ts、web-access-drafts.ts、
// team-presentation.ts、TwinDraftEditor.tsx）跨 mount 共享一份缓存：它们本来就无状态，
// `web-access-drafts.ts` 的模块级单例更是必须共享，「卸载重挂草稿仍在」才有意义验证。
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
const webAccessDrafts=loadPure(join(clientDir,'web-access-drafts.ts')).webAccessDrafts

/** 每次 mount 都新建一份 hooks：入口组件文件本身不缓存，避免不同测试串状态。 */
function mountComponent(relFile:string,exportName:string,props:any){
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks:any={...React,
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initialValue:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initialValue})},
  useId:()=>{const index=cursor++;if(!(index in slots))slots[index]='test-id-'+index;return slots[index]},
  // 测试驱动是「动作后手动 render()/flush()」，不需要真订阅：每次 render 都会重新调用 getSnapshot()。
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
  wholeContent:()=>contentOf(render()),
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

// ── RoleToolGrants：同事「能力」页的「上网」一节 ──────────────────────────────
const roleId='11111111-1111-4111-8111-111111111111'
const pausedEmployee=(overrides:any={}):any=>({id:roleId,name:'客服同事',kind:'employee',state:'paused',scopes:['general'],version:5,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[],...overrides})
const resources={directory:async()=>({resources:[]})}
function makeGrantApi(overrides:any={}):any{
 return {
  pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false,
  recover:async()=>{throw Error('未使用')},
  get:async()=>({roleVersion:5,grant:null}),
  candidates:async()=>({roleVersion:5,rules:[]}),
  change:async(value:any)=>({roleId:value.roleId,roleVersion:value.expectedRoleVersion+1,state:value.action==='save'?'active':'revoked',rules:value.rules,createdAt:'2026-09-21T00:00:00.000Z'}),
  ...overrides,
 }
}

test('上网两项独立勾选默认都不勾；勾选后保存只回传那一条 anyArguments 规则；已授权态清单显示「搜索网页」而非空白',async()=>{
 const changeCalls:any[]=[]
 const api=makeGrantApi({
  get:async()=>({roleVersion:5,grant:{roleId,roleVersion:5,state:'active',rules:[{name:'web_search',allowed:[],anyArguments:true}],createdAt:'2026-09-20T00:00:00.000Z'}}),
  candidates:async()=>({roleVersion:5,rules:[{name:'web_search',allowed:[],anyArguments:true},{name:'web_fetch',allowed:[],anyArguments:true}]}),
  change:async(value:any)=>{changeCalls.push(value);return {roleId:value.roleId,roleVersion:6,state:'active',rules:value.rules,createdAt:'2026-09-21T00:00:00.000Z'}},
 })
 const app=mountComponent('RoleToolGrants.tsx','RoleToolGrants',{role:pausedEmployee(),api,resources,changed:()=>{}})
 await app.flush()
 assert.ok(app.find(el=>el.type==='li'&&app.contentOf(el)===zh('roleGrant.web.search')),'已授权清单应显示「搜索网页」而不是空白')
 const searchLabel=app.find(el=>el.type==='label'&&app.contentOf(el).includes(zh('roleGrant.web.search'))&&app.contentOf(el).includes(zh('roleGrant.web.searchHint')))
 const searchInput=searchLabel.props.children[0]
 assert.equal(searchInput.props.checked,false,'搜索网页默认不勾')
 const fetchLabel=app.find(el=>el.type==='label'&&app.contentOf(el).includes(zh('roleGrant.web.fetch'))&&app.contentOf(el).includes(zh('roleGrant.web.fetchHint')))
 assert.equal(fetchLabel.props.children[0].props.checked,false,'打开网页默认不勾')
 searchInput.props.onChange({target:{checked:true}})
 app.render()
 const saveButton=app.find(el=>el.type==='button'&&app.contentOf(el)===zh('roleGrant.save'))
 await saveButton.props.onClick()
 await app.flush()
 assert.equal(changeCalls.length,1)
 assert.deepEqual(changeCalls[0].rules,[{name:'web_search',allowed:[],anyArguments:true}])
})

test('总开关关闭时（候选没有 web 规则）整节显示 disabledByGlobal，且不渲染任何勾选项',async()=>{
 const api=makeGrantApi({candidates:async()=>({roleVersion:5,rules:[]})})
 const app=mountComponent('RoleToolGrants.tsx','RoleToolGrants',{role:pausedEmployee(),api,resources,changed:()=>{}})
 await app.flush()
 assert.ok(app.find(el=>el.type==='p'&&app.contentOf(el)===zh('roleGrant.web.disabledByGlobal')))
 assert.equal(app.findAll(el=>el.type==='input'&&el.props.type==='checkbox').length,0,'总开关关闭时不应渲染任何上网勾选项')
})

/**
 * 「已勾选态不丢」这条红线不能靠「点刷新→候选变了→再点刷新→还勾着」去实测：`RoleToolGrants.tsx`
 * 里唯一能换出新候选的路径是 `role.id`/`role.version`/`revision`/`locale` 变化触发的那个 `useEffect`
 * （既有代码、本任务未改），它一进门就 `setSelected([])`——这是给所有候选（资料/子任务拆分/上网）
 * 共用的既有重置，不是本任务能改的范围。真正可核的红线是：本任务新增的上网 fieldset 本身不得再加一层
 * 「候选没有 web 规则时把 selected 里的 web 键摘掉」的清空逻辑——即"不丢"只保证在同一份候选快照内
 * 有效，靠源码里没有额外的 setSelected 调用来核实，而不是跨候选快照断言。
 */
test('上网候选消失时新增的 fieldset 不额外清空 selected（不丢的红线只在源码层面新增一次 setSelected 调用）',()=>{
 const source=readFileSync(join(clientDir,'RoleToolGrants.tsx'),'utf8')
 const setSelectedCalls=source.match(/setSelected\(/g)??[]
 assert.equal(setSelectedCalls.length,2,'setSelected 应仍只有既有 mount effect 的重置与 toggle 里的更新两处，上网 fieldset 不得新增第三处清空')
})

test('同事未暂停时只显示 roleGrant.pauseHint，没有可勾选项（既有行为不变）',async()=>{
 const api=makeGrantApi({candidates:async()=>({roleVersion:5,rules:[{name:'web_search',allowed:[],anyArguments:true},{name:'web_fetch',allowed:[],anyArguments:true}]})})
 const app=mountComponent('RoleToolGrants.tsx','RoleToolGrants',{role:pausedEmployee({state:'active'}),api,resources,changed:()=>{}})
 await app.flush()
 assert.ok(app.wholeContent().includes(zh('roleGrant.pauseHint')))
 assert.ok(!app.wholeContent().includes(zh('roleGrant.web.title')))
 assert.equal(app.findAll(el=>el.type==='input'&&el.props.type==='checkbox').length,0)
})

// ── TaskExecutions：运行详情「本次运行上网记录」节 ──────────────────────────────
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
 roleName:'客服同事',
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
const runProps=(row:any):any=>({taskId:row.taskId,taskVersion:1,taskState:'ready',assigned:true,api:makeRunApi([row]),open:async()=>{},changed:()=>{}})

test('运行详情「本次运行上网记录」节：两条记录按 at 升序展示，fetch 行的 URL 是纯文本（全树零 <a>），有复制按钮',async()=>{
 const row=runFixture({webAccess:[
  {kind:'fetch',value:'https://b.example/path',at:'2026-09-20T10:00:02.000Z'},
  {kind:'search',value:'["天气预报"]',at:'2026-09-20T10:00:01.000Z'},
 ]})
 const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row))
 await app.flush()
 assert.ok(app.find(el=>el.type==='summary'&&app.contentOf(el)===zh('webAccess.run.title')))
 const items=app.findAll(el=>el.type==='li'&&(app.contentOf(el).includes(zh('webAccess.run.search'))||app.contentOf(el).includes(zh('webAccess.run.fetch'))))
 assert.equal(items.length,2)
 assert.ok(app.contentOf(items[0]!).includes(zh('webAccess.run.search')),'较早的 search 记录应排在前面')
 assert.ok(app.contentOf(items[0]!).includes('天气预报'))
 assert.ok(app.contentOf(items[1]!).includes(zh('webAccess.run.fetch')))
 assert.ok(app.contentOf(items[1]!).includes('https://b.example/path'),'fetch 行的 URL 应逐字出现在纯文本里')
 assert.equal(app.findAll(el=>el.type==='a').length,0,'fetch 行不得渲染成 <a>（全树零 <a>）')
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el)===zh('webAccess.run.copy')).length,2)
})

test('row.webAccess 为空数组或缺键时，「本次运行上网记录」节不出现',async()=>{
 for(const row of [runFixture({webAccess:[]}),runFixture({id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'})]){
  const app=mountComponent('TaskExecutions.tsx','TaskExecutions',runProps(row))
  await app.flush()
  assert.equal(app.findAll(el=>el.type==='summary'&&app.contentOf(el)===zh('webAccess.run.title')).length,0)
 }
})

// ── WebAccessSettings：设置里的「上网」一节 ──────────────────────────────
function makeWebAccessApi(overrides:any={}):any{
 return {
  pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>false,
  recover:async()=>{throw Error('未使用')},
  get:async()=>({version:1,enabled:false,blocked:['old.example.com']}),
  change:async(value:any)=>({version:value.expectedVersion+1,enabled:value.enabled,blocked:value.blocked}),
  ...overrides,
 }
}

test('设置里的「上网」一节：不合法拦截名单当场拒绝且不提交；合法输入进草稿；卸载重挂草稿仍在；保存成功后草稿改写为已保存态',async()=>{
 webAccessDrafts.clear()
 const changeCalls:any[]=[]
 const api=makeWebAccessApi({change:async(value:any)=>{changeCalls.push(value);return {version:value.expectedVersion+1,enabled:value.enabled,blocked:value.blocked}}})
 const app=mountComponent('WebAccessSettings.tsx','WebAccessSettings',{api})
 await app.flush()
 assert.equal(app.find(el=>el.type==='input'&&el.props.type==='checkbox').props.checked,false,'总开关默认按服务端返回值渲染，本例为关')
 assert.ok(app.wholeContent().includes('old.example.com'))
 assert.ok(app.wholeContent().includes(zh('webAccess.settings.disclosure')))

 // 不合法输入：当场拒绝，不调用 change
 let addInput=app.find(el=>el.type==='input'&&el.props['aria-label']===zh('webAccess.settings.blockTitle'))
 addInput.props.onChange({target:{value:'http://bad.example'}})
 app.render()
 let addForm=app.find(el=>el.type==='form')
 addForm.props.onSubmit({preventDefault:()=>{}})
 app.render()
 assert.ok(app.wholeContent().includes(zh('webAccess.settings.blockInvalid')))
 assert.equal(changeCalls.length,0)

 // 合法输入进草稿（还不提交）
 addInput=app.find(el=>el.type==='input'&&el.props['aria-label']===zh('webAccess.settings.blockTitle'))
 addInput.props.onChange({target:{value:'good.example.com'}})
 app.render()
 addForm=app.find(el=>el.type==='form')
 addForm.props.onSubmit({preventDefault:()=>{}})
 app.render()
 assert.ok(app.wholeContent().includes('good.example.com'))
 assert.equal(changeCalls.length,0,'加入拦截名单只落草稿，不应提交')

 // 卸载再重挂：新开一个 mount，读同一个跨挂载单例（教训 c 的界面层锚）
 const remounted=mountComponent('WebAccessSettings.tsx','WebAccessSettings',{api})
 await remounted.flush()
 assert.ok(remounted.wholeContent().includes('good.example.com'),'卸载重挂后草稿应保留')

 // 保存成功后草稿改写为已保存态，不再清空回落成空态
 const saveButton=remounted.find(el=>el.type==='button'&&remounted.contentOf(el)===zh('roleGrant.save'))
 await saveButton.props.onClick()
 await remounted.flush()
 assert.equal(changeCalls.length,1)
 assert.deepEqual(changeCalls[0].blocked,['old.example.com','good.example.com'])
 assert.deepEqual(webAccessDrafts.read(),{enabled:false,blocked:['old.example.com','good.example.com'],input:''},'保存成功后草稿应改写为刚保存的值，不是 undefined')
 // 保存成功后立即读界面：总开关与名单显示为刚保存的值，不出现总开关关闭、名单清空的错误展示态
 assert.equal(remounted.find(el=>el.type==='input'&&el.props.type==='checkbox').props.checked,false,'刚保存的 enabled 值就是 false，界面应仍显示 false 而非误判为「回落」')
 assert.ok(remounted.wholeContent().includes('old.example.com')&&remounted.wholeContent().includes('good.example.com'),'保存成功后名单应立即显示刚保存的两项，而不是短暂清空')
})

test('保存撞版本冲突后自动取回最新 version，第二次保存不再撞；草稿一个字不丢',async()=>{
 webAccessDrafts.clear()
 const changeCalls:any[]=[],getCalls:number[]=[]
 let serverVersion=1
 const api=makeWebAccessApi({
  get:async()=>{getCalls.push(serverVersion);return {version:serverVersion,enabled:false,blocked:['old.example.com']}},
  change:async(value:any)=>{
   changeCalls.push(value)
   // 本人在别的地方先改了一次：第一次保存必撞冲突，第二次按刷新后的版本才过。
   if(value.expectedVersion!==serverVersion)throw Object.assign(Error('这个版本已过期，请刷新后重试。'),{code:'teloa/version-conflict'})
   serverVersion+=1
   return {version:serverVersion,enabled:value.enabled,blocked:value.blocked}
  },
 })
 const app=mountComponent('WebAccessSettings.tsx','WebAccessSettings',{api})
 await app.flush()
 const addInput=app.find(el=>el.type==='input'&&el.props['aria-label']===zh('webAccess.settings.blockTitle'))
 addInput.props.onChange({target:{value:'good.example.com'}})
 app.render()
 app.find(el=>el.type==='form').props.onSubmit({preventDefault:()=>{}})
 app.render()
 serverVersion=7                                   // 别处改过：组件手里的 version=1 已过期
 const save=()=>app.find(el=>el.type==='button'&&app.contentOf(el)===zh('roleGrant.save'))
 await save().props.onClick()
 await app.flush()
 assert.equal(changeCalls.length,1)
 assert.equal(changeCalls[0].expectedVersion,1)
 assert.ok(app.wholeContent().includes('这个版本已过期，请刷新后重试。'),'失败文案照旧显示')
 assert.ok(app.wholeContent().includes('good.example.com'),'失败不得丢草稿')
 assert.equal(getCalls.length,2,'保存失败后必须再取一次读口刷新 version')
 // 第二次保存：按刷新后的版本提交，不再撞同一堵墙。
 await save().props.onClick()
 await app.flush()
 assert.equal(changeCalls.length,2)
 assert.equal(changeCalls[1].expectedVersion,7,'第二次保存必须用刷新后的 version')
 assert.deepEqual(changeCalls[1].blocked,['old.example.com','good.example.com'])
 assert.deepEqual(webAccessDrafts.read(),{enabled:false,blocked:['old.example.com','good.example.com'],input:''},'保存成功后草稿应改写为刚保存的值，不是 undefined')
})

// ── TwinProfile：分身页一句说明 ──────────────────────────────
const twinRole=(overrides:any={}):any=>({id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',name:'Max',kind:'twin',state:'active',scopes:['general'],version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[],...overrides})

test('分身页出现 roleGrant.web.twinNote 说明，且整页没有任何可勾选项',async()=>{
 const app=mountComponent('TwinProfile.tsx','TwinProfile',{
  profileName:'Max',role:twinRole(),draft:undefined,update:()=>{},save:()=>true,
  talk:undefined,talkDisabledReason:undefined,conversations:null,samples:null,habits:undefined,
 })
 await app.flush()
 assert.ok(app.wholeContent().includes(zh('roleGrant.web.twinNote')))
 assert.equal(app.findAll(el=>el.type==='input'&&el.props.type==='checkbox').length,0,'分身页不加任何可勾选项')
})

// ── 全局纪律：零 dangerouslySetInnerHTML；新增 CSS 只用 --teloa- 令牌且窄屏不溢出 ──────────────────────────────
test('四个改动文件源码不使用 dangerouslySetInnerHTML',()=>{
 for(const file of ['RoleToolGrants.tsx','TaskExecutions.tsx','WebAccessSettings.tsx','TwinProfile.tsx']){
  const source=readFileSync(join(clientDir,file),'utf8')
  assert.doesNotMatch(source,/dangerouslySetInnerHTML/,file+' 不应使用 dangerouslySetInnerHTML')
 }
})

test('WebAccessSettings.module.css 只用 --teloa- 令牌，390 与 1440 视口下单列且不因固定宽度溢出',()=>{
 const css=readFileSync(join(clientDir,'WebAccessSettings.module.css'),'utf8')
 const customProps=[...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map(match=>match[1]!)
 assert.ok(customProps.length>0)
 assert.ok(customProps.every(name=>name.startsWith('--teloa-')),'只能使用 --teloa-*/--teloa-design-* 令牌：'+customProps.filter(name=>!name.startsWith('--teloa-')).join('、'))
 // 排除 min-width/max-width：max-width:760px 是宽屏下的阅读上限（WorkspaceSettings.module.css 同款），
 // 本身随视口收窄不会溢出；真正会在窄屏溢出的是裸的 width:。
 assert.doesNotMatch(css,/(?<![a-z-])width:\s*[4-9]\d{2,}px/,'不应写死超过 390px 视口会溢出的固定宽度')
 assert.match(css,/@media\(max-width:700px\)/,'需要窄屏断点让新增一行网站与保存区变成单列')
 assert.match(css,/min-width:0/,'flex 容器需要 min-width:0 才不会把窄屏撑破')
 assert.match(css,/overflow-wrap:anywhere/,'长网址/主机名需要 overflow-wrap 兜底')
})
