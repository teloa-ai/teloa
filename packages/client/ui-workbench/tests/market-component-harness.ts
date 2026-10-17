import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {toolbarIconComponent} from './toolbar-icon-component-fixture.ts'
import {applicationCapabilityModules} from './application-capability-fixture.ts'
import * as preview from '../src/client/market-preview.ts'
import * as resources from '../src/client/market-resource-index.ts'
import * as presentation from '../src/client/market-home-presentation.ts'
import * as solutions from '../src/client/market-solution-presentation.ts'
import * as marketIdentity from '../src/client/market-item-identity.ts'
// Apps 页按真实清单格式把本机行业模板交给统一目录判定资源包；用真模块，不让通用替身把谓词吞成 undefined
import * as industryManifest from '../src/client/industry-manifest.ts'
import * as groupMessageOverlays from '../src/client/group-message-overlays.ts'
import * as groupMessageWindow from '../src/client/group-message-window.ts'
import * as groupTaskSourcePresentation from '../src/client/group-task-source-presentation.ts'
import {roleFormDraftModule} from './role-form-drafts-fixture.ts'
import {groupReadingFixture} from './group-reading-fixture.ts'
// 行业 / 功能筛选纯函数依赖词典（.js 引用），从构建产物取
import * as taxonomy from '../lib/types/client/market-taxonomy-filter.js'

export type MarketNode={type:any;props:Record<string,any>;children:any[]}
// Apps 页（2026-10-14 用户选 B：AI 员工/团队为主入口）由 MarketAppsDirectory 统一列应用与技能；
// 模块夹具用具名替身按组件身份定位，initialAppsView 与源码同形（query/category/mine），不含 detail。
export const appsDirectory=function MarketAppsDirectory(){return null}
export const appsDirectoryModule={MarketAppsDirectory:appsDirectory,initialAppsView:{query:'',category:'all',mine:false}}
export const nodes=(node:any):MarketNode[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const t=(key:string)=>key
const css=new Proxy({},{get:(_,key)=>String(key)})
// 渲染时直接展开的组件：轻量图标按钮与共享形象网格，让用例能在父树里查到它们的真实节点。
const INLINE_COMPONENTS=new Set(['ToolbarIconButton','EmployeeAvatarPicker'])
export function mount(file:string,additional:Record<string,unknown>={},expose:readonly string[]=[]){
 const states:any[]=[],effects:(()=>unknown)[]=[];let cursor=0
 const React={createElement:(type:any,props:any,...children:any[])=>{const node={type,props:props??{},children:children.flat(Infinity)};return typeof type==='function'&&INLINE_COMPONENTS.has(type.name)?type({...node.props,children:node.children}):node},useMemo:(factory:()=>unknown)=>factory(),useCallback:(fn:unknown)=>fn,useEffect:(effect:()=>unknown)=>{effects.push(effect)},useId:()=>"fixture-id",useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),useState:(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(next:any)=>states[i]=typeof next==='function'?next(states[i]):next]},useRef:(value:any)=>{const i=cursor++;return states[i]??(states[i]={current:value})}}
 const modules:Record<string,unknown>={react:React,'./role-form-drafts.js':roleFormDraftModule(React),'./group-message-window.js':groupMessageWindow,'./market-preview.js':preview,'./market-resource-index.js':resources,'./market-home-presentation.js':presentation,'./market-solution-presentation.js':solutions,'./market-item-identity.ts':marketIdentity,'./market-item-identity.js':marketIdentity,'./industry-manifest.js':industryManifest,'./industry-manifest.ts':industryManifest,'./market-taxonomy-filter.js':taxonomy,'./i18n/provider.js':{useI18n:()=>({t,locale:'en',list:(values:string[])=>values.join(', ')})},'./directory-focus.js':{useDirectoryFocus:()=>({}),closeDirectoryDetailOnEscape:()=>{}},'./MarketAppsDirectory.js':appsDirectoryModule,clsx:{default:(...values:unknown[])=>values.filter(Boolean).join(' ')},...additional}
 const require=(id:string)=>modules[id]??(id==='./group-task-source-presentation.js'?groupTaskSourcePresentation:id==='./group-message-overlays.js'?groupMessageOverlays:id==='./use-group-reading.js'?groupReadingFixture:undefined)??(id.endsWith('ToolbarIconButton.js')?{ToolbarIconButton:toolbarIconComponent(React)}:undefined)??applicationCapabilityModules[id as keyof typeof applicationCapabilityModules]??(id.endsWith('.css')?{default:css}:new Proxy({},{get:()=>()=>undefined}))
 // 市场已共用关闭钩子；在同一 React 状态容器执行真钩子，不能用空模块掩盖在途保护。
 const dismissCode=ts.transpileModule(readFileSync(new URL('../src/client/use-dialog-dismiss.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const dismissExports:Record<string,unknown>={}
 new Function('require','exports',dismissCode)(require,dismissExports)
 modules['./use-dialog-dismiss.js']??=dismissExports
 const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code+(file==='MarketPage.tsx'?'\nexports.TestCatalog=MarketCatalog;':'')+expose.map(name=>'\nexports.'+name+'='+name+';').join(''))(require,exported,React)
 // effects：最近一次渲染登记的 useEffect 回调（不自动执行，由用例按需调用）
 return {exported,effects,render:(name:string,props:any)=>{cursor=0;effects.length=0;return exported[name](props) as MarketNode}}
}

export function marketProps(navigationState:Record<string,unknown>,items:readonly preview.MarketItem[]=preview.sandboxMarket().items){
 return {visible:true,state:{items:[...items],intents:[]},itemId:undefined as string|undefined,intentId:null,open:(_id?:string)=>{},change:()=>{},seed:null,clearSeed:()=>{},navigationState,onNavigationChange:(_value:any)=>{},installations:{visible:false,selected:null},industryLoads:{loads:[]},skillInstallApi:{pending:()=>undefined},runtime:{state:'ready',facts:[]}}
}
