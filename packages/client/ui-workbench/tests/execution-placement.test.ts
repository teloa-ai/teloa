/**
 * 应用桥 `execution.placement`：宿主声明执行位置由宿主分配（host-assigned）时，工作台不再让用户选择执行位置，
 * 也不显示本机路径；字段缺省（含社区版没有应用桥）时与原行为一致。
 *
 * 入口检索：`git grep -n "执行位置\|chooseWorkspace\|Execution location" packages/client/ui-workbench/src`，
 * host-assigned 时隐藏或不再触发的入口：
 * 1. 设置目录的「执行位置」分区：settings-integration.ts 注册的 `teloa-workspaces`（WorkspaceSettings.tsx，逐行列出本机路径）。
 * 2. 左栏新建菜单的「更换执行位置」（conversationDialog.otherLocation → create({chooseWorkspace:true})）
 *    与紧随其后的「管理执行位置」（conversationDialog.manage → 设置目录）：WorkNavigation.tsx。
 * 3. 新建会话的执行位置选择：WorkbenchFrame.tsx 的 requestCreation 经 conversation-workspace-resolution.ts
 *    （缺省读取应用桥的执行位置）得到 select 时弹出 CreateConversationDialog.tsx（chooseWorkspace 选择模式、执行位置下拉、本机路径、管理执行位置、
 *    “还没有执行位置/所选执行位置已被移除/正在等执行位置连接”提示）。
 * 4. 首页缺少执行位置时的选择提示：index.ts 准备首页待用会话时抛 teloa/home-location-required，
 *    HomeNativePreparationNotice 显示「选择工作位置」；home-native-copy.ts 的 `choose`（请先选择一个执行位置后开始。）当前无引用。
 * 5. 对话目录筛选里的「执行位置」与按执行位置手动排序：WorkDirectory.tsx。
 * 检索到但保留的：ConversationScopeDialog.tsx、business-builder-controller.ts、WorkDirectory.module.css 的注释；
 * 词条 taskExecution.configBoundary 与 capabilities.picker.connectionBlocked 只是说明执行来源，不是选择或本机路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import * as presentationModule from '../src/client/application-presentation.ts'
import * as resolution from '../src/client/conversation-workspace-resolution.ts'
import {mount as mountWithCapabilities,nodes as capabilityNodes} from './market-component-harness.ts'

const presentation=presentationModule as typeof presentationModule&Record<string,any>
const store=presentation.applicationPresentation as typeof presentationModule.applicationPresentation&{getExecutionPlacement:()=>string}
const resolveWorkspace=resolution.resolveConversationWorkspace as (input:Record<string,unknown>)=>unknown
const resolveHome=(input:Record<string,unknown>)=>(resolution as Record<string,any>).resolveHomeNativeWorkspace(input)
const client=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFileSync(new URL(name,client),'utf8')
const identity=(product:'Free'|'Pro'|'Enterprise')=>product==='Free'?{schema:'teloa.application-presentation/v1',product,account:null}:{schema:'teloa.application-presentation/v1',product,account:{displayName:'Alice',email:'alice@example.test'}}
const bridge=(product:'Free'|'Pro'|'Enterprise',extra:Record<string,unknown>={})=>({presentation:async()=>identity(product),openAccount:async()=>{},...extra})
const hostAssigned={placement:'host-assigned'}
const workspaces=[{workspaceId:'ws-docs',title:'Docs',path:'/Users/alice/docs',sessionIds:[]},{workspaceId:'ws-other',title:'Other',path:'/Users/alice/other',sessionIds:[]}]

type Node={type:unknown;props:Record<string,any>;children:unknown[]}
const tree=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)?[node as Node,...(node as Node).children.flatMap(tree)]:[]
const text=(node:unknown):string=>typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'&&'children' in (node as Node)?(node as Node).children.map(text).join(''):''

/** 在测试进程里转译真实组件，hooks 用同步桩；未登记的导入直接报错，避免静默替身掩盖接线。 */
function mountComponent(file:string,modules:Record<string,unknown>){
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[]):Node=>({type,props:props??{},children:children.flat(Infinity)}),
  Fragment:'fragment',
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:()=>{},
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
 }
 const css=new Proxy({},{get:(_,key)=>String(key)})
 const icons=new Proxy({},{get:(_,key)=>key==='__esModule'?false:function Icon(){return null}})
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='lucide-react')return icons
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id.endsWith('.css'))return {default:css}
  if(id in modules)return modules[id]
  throw Error('unexpected import '+id+' from '+file)
 }
 const js=ts.transpileModule(read(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',js)(require,exported,React)
 const name=file.replace(/\.tsx?$/,'')
 return (props:Record<string,unknown>)=>{cursor=0;return exported[name](props) as Node}
}

const i18n={useI18n:()=>({locale:'zh-CN',t:(key:string)=>key})}
const errors={localizeWorkError:(_locale:string,error:unknown)=>String(error)}

function navigationMenu(){
 const render=mountComponent('WorkNavigation.tsx',{
  './CapabilityNotice.js':{useApplicationCapability:()=>true},
  './work-presentation.js':{presentConversations:()=>[]},
  './WorkbenchNavigationChrome.js':{WorkbenchNavigationBrand:()=>null,WorkbenchNavigationItems:()=>null},
  './use-personal-profile.js':{usePersonalProfile:()=>({displayName:'Alice',initials:'A'})},
  './application-presentation.js':presentationModule,
  './personal-business-shortcuts.js':{businessShortcutKey:()=>''},
  './i18n/provider.js':i18n,
  './i18n/errors.js':errors,
  './use-dismissible.js':{useDismissible:()=>{}},
  './recent-work-hidden.js':{browserRecentWorkHiddenStore:()=>({read:()=>[],hide:()=>{}})},
 })
 const created:unknown[]=[],noop=()=>()=>{}
 const props={view:'home',colorScheme:'light',actions:new Proxy({},{get:()=>()=>{}}),work:{subscribe:noop,getDirectorySnapshot:()=>({rows:[],status:'ready'}),getSnapshot:()=>({sessionId:undefined}),openConversation:async()=>{}},management:{subscribe:noop,getSnapshot:()=>({baseline:true,archived:[],ready:true})},useSessions:(select:(value:unknown)=>unknown)=>select({byId:{}}),create:(options?:unknown)=>created.push(options??'default'),creating:false,needCount:0,createTask:()=>{},createGroup:()=>{},openTwin:async()=>{},setTheme:()=>{}}
 tree(render(props)).find(node=>node.type==='button'&&node.props['aria-haspopup']==='menu')!.props.onClick()
 const view=render(props)
 const items=tree(view).filter(node=>node.props.role==='menuitem')
 return {labels:items.map(text),items,divider:tree(view).some(node=>node.props.className==='newWorkMenuDivider'),created}
}

function creationDialog(props:Record<string,unknown>={}){
 const render=mountComponent('CreateConversationDialog.tsx',{
  './dialog-focus.js':{openDialog:()=>()=>{}},
  './i18n/errors.js':errors,
  './i18n/provider.js':i18n,
  './application-presentation.js':presentationModule,
 })
 const created:unknown[]=[],noop=()=>()=>{}
 const view=render({management:{subscribe:noop,getSnapshot:()=>({ready:true,workspaces})},current:undefined,initialWorkspaceId:undefined,pendingRequestId:undefined,restart:()=>{},locked:false,busy:false,goal:'整理周报',create:async(workspaceId?:string)=>{created.push(workspaceId)},close:()=>{},settings:()=>{},...props})
 const nodes=tree(view)
 return {view,nodes,text:text(view),created,submit:async()=>{nodes.find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve))}}
}

type Registration={name:string;id:string|undefined}
async function settingsSections(){
 const exported:Record<string,any>={}
 const require=(id:string)=>{
  if(id==='./application-presentation.js')return presentationModule
  if(id==='./workspace-management.js')return {WorkspaceManagement:class{dispose(){}}}
  if(id==='./main-session.js')return {mainSessionSource:()=>({})}
  if(id==='@deepseek-ai/dsh-brand')return {brandString:(value:unknown)=>value}
  if(id==='@deepseek-ai/dsh-client-ui-slots')return {resolveSlotLabel:(value:unknown)=>value}
  if(['./LocalModelsSettings.js','./SettingsShell.js','./WorkspaceSettings.js','./ImChannelsSettingsPage.js'].includes(id))return new Proxy({},{get:(_,key)=>key==='__esModule'?false:function Component(){return null}})
  throw Error('unexpected import '+id+' from settings-integration.ts')
 }
 new Function('require','exports',ts.transpileModule(read('settings-integration.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(require,exported)
 const registered:Registration[]=[]
 const anything:any=new Proxy(function(){},{get:(_,key)=>key==='then'?undefined:anything,apply:()=>anything})
 const slots={inject:(_name:string,factory:()=>unknown)=>{factory()},register:(options:{name:string;id?:string})=>{registered.push({name:options.name,id:options.id});return ()=>{}}}
 const child=new Proxy({slots},{get:(target,key)=>key==='slots'?target.slots:anything})
 const ctx={inject:(_dependencies:readonly string[],callback:(child:unknown)=>unknown)=>{callback(child)}}
 exported.installSettingsShell(ctx,{open(){},close(){},selection:{}},(key:string)=>key,anything,anything,anything,{api:anything,focus:anything})
 return registered.filter(row=>row.name==='settings.section').map(row=>row.id)
}

function directoryFilters(){
 const noop=()=>()=>{}
 function DirectoryFilterPopover(){}
 const page=mountWithCapabilities('WorkDirectory.tsx',{'./DirectoryFilterPopover.js':{DirectoryFilterPopover},'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})},'./work-presentation.js':{presentConversations:()=>[],organizeConversations:()=>[]},'./conversation-search.js':{searchPhase:()=>'idle'},'./saved-collaboration-state.js':{visibleSavedGroups:()=>[]}})
 const props={work:{subscribe:noop,getDirectorySnapshot:()=>({status:'ready',rows:[]}),refreshDirectory:()=>{}},management:{subscribe:noop,getSnapshot:()=>({ready:true,baseline:true,workspaces,archived:[],pending:{}})},search:{subscribe:noop,getSnapshot:()=>({items:[]})},current:undefined,useSessions:(select:any)=>select({byId:{},ids:[]}),onOpened:()=>{},focusRequest:0,onClose:()=>{},groups:{subscribe:noop,getSnapshot:()=>({status:'ready',items:[]}),refresh:()=>{}},selectedGroup:undefined,openGroup:()=>{},createGroup:()=>{},onCreateConversation:()=>{},creating:false}
 const filter=capabilityNodes(page.render('WorkDirectory',props)).find(node=>node.type===DirectoryFilterPopover)!
 return capabilityNodes(filter).filter(node=>node.type==='select').map(node=>node.props['aria-label'])
}

async function withPlacement<T>(candidate:unknown,run:()=>T|Promise<T>):Promise<T>{
 const close=await store.configure(candidate as never)
 try{return await run()}finally{close()}
}

test('缺省时为 user-selected，执行位置入口与文案照常',async()=>{
 assert.equal(presentation.readExecutionPlacement?.(undefined),'user-selected')
 assert.equal(presentationModule.createApplicationPresentationStore().getExecutionPlacement?.(),'user-selected','未配置的工作台由用户选择执行位置')
 await withPlacement(bridge('Enterprise'),async()=>{
  assert.equal(store.getExecutionPlacement(),'user-selected','宿主未声明 execution 时不改变现状')
  const menu=navigationMenu()
  assert.deepEqual(menu.labels.slice(-2),['conversationDialog.otherLocation','conversationDialog.manage'])
  assert.equal(menu.divider,true)
  menu.items.find(node=>text(node)==='conversationDialog.otherLocation')!.props.onClick()
  assert.deepEqual(menu.created,[{chooseWorkspace:true}])
  assert.deepEqual(resolveWorkspace({workspaces,scope:'sales'}),{kind:'select',reason:'ambiguous'})
  assert.deepEqual(resolveWorkspace({workspaces,scope:undefined,chooseOther:true}),{kind:'select',reason:'requested'})
  const dialog=creationDialog({initialWorkspaceId:'ws-docs'})
  assert.ok(dialog.nodes.some(node=>node.type==='select'&&node.props.id==='teloa-create-workspace'))
  assert.match(dialog.text,/conversationDialog\.workspace/)
  assert.match(dialog.text,/conversationDialog\.description/)
  assert.match(dialog.text,/conversationDialog\.path · \/Users\/alice\/docs/)
  assert.match(dialog.text,/conversationDialog\.manage/)
  await dialog.submit();assert.deepEqual(dialog.created,['ws-docs'])
  assert.deepEqual(directoryFilters(),['workDirectory.workspace.filterAria','workDirectory.order.aria'])
  assert.ok((await settingsSections()).includes('teloa-workspaces'))
  assert.throws(()=>resolveHome({remembered:null,currentWorkspaceId:undefined,workspaces}),(error:{code?:string})=>error.code==='teloa/home-location-required')
  assert.equal(resolveHome({remembered:null,currentWorkspaceId:'ws-other',workspaces}),'ws-other')
  assert.equal(resolveHome({remembered:null,currentWorkspaceId:undefined,workspaces:workspaces.slice(0,1)}),'ws-docs')
 })
})

test('host-assigned 时设置目录不含执行位置分区',async()=>{
 await withPlacement(bridge('Enterprise',{execution:hostAssigned}),async()=>{
  assert.equal(store.getExecutionPlacement(),'host-assigned')
  const sections=await settingsSections()
  assert.ok(!sections.includes('teloa-workspaces'),'执行位置分区不应注册')
  assert.ok(sections.includes('general')&&sections.includes('plugins'),'其他设置分区照常注册')
 })
 assert.equal(store.getExecutionPlacement(),'user-selected','卸载应用桥后回到用户选择')
 assert.ok((await settingsSections()).includes('teloa-workspaces'))
})

test('host-assigned 时左栏无更换执行位置入口、新建会话不出现执行位置选择',async()=>{
 await withPlacement(bridge('Pro',{execution:hostAssigned}),async()=>{
  const menu=navigationMenu()
  assert.ok(menu.labels.includes('navigation.newConversation'))
  assert.ok(!menu.labels.includes('conversationDialog.otherLocation'),'不再提供更换执行位置')
  assert.ok(!menu.labels.includes('conversationDialog.manage'),'不再提供管理执行位置')
  assert.equal(menu.divider,false)
  // WorkbenchFrame 的 requestCreation 不传 hostAssigned，由解析缺省读取应用桥。
  for(const input of [{workspaces,scope:'sales'},{workspaces:[],scope:'sales'},{workspaces,scope:'sales',registryReady:false},{workspaces,scope:'sales',preferredWorkspaceId:'ws-gone'},{workspaces,scope:undefined,chooseOther:true}])
   assert.deepEqual(resolveWorkspace(input),{kind:'create',workspaceId:undefined},JSON.stringify(input))
  assert.deepEqual(resolveWorkspace({workspaces,scope:'sales',recovering:true}),{kind:'select',reason:'recovery'},'待恢复的创建仍需本人决定重试或另建')
  assert.deepEqual(resolveWorkspace({workspaces,scope:'sales',hostAssigned:false}),{kind:'select',reason:'ambiguous'},'显式参数优先于应用桥')
  for(const props of [{},{locked:true,pendingRequestId:'request-1'}]){
   const dialog=creationDialog(props)
   assert.ok(!dialog.nodes.some(node=>node.type==='select'),'不出现执行位置下拉')
   for(const key of ['conversationDialog.workspace','conversationDialog.description','conversationDialog.path','conversationDialog.manage','conversationDialog.empty','conversationDialog.select'])assert.doesNotMatch(dialog.text,new RegExp(key.replace('.','\\.')),key)
   assert.doesNotMatch(dialog.text,/\/Users\/alice/)
   const primary=dialog.nodes.find(node=>node.type==='button'&&node.props.type==='submit')!
   assert.equal(primary.props.disabled,false)
   assert.equal(text(primary),props.locked?'conversationDialog.retry':'conversationDialog.create')
   await dialog.submit();assert.deepEqual(dialog.created,[undefined],'由宿主分配，不带执行位置')
  }
  assert.deepEqual(directoryFilters(),[],'对话目录不再按执行位置筛选或手动排序')
 })
 assert.match(read('WorkbenchFrame.tsx'),/const decision=resolveConversationWorkspace\(\{[^)]*\}\)/)
 assert.doesNotMatch(read('WorkbenchFrame.tsx'),/resolveConversationWorkspace\(\{[^)]*hostAssigned/,'新建入口沿用应用桥缺省，不另传执行位置判断')
})

test('host-assigned 时首页不出现“请先选择一个执行位置后开始。”',async()=>{
 await withPlacement(bridge('Enterprise',{execution:hostAssigned}),()=>{
  assert.equal(resolveHome({remembered:null,currentWorkspaceId:undefined,workspaces}),undefined,'交给宿主分配，不要求先选位置')
  assert.equal(resolveHome({remembered:null,currentWorkspaceId:'ws-other',workspaces:workspaces.slice(0,1)}),undefined,'不替宿主挑选已登记位置')
  assert.equal(resolveHome({remembered:'ws-docs',currentWorkspaceId:undefined,workspaces}),'ws-docs','同一待用会话重试沿用已发出的位置')
 })
 assert.throws(()=>resolveHome({remembered:null,currentWorkspaceId:undefined,workspaces}),(error:{code?:string})=>error.code==='teloa/home-location-required','卸载应用桥后恢复原提示')
 // 首页待用会话由 index.ts 经同一解析创建；拿不到位置时不带 workspaceId，交给宿主。
 const index=read('index.ts')
 assert.match(index,/const workspaceId=resolveHomeNativeWorkspace\(\{remembered:navigationStorage\.getItem\(key\),currentWorkspaceId:previous\?\.workspaceId,workspaces:available\}\)/)
 assert.match(index,/child\.sessions\.create\(\{sessionId,\.\.\.\(workspaceId\?\{workspaceId:brandString<WorkspaceId>\(workspaceId\)\}:\{\}\)\}\)/)
 assert.doesNotMatch(index,/请先在新建会话中选择执行位置/,'首页准备不再自行要求选择执行位置')
 const root=fileURLToPath(client)
 const sources=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?entry.name==='i18n'?[]:sources(join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[join(dir,entry.name)]:[])
 for(const file of sources(root))if(!file.endsWith('home-native-copy.ts'))assert.doesNotMatch(readFileSync(file,'utf8'),/['"]choose['"]\)/,file)
})

test("execution 为 {placement:'other'} 或带多余键时 configure 拒绝",async()=>{
 const local=presentationModule.createApplicationPresentationStore() as ReturnType<typeof presentationModule.createApplicationPresentationStore>&{getExecutionPlacement:()=>string}
 const close=await local.configure(bridge('Enterprise',{execution:hostAssigned}) as never)
 assert.equal(local.getExecutionPlacement(),'host-assigned')
 for(const execution of [{placement:'other'},{placement:'host-assigned',extra:true},{placement:'user-selected'},{},null,'host-assigned',[hostAssigned],()=>hostAssigned]){
  assert.throws(()=>presentation.readExecutionPlacement(execution),/应用身份信息不可用。/)
  await assert.rejects(local.configure(bridge('Enterprise',{execution}) as never),/应用身份信息不可用。/)
  assert.equal(local.getExecutionPlacement(),'user-selected',JSON.stringify(execution))
  assert.equal(local.getSnapshot().product,'Free')
 }
 close()
 assert.equal(presentation.readExecutionPlacement(hostAssigned),'host-assigned')
})

test('没有应用桥（Free）时行为不变',async()=>{
 await withPlacement(undefined,async()=>{
  assert.equal(store.getExecutionPlacement(),'user-selected')
  assert.deepEqual(navigationMenu().labels.slice(-2),['conversationDialog.otherLocation','conversationDialog.manage'])
  assert.ok((await settingsSections()).includes('teloa-workspaces'))
  assert.deepEqual(directoryFilters(),['workDirectory.workspace.filterAria','workDirectory.order.aria'])
 })
 await withPlacement(bridge('Free',{execution:hostAssigned}),async()=>{
  assert.equal(store.getExecutionPlacement(),'user-selected','社区版身份不接受宿主分配')
  assert.ok(navigationMenu().labels.includes('conversationDialog.otherLocation'))
 })
})
