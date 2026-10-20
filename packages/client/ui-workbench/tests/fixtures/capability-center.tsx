import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkbenchNavigationItems,WorkbenchNavigationBrand} from '../../src/client/WorkbenchNavigationChrome.js'
import {MarketPage,type MarketProps} from '../../src/client/MarketPage.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {IndustryLoadRecord} from '../../src/client/industry-load-api.js'
import {TemplateShareProvider} from '../../src/client/EmployeeTemplateShare.js'
import {createMarketPluginInstallApi} from '../../src/client/market-plugin-install-api.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import {connectorEntry,navigationSkill} from '../market-navigation-fixture.js'
import frameCss from '../../src/client/WorkbenchFrame.module.css'
import tokens from '../../src/client/theme-tokens.module.css'

// 交互验收替身：页面与组件均来自产品源码，所有资料和接口仅用于隔离测试。
const calls:string[]=[]
const extensionCreation=(window as unknown as {extensionCreation?:boolean}).extensionCreation===true
const creationValues=new Map<string,string>(),creationStorage={getItem:(key:string)=>creationValues.get(key)??null,setItem:(key:string,value:string)=>{creationValues.set(key,value)},removeItem:(key:string)=>{creationValues.delete(key)}}
const creationInstallApi=createMarketPluginInstallApi(async method=>{calls.push('install:'+method);throw Error('隔离验收不安装应用')})

const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1}
const i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
const connector={...connectorEntry('teloa.github'),connector:{...connectorEntry().connector,serverName:'github',title:{'zh-CN':'GitHub',en:'GitHub'},summary:{'zh-CN':'查阅仓库、Issue 和 Pull Request。',en:'Read repositories, issues and pull requests.'}}}
const skill={...navigationSkill(),id:'codex.research',skill:{...navigationSkill().skill,name:'research',title:{'zh-CN':'资料研究',en:'Research'},summary:{'zh-CN':'整理资料，形成可核对的研究结论。',en:'Research and summarize source materials.'}}}
const entries=[connector,skill]
// 受管连接的写接口只记录调用并拒绝：进入原连接页不得自动提交或建立连接，真实连接只由本人在该页明确动作发起。
const managedConnections={list:async()=>{calls.push('connections:list');return []},get:async()=>{throw Error('隔离验收不读取单条连接')},add:async()=>{calls.push('managed:add');throw Error('隔离验收不提交连接')},connect:async()=>{calls.push('managed:connect');throw Error('隔离验收不建立连接')},disconnect:async()=>{throw Error('隔离验收不断开连接')},delete:async()=>{throw Error('隔离验收不删除连接')},oauthStart:async()=>{throw Error('隔离验收不发起授权')},oauthStatus:async()=>{throw Error('隔离验收不读取授权')}}
// 目录 add 按生产后端边界：official-catalog.add 对 connector 明确拒绝（连接不是内容），只有技能可添加为内容。
// 来源收口后客户端只读统一的 Teloa 精选目录（upstream 条目也由它承载），其他 marketplace 一律空（与 market-primary.browser 同口径）。
const catalogApi={list:async(request:any)=>({catalogVersion:'test',items:(request.marketplace&&request.marketplace!=='teloa'?[]:entries).map(entry=>({entry,artifact:null,addedContentId:null})),nextCursor:null,counts:{dashboard:0,skill:1,connector:1,model:0,solution:0,role:0},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),get:async(id:string)=>({entry:entries.find(e=>e.id===id),artifact:null,addedContentId:null}),add:async(id:string)=>{calls.push('catalog:add:'+id);if(entries.find(e=>e.id===id)?.kind==='connector')throw Error('连接不能添加为内容，请用 teloa_mcp_connect 或 市场 > 连接 添加。');return {contentId:'33333333-3333-4333-8333-333333333333'}}}
let workSnapshot:any={sessionId:'test-session',status:'ready',catalogStatus:'ready',capabilities:{skills:[{name:'research',description:'研究资料',source:'/test/research',provider:'local'},...Array.from({length:30},(_,index)=>({name:'test-skill-'+index,description:'隔离滚动验收',source:'/test/skill-'+index,provider:'local'}))],connections:{status:'observed',tools:[{name:'mcp__github__search',description:'搜索仓库'},{name:'mcp__github__get_issue',description:'读取 Issue'}]},knowledge:{status:'ready',resources:[]},writes:{status:'not-implemented'}}}
const workListeners=new Set<()=>void>();let homeSkillFailure=false
const work={subscribe:(listener:()=>void)=>{workListeners.add(listener);return()=>{workListeners.delete(listener)}},getSnapshot:()=>workSnapshot,readCatalog:async()=>{calls.push('readCatalog')},readHomeSkills:async()=>{calls.push('readHomeSkills');if(homeSkillFailure)throw Error('隔离目录失败');return studioSkills}}
let studioSkills=workSnapshot.capabilities.skills
const taskRun=()=>{workSnapshot={...workSnapshot,sessionId:'task-run-test',conversation:{purpose:'task-run'},capabilities:{...workSnapshot.capabilities,skills:[{name:'writing-revision'}]}};for(const listener of workListeners)listener()}
const managedHash='a'.repeat(64),managedName='writing-bot-writing-revision-b212817e'
const managedLoad:IndustryLoadRecord={id:'load-writing',ownerId:'self',contentId:'fixed-content',contentHash:managedHash,templateId:'writing-bot',templateVersion:'1.0.0',templateTitle:'Writing Bot',domain:'general',scope:'general',description:'Writing',targetVersion:1,space:{id:'general-space',name:'通用工作',version:1,scope:'general'},items:[{localId:'revision',instanceId:'original-revision',kind:'skill',title:'Writing revision',version:'1.0.0',required:true,status:'active'}],relations:[],entrypoints:[],createdAt:'2026-10-14T00:00:00.000Z',mappingHash:managedHash,status:'active'}
const managedSource={kind:'industry-local',loadId:managedLoad.id,itemInstanceId:'original-revision',contentId:managedLoad.contentId,contentHash:managedHash,resourceId:'revision',resourceVersion:'1.0.0'}
const managedNative={name:managedName,description:'Writing method',bodyHash:managedHash,modelInvocable:true,userInvocable:true}
const managedInstallation={id:'original-installation',ownerId:'self',source:managedSource,bundleHash:managedHash,native:managedNative,state:'installed',version:1,createdAt:managedLoad.createdAt,updatedAt:managedLoad.createdAt}
const skillInstallApi={list:async()=>({items:[managedInstallation],usages:[{loadId:managedLoad.id,itemInstanceId:'original-revision',installationId:'original-installation'}]}),preview:async()=>({source:managedSource,bundleHash:managedHash,native:managedNative,files:[{path:'SKILL.md',hash:managedHash,size:100}]}),observe:async()=>({installationId:'original-installation',scope:'default-workspace',state:'available',current:{...managedNative,provider:'teloa-market',source:'/managed/revision'}})}
const runtimeSnapshot={status:'ready',items:[]}
// 页内新建：只读草案目录（空），预览与落定在隔离验收里一律拒绝，验证入口按需展开而不常驻
const pageCreateApi={directory:async(input:any)=>{calls.push('drafts:'+input.entity);return {schema:'teloa.page-create-drafts/v1',entity:input.entity,readAt:'2026-10-14T00:00:00.000Z',drafts:[]}},preview:async()=>{throw Error('隔离验收不读取草案预览')},settle:async()=>{throw Error('隔离验收不落定草案')},create:async()=>{calls.push('create:rejected');throw Error('隔离验收不创建草案')}}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>runtimeSnapshot,refresh:async()=>{}}
function App(){
 const [managed,setManaged]=useState(false)
 ;(window as any).capabilityCenterTest.managedTemplate=()=>{studioSkills=[...studioSkills,{...managedNative,provider:'teloa-market',source:'/managed/revision'},{name:'find-skills',description:'Discover skills',provider:'local',source:'/independent/find-skills'}];setManaged(true)}
 // 独立「我的能力」视图已退出：原入口改为市场「已添加」页签的受控请求，我的资源分组经 MarketPage 的 mine 属性接入
 const view='market' as const
 const [dark,setDark]=useState(false),[navigation,setNavigation]=useState<any>({category:'home'}),[mineNavigation,setMineNavigation]=useState<any>({category:'skill',mobileLayer:'list'}),[itemId,setItemId]=useState<string|null>(null),[installed,setInstalled]=useState(false),[forced,setForced]=useState<{category:'apps'|'home'|'intents'|'resources';serial:number}>()
 const navigate=(target:any)=>{if(target==='market')setInstalled(false);else calls.push(target)}
 const forcedHandled=useRef(0)
 const openMine=()=>{setInstalled(false);setForced(current=>({category:'resources',serial:(current?.serial??0)+1}))}
 const returnApps=()=>{setInstalled(false);setNavigation((current:any)=>({...current,category:'apps'}))}
 ;(window as any).openCapabilityResource=(category:string)=>{setMineNavigation({category,mobileLayer:'list'});openMine()}
 const mine={work:work as any,runtimeExtensions:runtime as any,resolveExtensionText:(value:any)=>String(value),plugins:[],refreshPlugins:async()=>{},industryLoads:managed?[managedLoad]:[],skillInstallApi:skillInstallApi as any,industryLoadsReady:true,navigationState:mineNavigation,onNavigationChange:setMineNavigation,configureIndustryResource:(target:{loadId:string;itemInstanceId:string})=>calls.push('configureIndustry:'+target.loadId+':'+target.itemInstanceId),nativeSettings:()=>calls.push('settings'),openConversation:()=>calls.push('messages'),go:()=>calls.push('configure'),pageCreate:{api:pageCreateApi,...(extensionCreation?{marketPluginInstallApi:creationInstallApi}:{}),prepare:()=>calls.push('prepare'),confirmSkill:async()=>{throw Error('隔离验收不落定草案')},openSkill:()=>{}}}
 const props={inCapabilityCenter:true,visible:view==='market',marketCatalogApi:catalogApi,managedMcpConnectionApi:managedConnections,capabilities:openMine,mine,...(forced&&forced.serial>forcedHandled.current?{forceCategory:forced}:{}),onForceCategoryHandled:(serial:number)=>{forcedHandled.current=serial},state:{items:[{id:'own-weekly',kind:'template',title:'本人周报模板',version:'1.0.0',scope:'general',visibility:'personal',summary:'本人保存的周报',requirements:['整理本周工作'],output:'周报',author:'本人',license:'本人创建',source:{kind:'created'},owner:'Teloa',compatibility:'本机任务模板',components:[]}],intents:[]},itemId,intentId:null,open:(id?:string)=>setItemId(id??null),change:()=>{},targets:[],spaces:[],planFromTemplate:()=>calls.push('plan:own-weekly'),seed:null,clearSeed:()=>{},navigationState:navigation,onNavigationChange:setNavigation,industryLoads:{loads:[]},installations:{visible:false,selected:null,open:()=>{setInstalled(true);calls.push('installations')}},skillInstallApi:{pending:()=>undefined,list:async()=>[]},nativeSettings:()=>calls.push('settings'),runtime:{state:'ready',facts:[]}} as unknown as MarketProps
 return <div className={`${frameCss.frame} ${tokens.tokens}`} style={{...prototypeThemes[dark?'dark':'light'],display:'grid',gridTemplateColumns:'220px minmax(0,1fr)',height:'100vh'} as any}>
  <aside className={frameCss.navigation} style={{position:'static',width:'auto',display:'flex',flexDirection:'column'}}><WorkbenchNavigationBrand product="Free" colorScheme={dark?'dark':'light'} onClose={()=>{}}/><WorkbenchNavigationItems view={view} onSelect={target=>{navigate(target);if(target==='market'&&navigation.category==='apps')setForced(current=>({category:'home',serial:(current?.serial??0)+1}))}}/><button type="button" onClick={()=>setDark(!dark)} style={{marginTop:'auto'}}>切换主题</button></aside>
  {/* 与真实 Frame 一致：市场容器是滚动层，页面 section 高度自适应（WorkbenchFrame.module.css .capabilityCenter） */}
  <main className={frameCss.capabilityCenter} style={{minWidth:0}}><p style={{margin:'12px 24px',fontSize:12,color:'var(--teloa-muted)'}}>开发预览 · 产品真实组件 · 示例资料和隔离接口</p>
   {installed?<p style={{margin:24}}>安装管理入口已调用（隔离验收）<button type="button" onClick={returnApps}>返回应用</button></p>:<MarketPage {...props}/>}
  </main>
 </div>
}
;(window as any).capabilityCenterTest={calls,taskRun,setHomeSkillFailure:(value:boolean)=>{homeSkillFailure=value}}
const app=<I18nProvider runtime={i18n as any}><App/></I18nProvider>
createRoot(document.getElementById('root')!).render(extensionCreation?<TemplateShareProvider value={{storage:creationStorage,publisher:'隔离验收',receive:()=>{},openDraft:()=>{}}}>{app}</TemplateShareProvider>:app)
