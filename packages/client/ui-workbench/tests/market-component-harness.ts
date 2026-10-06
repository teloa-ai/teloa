import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {applicationCapabilityModules} from './application-capability-fixture.ts'
import * as preview from '../src/client/market-preview.ts'
import * as resources from '../src/client/market-resource-index.ts'
import * as presentation from '../src/client/market-home-presentation.ts'
import * as solutions from '../src/client/market-solution-presentation.ts'
import * as guidance from '../src/client/market-page-guidance.ts'
// 行业 / 功能筛选纯函数依赖词典（.js 引用），从构建产物取
import * as taxonomy from '../lib/types/client/market-taxonomy-filter.js'

export type MarketNode={type:any;props:Record<string,any>;children:any[]}
export const nodes=(node:any):MarketNode[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const t=(key:string)=>key
const css=new Proxy({},{get:(_,key)=>String(key)})
export function mount(file:string,additional:Record<string,unknown>={},expose:readonly string[]=[]){
 const states:any[]=[],effects:(()=>unknown)[]=[];let cursor=0
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useMemo:(factory:()=>unknown)=>factory(),useCallback:(fn:unknown)=>fn,useEffect:(effect:()=>unknown)=>{effects.push(effect)},useId:()=>"fixture-id",useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),useState:(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(next:any)=>states[i]=typeof next==='function'?next(states[i]):next]},useRef:(value:any)=>{const i=cursor++;return states[i]??(states[i]={current:value})}}
 const modules:Record<string,unknown>={react:React,'./market-preview.js':preview,'./market-resource-index.js':resources,'./market-home-presentation.js':presentation,'./market-solution-presentation.js':solutions,'./market-page-guidance.js':guidance,'./market-taxonomy-filter.js':taxonomy,'./i18n/provider.js':{useI18n:()=>({t,locale:'en',list:(values:string[])=>values.join(', ')})},'./directory-focus.js':{useDirectoryFocus:()=>({}),closeDirectoryDetailOnEscape:()=>{}},clsx:{default:(...values:unknown[])=>values.filter(Boolean).join(' ')},...additional}
 const require=(id:string)=>modules[id]??applicationCapabilityModules[id as keyof typeof applicationCapabilityModules]??(id.endsWith('.css')?{default:css}:new Proxy({},{get:()=>()=>undefined}))
 const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code+(file==='MarketPage.tsx'?'\nexports.TestCatalog=MarketCatalog;':'')+expose.map(name=>'\nexports.'+name+'='+name+';').join(''))(require,exported,React)
 // effects：最近一次渲染登记的 useEffect 回调（不自动执行，由用例按需调用）
 return {exported,effects,render:(name:string,props:any)=>{cursor=0;effects.length=0;return exported[name](props) as MarketNode}}
}

export function marketProps(navigationState:Record<string,unknown>,items:readonly preview.MarketItem[]=preview.sandboxMarket().items){
 return {visible:true,state:{items:[...items],intents:[]},itemId:undefined as string|undefined,intentId:null,open:(_id?:string)=>{},change:()=>{},seed:null,clearSeed:()=>{},navigationState,onNavigationChange:(_value:any)=>{},installations:{visible:false,selected:null},industryLoads:{loads:[]},skillInstallApi:{pending:()=>undefined},runtime:{state:'ready',facts:[]}}
}
