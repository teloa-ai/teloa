import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import type {Conversation} from '@teloa/contract'
import type {PreviewTask} from '../src/client/task-preview.ts'
import * as taskPreview from '../src/client/task-preview.ts'
import * as exampleDirectory from '../src/client/example-directory-presentation.ts'
import * as homeRecentContext from '../src/client/home-recent-context.ts'
import * as workPresentation from '../src/client/work-presentation.ts'
import * as homeColleagueWork from '../src/client/home-colleague-work.ts'
import {MESSAGE_KEYS} from '../lib/types/client/i18n/messages.js'

const root=new URL('../src/client/',import.meta.url)

type Node={type:unknown;props:Record<string,any>;children:any[]}
const nodes=(node:any):Node[]=>node&&typeof node==='object'&&'props' in node?[node,...node.children.flatMap(nodes)]:[]
const text=(node:any):string=>typeof node==='string'?node:typeof node==='number'?String(node):node&&typeof node==='object'&&'children' in node?node.children.map(text).join(''):''

/** 与 personal-space-surfaces 同一手法：把 WorkHome 转译进测试进程执行，断言真实渲染出的行与按钮。 */
function mount(props:Record<string,unknown>){
 const source=readFileSync(new URL('WorkHome.tsx',root),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const React={
  createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useId:()=>"test-home-context",
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:()=>{},
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
 }
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const modules:Record<string,unknown>={
  'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),
  './task-preview.js':taskPreview,
  './example-directory-presentation.js':exampleDirectory,
  './home-recent-context.js':homeRecentContext,
  './work-presentation.js':workPresentation,
  './home-colleague-work.js':homeColleagueWork,
  './personal-profile.js':{personalProfile:{subscribe:()=>()=>{},getSnapshot:()=>({displayName:'Max'})}},
  './business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作'})},
  './i18n/provider.js':{useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key,dateTime:(value:number)=>String(value),number:(value:number)=>String(value)})},
  './i18n/errors.js':{localizeWorkError:(_:string,value:unknown)=>String(value)},
 }
 const require=(id:string)=>{
  if(id==='react')return React
  if(Object.hasOwn(modules,id))return modules[id]
  if(id.endsWith('.css'))return {default:cssProxy}
  return new Proxy({default:cssProxy},{get:(_,key)=>key==='default'?cssProxy:()=>'none'})
 }
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 return ()=>{cursor=0;return exports.WorkHome(props) as Node}
}

function task(id:string,title:string,updatedAt:string,overrides:Partial<PreviewTask>={}):PreviewTask{
 return {storage:'persistent',id,title,goal:'核对固定事实',scope:'general',object:'本机任务',version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:['self'],createdAt:'2026-09-20T00:00:00.000Z',updatedAt,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'',execution:'not_started',...overrides}
}
const conversation:Conversation={id:'conv-1',sessionId:'sess-1',title:'昨天的会话',status:'ready',createdAt:'2026-09-20T01:00:00.000Z'} as Conversation

function homeProps(tasks:readonly PreviewTask[],spies:{openTask:string[];openTasks:number[]}){
 return {
  resourceApi:{},visible:true,creating:false,
  work:{subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows:[conversation],status:'ready',error:undefined}),getSnapshot:()=>({sessionId:undefined}),openConversation:async()=>{},refreshDirectory:async()=>{}},
  management:{subscribe:()=>()=>{},getSnapshot:()=>({baseline:true,ready:true,archived:[] as string[]})},
  useSessions:(select:(value:{byId:Record<string,unknown>;current:string|undefined})=>unknown)=>select({byId:{'sess-1':{id:'sess-1',title:'昨天的会话',running:false,blank:false,updatedAt:Date.parse('2026-09-20T01:00:00.000Z')}},current:undefined}),
  create:()=>{},createLocal:()=>{},assignees:[],workTasks:tasks,colleagues:[],conversationLinks:[],
  start:async()=>true,open:()=>{},resources:()=>{},capabilities:()=>{},
  openTask:(id:string)=>{spies.openTask.push(id)},openTasks:()=>{spies.openTasks.push(1)},
  plans:()=>{},attention:()=>{},attentionStatus:{count:0},planStatus:{plans:0,runs:0},
 }
}

test('工作台「继续工作」把未结束任务与会话同列，并保留进入任务目录的入口',()=>{
 const spies={openTask:[] as string[],openTasks:[] as number[]}
 const render=mount(homeProps([
  task('task-1','交办的工作','2026-09-20T02:00:00.000Z'),
  task('task-done','已完成的工作','2026-09-20T03:00:00.000Z',{state:'completed'}),
 ],spies))
 const view=render()
 const rows=nodes(view).filter(node=>node.type==='button'&&node.props.className==='row')
 assert.equal(rows.length,2,'任务与会话同列出现在「继续工作」里')
 // 更新时间倒序：任务比会话新，排在第一行；行首形态用不同图标区分任务与会话。
 assert.equal(rows[0]!.props['aria-label'],'home.recent.open:{"title":"交办的工作"}')
 assert.equal(rows[1]!.props['aria-label'],'home.recent.open:{"title":"昨天的会话"}')
 assert.equal(nodes(rows[0]!)[1]!.type,'CheckSquare')
 assert.equal(nodes(rows[1]!)[1]!.type,'FileText')
 // 任务行显示任务状态与业务语境，点一下进入这条任务。
 assert.match(text(rows[0]!),/status\.ready/)
 assert.match(text(rows[0]!),/home\.recent\.context/)
 rows[0]!.props.onClick()
 assert.deepEqual(spies.openTask,['task-1'])
 // 右上角「全部 N 项」按任务目录的口径计数（含已结束），点一下进入任务目录页。
 const all=nodes(view).filter(node=>node.type==='button'&&text(node).startsWith('task.action.viewAll'))
 assert.equal(all.length,1)
 assert.equal(text(all[0]!),'task.action.viewAll:{"count":2}')
 all[0]!.props.onClick()
 assert.deepEqual(spies.openTasks,[1])
})

test('只有任务没有会话时，「继续工作」不再退回空态',()=>{
 const spies={openTask:[] as string[],openTasks:[] as number[]}
 const props=homeProps([task('task-1','交办的工作','2026-09-20T02:00:00.000Z')],spies)
 props.work.getDirectorySnapshot=()=>({rows:[] as Conversation[],status:'loading',error:undefined}) as never
 const view=mount(props)()
 const rows=nodes(view).filter(node=>node.type==='button'&&node.props.className==='row')
 assert.equal(rows.length,1)
 assert.equal(rows[0]!.props['aria-label'],'home.recent.open:{"title":"交办的工作"}')
})

test('守卫：tasks 视图至少有一个可达入口',async()=>{
 const [home,frame]=await Promise.all([
  readFile(new URL('WorkHome.tsx',root),'utf8'),
  readFile(new URL('WorkbenchFrame.tsx',root),'utf8'),
 ])
 // 入口在工作台「继续工作」右上角，主框架把它接到 tasks 视图与单条任务上。
 assert.match(home,/onClick=\{openTasks\}/)
 assert.match(home,/onClick=\{\(\)=>openTask\(row\.task\.id\)\}/)
 assert.match(frame,/<WorkHome[^]*?openTask=\{actions\.openTask\}[^]*?openTasks=\{\(\)=>actions\.navigate\('tasks'\)\}/)
 assert.match(frame,/state\.view==='attention'\|\|state\.view==='tasks'/)
})

test('已删除的孤儿键 task.title.all 与 home.allConversations 不再登记在 MESSAGE_KEYS',()=>{
 assert.ok(!MESSAGE_KEYS.includes('task.title.all' as never))
 assert.ok(!MESSAGE_KEYS.includes('home.allConversations' as never))
 assert.ok(MESSAGE_KEYS.includes('task.action.viewAll' as never))
})

test('首页概览不持有第二份输入或资料选择器',()=>{
 const view=mount(homeProps([],{openTask:[],openTasks:[]}))()
 assert.equal(nodes(view).filter(node=>node.type==='textarea'||node.props.className==='capabilityButton').length,0)
})
