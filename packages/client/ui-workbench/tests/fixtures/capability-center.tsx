import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {CapabilityCenterHeader} from '../../src/client/CapabilityCenterHeader.js'
import {WorkbenchNavigationItems,WorkbenchNavigationBrand} from '../../src/client/WorkbenchNavigationChrome.js'
import {MarketPage,type MarketProps} from '../../src/client/MarketPage.js'
import {TeamCapabilitiesPage} from '../../src/client/TeamCapabilitiesPage.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import {connectorEntry,navigationSkill} from '../market-navigation-fixture.js'
import frameCss from '../../src/client/WorkbenchFrame.module.css'
import tokens from '../../src/client/theme-tokens.module.css'

// 交互验收替身：页面与组件均来自产品源码，所有资料和接口仅用于隔离测试。
const calls:string[]=[]
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1}
const i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
const connector={...connectorEntry('teloa.github'),connector:{...connectorEntry().connector,serverName:'github',title:{'zh-CN':'GitHub',en:'GitHub'},summary:{'zh-CN':'查阅仓库、Issue 和 Pull Request。',en:'Read repositories, issues and pull requests.'}}}
const skill={...navigationSkill(),id:'codex.research',skill:{...navigationSkill().skill,name:'research',title:{'zh-CN':'资料研究',en:'Research'},summary:{'zh-CN':'整理资料，形成可核对的研究结论。',en:'Research and summarize source materials.'}}}
const entries=[connector,skill]
const catalogApi={list:async(request:any)=>({catalogVersion:'test',items:entries.filter(e=>request.marketplace===(e.delivery==='upstream'?'codex':'teloa')).map(entry=>({entry,artifact:null,addedContentId:null})),nextCursor:null,counts:{dashboard:0,skill:1,connector:1,model:0,solution:0,role:0},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),get:async(id:string)=>({entry:entries.find(e=>e.id===id),artifact:null,addedContentId:null})}
const workSnapshot={sessionId:'test-session',status:'ready',catalogStatus:'ready',capabilities:{skills:[{name:'research',description:'研究资料',source:'/test/research',provider:'local'}],connections:{status:'observed',tools:[{name:'mcp__github__search',description:'搜索仓库'},{name:'mcp__github__get_issue',description:'读取 Issue'}]},knowledge:{status:'ready',resources:[]},writes:{status:'not-implemented'}}}
const work={subscribe:()=>()=>{},getSnapshot:()=>workSnapshot,readCatalog:async()=>{calls.push('readCatalog')}}
const runtimeSnapshot={status:'ready',items:[]}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>runtimeSnapshot,refresh:async()=>{}}
function App(){
 const [view,setView]=useState<'market'|'capabilities'>('market'),[dark,setDark]=useState(false),[navigation,setNavigation]=useState<any>({category:'home'}),[mineNavigation,setMineNavigation]=useState<any>({category:'skill',mobileLayer:'list'}),[itemId,setItemId]=useState<string|null>(null),[installed,setInstalled]=useState(false)
 const navigate=(target:any)=>{if(target==='market'||target==='capabilities'){setView(target);setInstalled(false)}else calls.push(target)}
 const props={inCapabilityCenter:true,visible:view==='market',marketCatalogApi:catalogApi,state:{items:[],intents:[]},itemId,intentId:null,open:(id?:string)=>setItemId(id??null),change:()=>{},seed:null,clearSeed:()=>{},navigationState:navigation,onNavigationChange:setNavigation,industryLoads:{loads:[]},installations:{visible:false,selected:null},skillInstallApi:{pending:()=>undefined,list:async()=>[]},nativeSettings:()=>calls.push('settings'),runtime:{state:'ready',facts:[]}} as unknown as MarketProps
 return <div className={`${frameCss.frame} ${tokens.tokens}`} style={{...prototypeThemes[dark?'dark':'light'],display:'grid',gridTemplateColumns:'220px minmax(0,1fr)',height:'100vh'} as any}>
  <aside className={frameCss.navigation} style={{position:'static',width:'auto',display:'flex',flexDirection:'column'}}><WorkbenchNavigationBrand product="Free" colorScheme={dark?'dark':'light'} onClose={()=>{}}/><WorkbenchNavigationItems view={view} onSelect={navigate}/><button type="button" onClick={()=>setDark(!dark)} style={{marginTop:'auto'}}>切换主题</button></aside>
  <main style={{overflow:'auto',minWidth:0}}><p style={{margin:'12px 24px',fontSize:12,color:'var(--teloa-muted)'}}>开发预览 · 产品真实组件 · 示例资料和隔离接口</p><CapabilityCenterHeader mode={view==='capabilities'||installed?'mine':'discover'} onMine={()=>navigate('capabilities')} onDiscover={()=>navigate('market')} onInstallations={()=>{setInstalled(true);calls.push('installations')}} onSettings={()=>calls.push('settings')}/>
   {installed?<p style={{margin:24}}>安装管理入口已调用（隔离验收）</p>:<><MarketPage {...props}/><TeamCapabilitiesPage inCapabilityCenter visible={view==='capabilities'} work={work as any} runtimeExtensions={runtime as any} resolveExtensionText={value=>String(value)} plugins={[]} refreshPlugins={async()=>{}} industryLoads={[]} industryLoadsReady navigationState={mineNavigation} onNavigationChange={setMineNavigation} configureIndustryResource={()=>calls.push('configureIndustry')} openMarket={()=>navigate('market')} nativeSettings={()=>calls.push('settings')} openConversation={()=>calls.push('messages')} go={()=>calls.push('configure')} mode="catalog" catalog={()=>navigate('capabilities')}/></>}
  </main>
 </div>
}
;(window as any).capabilityCenterTest={calls}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
