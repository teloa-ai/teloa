import {useState,type ReactNode} from 'react'
import {createRoot} from 'react-dom/client'
import {MarketCatalogSection,type CatalogSolutionTeam} from '../../src/client/MarketCatalogSection.js'
import type {MarketItem} from '../../src/client/market-preview.js'
import {MarketPage,type MarketProps} from '../../src/client/MarketPage.js'
import type {MarketCatalogApi,MarketCatalogItem} from '../../src/client/market-catalog-api.js'
import type {ManagedMcpConnectionApi,ManagedMcpConnectionRecord} from '../../src/client/mcp-connections-api.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import type {ProductLocale} from '../../src/client/i18n/locale.js'
import {connectorEntry,connectionRecord,navigationSkill} from '../market-navigation-fixture.js'
import solutionEntry from '../../../../../tests/fixtures/public-market/catalog/solutions/teloa.cn-workspace.json'
import solutionManifest from '../../../../../tests/fixtures/public-market/artifacts/solutions/teloa.cn-workspace/1.0.0/teloa.json'
import {validateIndustryManifest} from '../../src/client/industry-manifest.js'

const locale=(document.documentElement.lang||'zh-CN') as ProductLocale
const snapshot={locale,dshLocale:'zh',revision:1}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage(locale,key,params)} as TeloaI18n
const old=connectorEntry('teloa.legacy'),target=connectorEntry()
old.alternatives=[{entryId:target.id,marketplace:'teloa',installs:null,recommended:true}]
const query=locale==='en'?'Legacy':'旧工具'
const solutionMode=document.body.dataset.mode?.startsWith('solution')===true
const state={calls:[] as string[],failCatalog:false,failOpen:false,failSolution:false,failAdd:false,failAsk:false,records:[connectionRecord(old.id)],added:new Set(document.body.dataset.mode==='installed'?[old.id,target.id]:[old.id]),items:[navigationSkill(),old,target]}
const called=(name:string)=>{state.calls.push(name)}
const catalogApi:MarketCatalogApi={
 list:async request=>{
  called('catalog.list')
  if(state.failCatalog)throw Error('teloa/source-unavailable')
  // 官方方案产品页：方案页签只读 Teloa 目录，列出真实的「中国企业办公协同」条目
  if(solutionMode)return {catalogVersion:'2026.9.27',items:!request?.marketplace||request.marketplace==='teloa'?[{entry:solutionEntry,artifact:{files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1}],treeHash:'c'.repeat(64)},addedContentId:null,addedRoleId:null,secretGroup:null}] as unknown as MarketCatalogItem[]:[],nextCursor:null,counts:{dashboard:0,skill:0,connector:0,model:0,solution:1,role:0},skipped:{unknownKind:0,newerApp:0}}
  const items=state.items.filter(entry=>request?.marketplace==='codex'?entry.id==='codex.legacy':!request?.marketplace||request.marketplace==='teloa'?entry.kind==='connector':false).map(entry=>({entry,artifact:null,addedContentId:state.added.has(entry.id)?connectionRecord(entry.id).id:null,addedRoleId:null,secretGroup:null})) as MarketCatalogItem[]
  return {catalogVersion:'2026.9.27',items,nextCursor:null,counts:{dashboard:0,skill:0,connector:2,model:0,solution:0,role:0},skipped:{unknownKind:0,newerApp:0}}
 },
 ranking:async()=>new Map(),
 add:async id=>{called('catalog.add');if(state.failAdd)throw Error('teloa/source-unavailable');state.added.add(id);return {contentId:connectionRecord(id).id}},
 addRole:async()=>{called('catalog.addRole');throw Error('Unexpected role creation')},
 solutionPackage:async()=>{called('catalog.solution');if(state.failSolution)throw Error('teloa/source-unavailable');return {manifest:validateIndustryManifest(solutionManifest),readOnlyResources:['lark-read','yuque-read']}},
}
const managedApi={
 list:async()=>{called('connections.list');return structuredClone(state.records)},
 get:async(id:string)=>structuredClone(state.records.find(record=>record.id===id)!),
 add:async(catalogId:string)=>{called('connections.add');const record=connectionRecord(catalogId,'saved');state.records.push(record);return structuredClone(record)},
 connect:async(id:string)=>{called('connections.connect');const record=state.records.find(record=>record.id===id)!;record.status='connected';return structuredClone(record)},
 disconnect:async(id:string)=>{called('connections.disconnect');const record=state.records.find(record=>record.id===id)!;record.status='saved';return structuredClone(record)},
 delete:async(id:string)=>{called('connections.delete');state.records=state.records.filter(record=>record.id!==id)},
} as ManagedMcpConnectionApi
Object.assign(window,{marketNavigationFixture:{state,setTargetStatus(status:ManagedMcpConnectionRecord['status']){state.records=[connectionRecord(old.id),connectionRecord(target.id,status)]}}})

// 官方方案接上团队步骤（mode=solution-team）：本机条目与团队确认步骤是替身，只记录调用
function SolutionTeam(){
 const [loaded,setLoaded]=useState(false)
 const [resolved,setResolved]=useState(false)
 const local={id:'local-cn',manifest:{id:'cn-workspace',version:'1.0.0'}} as MarketItem
 // 与市场页一样：刚添加的内容要读回本机列表后才找得到
 const team:CatalogSolutionTeam={
  find:contentId=>resolved&&contentId===connectionRecord('teloa.cn-workspace').id?local:undefined,
  installed:value=>loaded&&value.manifest?.id==='cn-workspace',
  loadLinks:()=><button type="button" onClick={()=>called('load.open')}>看看它带进来什么 · 协同</button>,
  resolve:async()=>{called('content.resolve');setResolved(true);return local},
  form:(_item,close):ReactNode=><section aria-label="团队确认步骤"><button type="button" onClick={()=>{called('team.confirm');setLoaded(true)}}>确认加入</button><button type="button" onClick={close}>收起</button></section>,
  // 同步抛错（例如草稿保存校验失败）也要复位并给出原因
  ask:item=>{if(state.failAsk)throw Error('teloa/invalid-input');called('ask:'+item.id);return Promise.resolve()},
 }
 return <MarketCatalogSection api={catalogApi} query="" kinds={['solution']} localRows={[]} openContent={async()=>{called('content.open')}} solutionTeam={team}/>
}
function Page(){
 const [marketState,setMarketState]=useState({items:[],intents:[]})
 const props={visible:true,state:marketState,itemId:null,intentId:null,open:()=>called('content.open'),change:setMarketState,seed:null,clearSeed:()=>{},navigationState:{category:'skill',query},installations:{visible:false,selected:null},industryLoads:{loads:[]},skillInstallApi:{pending:()=>undefined,list:async()=>({items:[]})},marketCatalogApi:catalogApi,managedMcpConnectionApi:managedApi,spaces:[],targets:[],nativeModels:()=>{},openRole:()=>{}} as unknown as MarketProps
 return <MarketPage {...props}/>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={runtime}>{document.body.dataset.mode==='page'?<Page/>:document.body.dataset.mode==='solution-team'?<SolutionTeam/>:solutionMode?<MarketCatalogSection api={catalogApi} query="" kinds={['solution']} localRows={[]} openContent={async()=>{called('content.open')}}/>:<MarketCatalogSection api={catalogApi} query={query} kinds={['skill']} openContent={async()=>{called('content.open');if(state.failOpen)throw Error('teloa/source-unavailable')}}/>}</I18nProvider>)
