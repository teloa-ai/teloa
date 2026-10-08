import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {applicationProductName} from '../src/client/application-presentation.ts'

const root=new URL('../src/client/',import.meta.url)

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)
 ?[node as Node,...(node as Node).children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]
 :[]
const text=(node:unknown):string=>typeof node==='string'?node:typeof node==='number'?String(node):node&&typeof node==='object'?((node as Node).children??[]).map(text).join(''):''
const buttons=(view:Node)=>nodes(view).filter(node=>node.type==='button')

/**
 * 把 WorkNavigation 转译进测试进程执行：与 `personal-space-surfaces.test.ts` 同一手法，
 * 只是多补两样——`useSyncExternalStore`（左栏读会话目录、管理态与本人资料）与一个真的
 * `useEffect`（新建菜单的焦点、外部点击和 Escape 收起）与左栏目录数据读取。
 * 返回的 `render` 支持传入 props 补丁，补丁会并入之后每一次渲染，模拟父组件重渲染传新 prop。
 */
function mount(file:string,initialProps:Record<string,unknown>){
 const source=readFileSync(new URL(file,root),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const effects:{deps?:unknown[]|undefined}[]=[];let effectCursor=0
 const sharedComponents=new Set<unknown>()
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[]):any=>sharedComponents.has(type)?(type as (props:unknown)=>unknown)({...props,children}):({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:(effect:()=>void|(()=>void),deps?:unknown[])=>{
   const index=effectCursor++
   const previous=effects[index]
   const changed=!previous||!deps||!previous.deps||deps.length!==previous.deps.length||deps.some((value,position)=>!Object.is(value,previous.deps![position]))
   effects[index]={deps}
   if(changed)effect()
  },
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
 }
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id.endsWith('WorkbenchNavigationChrome.js')){
   const sharedSource=readFileSync(new URL('WorkbenchNavigationChrome.tsx',root),'utf8')
   const sharedJs=ts.transpileModule(sharedSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
   const shared:Record<string,any>={}
   new Function('require','exports','React',sharedJs)(require,shared,React)
   sharedComponents.add(shared.WorkbenchNavigationBrand);sharedComponents.add(shared.WorkbenchNavigationItems)
   return shared
  }
  if(id.endsWith('use-personal-profile.js'))return {usePersonalProfile:()=>({displayName:'Max',initials:'M'})}
  if(id.endsWith('application-presentation.js'))return {applicationProductName,applicationPresentation:{subscribe:()=>()=>{},getSnapshot:()=>({product:'Free',account:null}),getExecutionPlacement:()=>'user-selected'}}
  if(id.endsWith('provider.js'))return {useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key})}
  if(id.endsWith('errors.js'))return {localizeWorkError:(_:string,value:unknown)=>String(value)}
  if(id.endsWith('work-presentation.js'))return {presentConversations:()=>[]}
  if(id.endsWith('recent-work-hidden.js'))return {browserRecentWorkHiddenStore:()=>({read:()=>[],hide:()=>{}})}
  if(id.endsWith('.css')||id.endsWith('.svg'))return {default:cssProxy}
  return new Proxy({default:cssProxy},{get:(_,key)=>key==='default'?cssProxy:()=>'none'})
 }
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 const name=file.replace(/\.tsx$/,'').split('/').at(-1)!
 let currentProps={...initialProps}
 return (patch?:Record<string,unknown>)=>{
  if(patch)currentProps={...currentProps,...patch}
  cursor=0;effectCursor=0
  return exports[name](currentProps) as Node
 }
}

const baseProps={
 view:'home' as const,
 colorScheme:'light' as const,
 actions:new Proxy({},{get:()=>()=>{}}) as never,
 work:{subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows:[],status:'ready',error:undefined}),getSnapshot:()=>({sessionId:undefined}),openConversation:async()=>{}},
 management:{subscribe:()=>()=>{},getSnapshot:()=>({baseline:true,archived:[],ready:true})},
 useSessions:(selector:(value:{byId:Record<string,unknown>;current:string|undefined})=>unknown)=>selector({byId:{},current:undefined}),
 create:()=>{},
 creating:false,
 needCount:0,
 openTwin:async()=>{},
 setTheme:()=>{},
}

test('左栏静态渲染不含「我的工作空间」「切换工作空间」，含「我的分身」按钮',()=>{
 const render=mount('WorkNavigation.tsx',baseProps)
 const view=render()
 const html=text(view)
 assert.ok(!html.includes('我的工作空间'),'个人版左栏不应再出现空间字样')
 assert.ok(!html.includes('切换工作空间'),'切换箭头连同空间入口一起被删掉了')
 // 翻译桩把没有插值的 key 原样返回，account 区的按钮就是 navigation.twin 这个 key 本身。
 const twin=buttons(view).find(button=>text(button)==='navigation.twin')
 assert.ok(twin,'账号块下必须有一个「我的分身」入口')
})

test('点「我的分身」调用由主框架提供的直接会话入口',()=>{
 const opened:number[]=[]
 const render=mount('WorkNavigation.tsx',{...baseProps,openTwin:async()=>{opened.push(1)}})
 const view=render()
 const twin=buttons(view).find(button=>text(button)==='navigation.twin')!
 twin.props.onClick()
 assert.deepEqual(opened,[1])
})

test('同一帧内连续点击「我的分身」只发起一次打开',()=>{
 const opened:number[]=[]
 let finish:()=>void=()=>{}
 const pending=new Promise<void>(resolve=>{finish=resolve})
 const render=mount('WorkNavigation.tsx',{...baseProps,openTwin:()=>{opened.push(1);return pending}})
 const twin=buttons(render()).find(button=>text(button)==='navigation.twin')!
 twin.props.onClick();twin.props.onClick()
 assert.deepEqual(opened,[1])
 finish()
})

test('左栏市场入口总是回到市场目录，不沿用上一条资源详情',()=>{
 const opened:number[]=[]
 const actions=new Proxy({},{get:(_,key)=>key==='openMarket'?()=>opened.push(1):()=>{}})
 const render=mount('WorkNavigation.tsx',{...baseProps,actions})
 const market=buttons(render()).find(button=>text(button)==='navigation.v2.market')!
 market.props.onClick()
 assert.deepEqual(opened,[1])
})

test('左栏自动化入口总是回到计划目录，不沿用上一次计划或执行详情',()=>{
 const opened:unknown[]=[]
 const actions=new Proxy({},{get:(_,key)=>key==='openPlans'?(target:unknown)=>opened.push(target):()=>{}})
 const render=mount('WorkNavigation.tsx',{...baseProps,actions,view:'plans'})
 const plans=buttons(render()).find(button=>text(button)==='navigation.plans')!
 plans.props.onClick()
  assert.deepEqual(opened,[{kind:'plans'}])
})

test('左栏对话入口打开统一目录根态，不直接落入当前原生会话',()=>{
 const opened:number[]=[]
 const actions=new Proxy({},{get:(_,key)=>key==='openConversationDirectory'?()=>opened.push(1):()=>{}})
 const render=mount('WorkNavigation.tsx',{...baseProps,actions,view:'messages'})
 const conversations=buttons(render()).find(button=>text(button)==='navigation.v2.conversations')!
 conversations.props.onClick()
 assert.deepEqual(opened,[1])
})
