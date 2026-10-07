import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'

function harness(){
 const source=readFileSync(new URL('../src/client/ProjectOverviewPage.tsx',import.meta.url),'utf8')
 const states:any[]=[],effects:any[]=[];let cursor=0,pending:Array<()=>void>=[]
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useState(initial:any){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(value:any)=>states[i]=typeof value==='function'?value(states[i]):value]},useRef(initial:any){const i=cursor++;return states[i]??(states[i]={current:initial})},useEffect(fn:()=>any,deps:any[]){const i=cursor++;if(!effects[i]||deps.some((value,j)=>value!==effects[i].deps[j])){effects[i]?.cleanup?.();pending.push(()=>effects[i]={deps,cleanup:fn()})}}}
 const modules:Record<string,any>={react:React,'@teloa/contract':{projectStates:['planning','running','review','completed','archived']},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en'})},'./i18n/errors.js':{localizeWorkError:()=>'LOAD FAILED'},'./project-presentation.js':{projectStateKeys:{planning:'project.state.planning',running:'project.state.running',review:'project.state.review',completed:'project.state.completed',archived:'project.state.archived'}},'./ProjectWorkspace.module.css':{default:{}},'./TaskPage.module.css':{default:{}},'lucide-react':new Proxy({},{get:()=>()=>null}),clsx:{default:(...values:unknown[])=>values.filter(Boolean).join(' ')}}
 const out:Record<string,any>={}
 // 遮蔽组件内 setInterval(update,30000)：断言失败时不会走到 visible:false 清理，真定时器会令进程挂起 30 秒不退出。
 new Function('require','exports','React','setInterval','clearInterval',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText)((id:string)=>modules[id],out,React,()=>0,()=>{})
 const nodes=(node:any):any[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
 const render=(props:any)=>{cursor=0;const tree=out.ProjectOverviewPage(props),jobs=pending;pending=[];jobs.forEach(fn=>fn());return tree}
 const settle=()=>new Promise(resolve=>setTimeout(resolve,10))
 return {render,nodes,settle}
}
const label=(scope:string)=>({scope,title:scope,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0})
const project=(id:string,scope:string,state='planning')=>({id:`${id}0000000-0000-4000-8000-000000000001`,ownerId:'self',version:1,createdAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z',scope,title:`P${id} ${scope}`,goal:'Ship',state,dueDate:null,links:[],references:[]})
;(globalThis as any).window??={addEventListener(){},removeEventListener(){}};(globalThis as any).document??={visibilityState:'visible'}

test('单业务不渲染业务下拉；「当前」以 state:current 查询，回包几行渲染几行（不再本地过滤）；点卡片调用 open',async()=>{
 const {render,nodes,settle}=harness(),calls:any[]=[],opened:any[]=[]
 const rows=[project('1','general'),project('2','general','running'),project('3','general','review')]
 const props={api:{overview:async(input:any)=>{calls.push(input);return {rows,nextCursor:null}}},scopeLabels:[label('general')],labelsReady:true,scopeName:(scope:string)=>scope,navigation:{state:{},change(){}},open:(row:any)=>opened.push(row),visible:true}
 render(props);await settle();const tree=render(props)
 assert.deepEqual(calls,[{scope:null,state:'current',cursor:null,limit:50}])
 assert.equal(nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='project.overview.businessFilter'),undefined)
 const cards=nodes(tree).filter(node=>node.props['data-project-card']!==undefined)
 assert.deepEqual(cards.map(node=>node.props['data-project-card']),rows.map(row=>row.id),'渲染行数等于回包行数')
 cards[0].props.onClick();assert.equal(opened[0],rows[0])
 render({...props,visible:false})
})
test('多业务时选择业务写入 navigation.category 并以该 scope 查询；选「已归档」写入 query 并传 state',async()=>{
 const {render,nodes,settle}=harness(),calls:any[]=[],patches:any[]=[]
 let navigation={state:{} as Record<string,string|undefined>,change(patch:Record<string,string|undefined>){patches.push(patch);navigation={...navigation,state:{...navigation.state,...Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined))}}}}
 const props=()=>({api:{overview:async(input:any)=>{calls.push(input);return {rows:[project('1',input.scope??'general',input.state==='current'?'planning':input.state)],nextCursor:null}}},scopeLabels:[label('general'),label('SOC')],labelsReady:true,scopeName:(scope:string)=>scope==='SOC'?'Security Ops':scope,navigation,open(){},visible:true})
 render(props());await settle();let tree=render(props())
 const business=nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='project.overview.businessFilter');assert.ok(business)
 assert.deepEqual(nodes(business).filter(node=>node.type==='option').map(node=>[node.props.value,node.children[0]]),[['','project.overview.allBusinesses'],['general','general'],['SOC','Security Ops']])
 business.props.onChange({target:{value:'SOC'}});assert.deepEqual(patches.at(-1),{category:'SOC'})
 render(props());await settle();tree=render(props())
 assert.deepEqual(calls.at(-1),{scope:'SOC',state:'current',cursor:null,limit:50})
 assert.ok(nodes(tree).some(node=>node.children.includes('Security Ops')),'卡片显示业务名')
 nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='project.overview.stateFilter').props.onChange({target:{value:'archived'}})
 assert.deepEqual(patches.at(-1),{query:'archived'})
 render(props());await settle();tree=render(props())
 assert.deepEqual(calls.at(-1),{scope:'SOC',state:'archived',cursor:null,limit:50})
 assert.equal(nodes(tree).filter(node=>node.props['data-project-card']!==undefined).length,1,'已归档筛选下显示归档行')
 render({...props(),visible:false})
})
test('有 nextCursor 时显示加载更多，点击后传 cursor 并追加去重',async()=>{
 const {render,nodes,settle}=harness(),calls:any[]=[]
 const first={rows:[project('1','general'),project('2','SOC')],nextCursor:'2026-09-25T00:00:00.000Z|20000000-0000-4000-8000-000000000001'},second={rows:[project('2','SOC'),project('3','AppSec')],nextCursor:null}
 const props={api:{overview:async(input:any)=>{calls.push(input);return input.cursor?second:first}},scopeLabels:[label('general'),label('SOC'),label('AppSec')],labelsReady:true,scopeName:(scope:string)=>scope,navigation:{state:{},change(){}},open(){},visible:true}
 render(props);await settle();let tree=render(props)
 const more=nodes(tree).find(node=>node.props['data-project-load-more']!==undefined);assert.ok(more)
 await more.props.onClick();tree=render(props)
 assert.deepEqual(calls.at(-1),{scope:null,state:'current',cursor:first.nextCursor,limit:50})
 assert.deepEqual(nodes(tree).filter(node=>node.props['data-project-card']!==undefined).map(node=>node.props['data-project-card']),[first.rows[0]!.id,first.rows[1]!.id,second.rows[1]!.id])
 assert.equal(nodes(tree).find(node=>node.props['data-project-load-more']!==undefined),undefined)
 render({...props,visible:false})
})
test('业务目录未就绪时不发首屏请求，就绪后按恢复的业务筛选只查一次；列表容器标记为 directory 面板供 scrollTop 复用',async()=>{
 const {render,nodes,settle}=harness(),calls:any[]=[]
 const api={overview:async(input:any)=>{calls.push(input);return {rows:[project('1','SOC')],nextCursor:null}}}
 const props=(labelsReady:boolean,scopeLabels:any[])=>({api,scopeLabels,labelsReady,scopeName:(scope:string)=>scope,navigation:{state:{category:'SOC'},change(){}},open(){},visible:true})
 render(props(false,[]));await settle();render(props(false,[]))
 assert.deepEqual(calls,[],'标签未就绪不请求')
 render(props(true,[label('general'),label('SOC')]));await settle();const tree=render(props(true,[label('general'),label('SOC')]))
 assert.deepEqual(calls,[{scope:'SOC',state:'current',cursor:null,limit:50}],'就绪后只按恢复的业务查一次')
 const pane=nodes(tree).find(node=>node.props['data-teloa-pane']==='directory');assert.ok(pane,'列表容器带 data-teloa-pane=directory');assert.ok(nodes(pane).some(node=>node.props['data-project-card']!==undefined))
 render({...props(true,[label('general'),label('SOC')]),visible:false})
})
test('导航状态含 projects 视图与目录；左栏与外壳四处接线；navigation.projects 十语齐全',async()=>{
 const {readWorkbenchNavigationState,writeWorkbenchNavigationState,emptyWorkbenchNavigationState}=await import('../src/client/workbench-navigation-state.ts')
 const saved={...emptyWorkbenchNavigationState(),view:'projects' as const,directories:{projects:{category:'SOC',query:'archived',scrollTop:12}}}
 assert.deepEqual(readWorkbenchNavigationState(writeWorkbenchNavigationState(saved)),saved)
 assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved,view:'bogus'})))
 const client=new URL('../src/client/',import.meta.url)
 const [chrome,nav,frame,store]=await Promise.all([readFile(new URL('WorkbenchNavigationChrome.tsx',client),'utf8'),readFile(new URL('WorkNavigation.tsx',client),'utf8'),readFile(new URL('WorkbenchFrame.tsx',client),'utf8'),readFile(new URL('store.ts',client),'utf8')])
 assert.match(chrome,/\['tasks','navigation.tasks',CheckSquare\],\['projects','navigation.projects',FolderKanban\]/)
 assert.match(chrome,/primaryNavigation\.map\(/);assert.match(chrome,/onClick=\{\(\)=>onSelect\(id\)\}/)
 assert.match(nav,/import \{WorkbenchNavigationBrand,WorkbenchNavigationItems\} from '\.\/WorkbenchNavigationChrome\.js'/)
 assert.match(nav,/<WorkbenchNavigationItems view=\{view\}/);assert.match(nav,/:actions\.navigate\(id\)\}/)
 assert.match(frame,/state\.view==='projects'&&<ProjectOverviewPage/);assert.match(frame,/open=\{project=>enterBusiness\(/);assert.match(frame,/'spaces','plans','projects'\] as const\)\.find\(id=>id===state\.view\)/)
 assert.match(store,/'plans' \| 'projects' \| 'settings'/)
 for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'])assert.match(await readFile(new URL('i18n/locales/'+locale+'.ts',client),'utf8'),/'navigation\.projects': '[^']+'/,locale)
 assert.match(await readFile(new URL('i18n/messages.ts',client),'utf8'),/'navigation\.projects'/)
})
