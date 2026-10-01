import {createRoot} from 'react-dom/client'
import {MarketCatalogSection} from '../../src/client/MarketCatalogSection.js'
import {marketCatalogSources,type MarketCatalogApi,type MarketCatalogItem} from '../../src/client/market-catalog-api.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import type {ProductLocale} from '../../src/client/i18n/locale.js'
import {catalogEntry} from '../market-catalog-fixture.js'

const locale=(document.documentElement.lang||'zh-CN') as ProductLocale
const snapshot={locale,dshLocale:'zh',revision:1}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage(locale,key,params)} as TeloaI18n
const state={failSource:document.body.dataset.failSource??'',calls:[] as string[],mutations:0,counts:[] as unknown[]}
const items=marketCatalogSources.map(source=>({
 entry:{...catalogEntry(),id:`${source}.test`,...(source==='teloa'?{}:{delivery:'upstream',origin:{marketplace:source,installs:null,installsLabel:'',countedAt:'2026-09-27'},alternatives:[],unsupportedComponents:[]})},
 artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null,
})) as unknown as MarketCatalogItem[]
const counts={dashboard:0,skill:1,solution:0,role:0,connector:0,model:0}
const api:MarketCatalogApi={
 list:async request=>{
  const source=request?.marketplace??'teloa';state.calls.push(source)
  if(source===state.failSource)throw Error('teloa/source-unavailable')
  return {catalogVersion:'2026.9.27',items:items.filter(item=>item.entry.id===`${source}.test`),nextCursor:null,counts,skipped:{unknownKind:0,newerApp:0}}
 },
 ranking:async()=>new Map(),
 add:async()=>{state.mutations++;return {contentId:'00000000-0000-4000-8000-000000000001'}},
 addRole:async()=>{state.mutations++;throw Error('Unexpected role creation')},
 solutionPackage:async()=>{throw Error('Unexpected solution read')},
}
Object.assign(window,{marketSourcesFixture:state})
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={runtime}><MarketCatalogSection api={api} query="" openContent={()=>{state.mutations++}} onCounts={counts=>state.counts.push(counts)}/></I18nProvider>)
