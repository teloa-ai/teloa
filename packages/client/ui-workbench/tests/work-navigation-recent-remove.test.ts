import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import type {Conversation} from '@teloa/contract'
import {presentConversations} from '../src/client/work-presentation.ts'
import {createRecentWorkHiddenStore,type RecentWorkHiddenStore} from '../src/client/recent-work-hidden.ts'

const root=new URL('../src/client/',import.meta.url)

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)
 ?[node as Node,...(node as Node).children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]
 :[]
const textOf=(node:unknown):string=>typeof node==='string'?node
 :Array.isArray(node)?node.map(textOf).join('')
 :node&&typeof node==='object'&&'children' in (node as Node)?textOf((node as Node).children)
 :''

/** 内存版 localStorage：两次独立 `mount()`（模拟刷新重新挂载）共用同一个实例时，
 * 才能验证「移出最近」隐藏名单确实跨挂载持久化，而不是只活在一次渲染的闭包里。 */
class FakeStorage{
 private map=new Map<string,string>()
 getItem(key:string){return this.map.has(key)?this.map.get(key)!:null}
 setItem(key:string,value:string){this.map.set(key,value)}
 removeItem(key:string){this.map.delete(key)}
}

/** 与 `shell-personal-edition.test.ts` 同一转译执行手法，`work-presentation.js` 换成真实实现，
 * 好让「最近工作」真的列出行来，才能验证新增的移出（本地隐藏，不归档）按钮。
 * `recentWorkHiddenStore` 默认每次挂载给一个全新的内存名单；传入同一个实例可以模拟「刷新后仍隐藏」。 */
function mount(file:string,initialProps:Record<string,unknown>,recentWorkHiddenStore:RecentWorkHiddenStore=createRecentWorkHiddenStore(new FakeStorage())){
 const source=readFileSync(new URL(file,root),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const effects:{deps?:unknown[]|undefined}[]=[];let effectCursor=0
 const React={
  createElement:(type:unknown,elementProps:Record<string,unknown>|null,...children:unknown[])=>({type,props:elementProps??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
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
  if(id.endsWith('personal-profile.js'))return {personalProfile:{subscribe:()=>()=>{},getSnapshot:()=>({displayName:'Max'})}}
  if(id.endsWith('application-presentation.js'))return {applicationPresentation:{subscribe:()=>()=>{},getSnapshot:()=>({product:'Free',account:null})}}
  if(id.endsWith('provider.js'))return {useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key})}
  if(id.endsWith('errors.js'))return {localizeWorkError:(_:string,value:unknown)=>String(value)}
  if(id.endsWith('work-presentation.js'))return {presentConversations}
  if(id.endsWith('use-dismissible.js'))return {useDismissible:()=>{}}
  if(id.endsWith('recent-work-hidden.js'))return {browserRecentWorkHiddenStore:()=>recentWorkHiddenStore}
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

const conversation:Conversation={id:'conv-1',sessionId:'sess-1',title:'昨天的会话',status:'ready',createdAt:'2026-09-20T01:00:00.000Z'} as Conversation

function props(archived:string[],archive:(id:string)=>Promise<void>,openConversation:(value:Conversation)=>Promise<void>=async()=>{}){
 return {
  view:'home' as const,
  colorScheme:'light' as const,
  actions:new Proxy({},{get:()=>()=>{}}) as never,
  work:{subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows:[conversation],status:'ready',error:undefined}),getSnapshot:()=>({sessionId:undefined}),openConversation},
  management:{subscribe:()=>()=>{},getSnapshot:()=>({baseline:true,archived,ready:true}),archive},
  useSessions:(selector:(value:{byId:Record<string,unknown>;current:string|undefined})=>unknown)=>selector({byId:{'sess-1':{id:'sess-1',title:'昨天的会话',running:false,blank:false,updatedAt:Date.parse('2026-09-20T01:00:00.000Z')}},current:undefined}),
  create:()=>{},
  creating:false,
  needCount:0,
  openTwin:async()=>{},
  setTheme:()=>{},
 }
}

test('最近工作每一行带一个移出按钮，点击只隐藏这一行，不归档原始会话也不打开它',()=>{
 const archived:string[]=[]
 const opened:string[]=[]
 const archive=async(id:string)=>{archived.push(id)}
 const render=mount('WorkNavigation.tsx',props([],archive,async value=>{opened.push(value.id)}))
 const view=render()
 const removeButton=nodes(view).find(node=>node.type==='button'&&node.props['aria-label']==='navigation.recent.remove')
 assert.ok(removeButton,'必须有一个 aria-label 为 navigation.recent.remove 的按钮')
 removeButton!.props.onClick({stopPropagation:()=>{}})
 const updated=render()
 assert.equal(nodes(updated).filter(node=>node.type==='button'&&node.props.className==='recentOpen').length,0,'点击移出后这一行从最近工作里消失')
 assert.deepEqual(archived,[],'移出最近是本地隐藏，不应调用 management.archive 归档原始会话')
 assert.deepEqual(opened,[],'点移出不应触发打开这条会话')
})

test('移出最近的隐藏名单本地持久化：重新挂载（模拟刷新）后仍隐藏，其它行不受影响',()=>{
 const rows=[
  {id:'conv-1',sessionId:'sess-1',title:'会话一',status:'ready' as const,createdAt:'2026-09-20T01:00:00.000Z'} as Conversation,
  {id:'conv-2',sessionId:'sess-2',title:'会话二',status:'ready' as const,createdAt:'2026-09-19T01:00:00.000Z'} as Conversation,
 ]
 const shared={
  ...props([],async()=>{}),
  work:{subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows,status:'ready',error:undefined}),getSnapshot:()=>({sessionId:undefined}),openConversation:async()=>{}},
  useSessions:(selector:(value:{byId:Record<string,unknown>;current:string|undefined})=>unknown)=>selector({byId:{
   'sess-1':{id:'sess-1',title:'会话一',running:false,blank:false,updatedAt:2},
   'sess-2':{id:'sess-2',title:'会话二',running:false,blank:false,updatedAt:1},
  },current:undefined}),
 }
 const storage=new FakeStorage()
 const render1=mount('WorkNavigation.tsx',shared,createRecentWorkHiddenStore(storage))
 const view1=render1()
 const removeFirst=nodes(view1).filter(node=>node.type==='button'&&node.props['aria-label']==='navigation.recent.remove')[0]
 assert.ok(removeFirst,'第一行必须有移出按钮')
 removeFirst!.props.onClick({stopPropagation:()=>{}})
 const afterHide=render1()
 const remainingOpen=nodes(afterHide).filter(node=>node.type==='button'&&node.props.className==='recentOpen')
 assert.equal(remainingOpen.length,1,'隐藏一条后只剩一条')
 assert.ok(textOf(remainingOpen[0]).includes('会话二'),'剩下的必须是没被移出的那一条')

 const render2=mount('WorkNavigation.tsx',shared,createRecentWorkHiddenStore(storage))
 const view2=render2()
 const persistedOpen=nodes(view2).filter(node=>node.type==='button'&&node.props.className==='recentOpen')
 assert.equal(persistedOpen.length,1,'重新挂载（模拟刷新）后隐藏名单仍生效')
 assert.ok(textOf(persistedOpen[0]).includes('会话二'))
})

test('已归档的会话不再出现在最近工作里',()=>{
 const render=mount('WorkNavigation.tsx',props(['sess-1'],async()=>{}))
 const view=render()
 assert.equal(nodes(view).filter(node=>node.type==='button'&&node.props['aria-label']==='navigation.recent.remove').length,0)
 assert.ok(!nodes(view).some(node=>node.props.className==='recentNav'),'没有会话时隐藏整个最近工作分组')
})

test('移出按钮点击不会冒泡到打开会话的按钮',async()=>{
 const source=readFileSync(new URL('WorkNavigation.tsx',root),'utf8')
 assert.match(source,/className=\{css\.recentRemove\}[^]*?onClick=\{event=>\{event\.stopPropagation\(\)/)
})

test('4 条固定只渲染前 3 条，末尾出现「更多固定 · 4」，点击后展开全部',()=>{
 const shortcuts=[0,1,2,3].map(index=>({target:{scope:'scope-'+index,section:'overview' as const}}))
 const render=mount('WorkNavigation.tsx',{...props([],async()=>{}),businessShortcuts:shortcuts,businessScopeNames:Object.fromEntries(shortcuts.map(({target},index)=>[target.scope,'范围'+index]))})
 const view=render()
 const openButtons=nodes(view).filter(node=>node.type==='button'&&node.props.className==='shortcutOpen')
 assert.equal(openButtons.length,3,'折叠状态只渲染前 3 条固定')
 const more=nodes(view).find(node=>node.type==='button'&&node.props.className==='shortcutMore')
 assert.ok(more,'必须有一个更多固定按钮')
 assert.equal(more!.props['aria-expanded'],false)
 assert.ok(more!.children.some((child:unknown)=>typeof child==='string'&&child.includes('navigation.shortcuts.more')&&child.includes('"count":4')),'按钮文案带总数 4')
 more!.props.onClick()
 const expanded=render()
 assert.equal(nodes(expanded).filter(node=>node.type==='button'&&node.props.className==='shortcutOpen').length,4,'再次点击展开全部 4 条')
})

test('业务快捷 3 条或以下不出现更多固定按钮',()=>{
 const shortcuts=[0,1,2].map(index=>({target:{scope:'scope-'+index,section:'overview' as const}}))
 const render=mount('WorkNavigation.tsx',{...props([],async()=>{}),businessShortcuts:shortcuts,businessScopeNames:Object.fromEntries(shortcuts.map(({target},index)=>[target.scope,'范围'+index]))})
 const view=render()
 assert.equal(nodes(view).filter(node=>node.type==='button'&&node.props.className==='shortcutOpen').length,3)
 assert.ok(!nodes(view).some(node=>node.type==='button'&&node.props.className==='shortcutMore'))
})

test('5 条最近工作只渲染 3 条，末尾固定一行「全部对话」，点击调用打开对话目录',()=>{
 const many=[0,1,2,3,4].map(index=>({id:'conv-'+index,sessionId:'sess-'+index,title:'会话 '+index,status:'ready' as const,createdAt:'2026-09-20T01:00:00.000Z'}) as Conversation)
 const opened:string[]=[]
 const actions=new Proxy({openConversationDirectory:()=>{opened.push('directory')}},{get:(target,key)=>key in target?(target as any)[key]:()=>{}})
 const render=mount('WorkNavigation.tsx',{
  ...props([],async()=>{}),
  actions,
  work:{subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows:many,status:'ready',error:undefined}),getSnapshot:()=>({sessionId:undefined}),openConversation:async()=>{}},
  useSessions:(selector:(value:{byId:Record<string,unknown>;current:string|undefined})=>unknown)=>selector({byId:Object.fromEntries(many.map((conversation,index)=>[conversation.sessionId,{id:conversation.sessionId,title:conversation.title,running:false,blank:false,updatedAt:index+1}])),current:undefined}),
 })
 const view=render()
 const recentButtons=nodes(view).filter(node=>node.type==='button'&&node.props.className==='recentOpen')
 assert.equal(recentButtons.length,3,'最近工作只渲染 3 条')
 // 2026-09-20 用户裁定：不再单独做「全部对话」行，它与一级导航「对话」重叠。
 assert.equal(nodes(view).find(node=>node.type==='button'&&node.props.className==='recentAll'),undefined,'最近工作末尾不再有全部对话按钮')
 assert.deepEqual(opened,[])
})

test('固定的看板显示「范围 · 看板标题」，没读到标题时显示看板标识',()=>{
 const shortcuts=[{target:{scope:'SOC',section:'dashboards' as const,dashboardId:'soc-ops'}},{target:{scope:'SOC',section:'dashboards' as const,dashboardId:'soc-risk'}}]
 const render=mount('WorkNavigation.tsx',{...props([],async()=>{}),businessShortcuts:shortcuts,businessDashboardTitles:{[JSON.stringify(['SOC','soc-ops'])]:'安全运营大盘'}})
 const titles=nodes(render()).filter(node=>node.type==='button'&&node.props.className==='shortcutOpen').map(node=>textOf(node.children))
 assert.deepEqual(titles,['SOC · 安全运营大盘','SOC · soc-risk'])
})
