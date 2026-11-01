import {useState,type CSSProperties} from 'react'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
import {createRoot} from 'react-dom/client'
import {MarketPage,type MarketProps} from '../../src/client/MarketPage.js'
import {atomicSkillItem} from '../../src/client/atomic-market.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {BusinessScopeProvider} from '../../src/client/business-scope-context.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import type {MarketItem,MarketState} from '../../src/client/market-preview.js'
import type {SkillInstallationRecord} from '../../src/client/skill-install-api.js'

const id='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222',installationId='33333333-3333-4333-8333-333333333333',stamp='2026-10-26T00:00:00.000Z'
declare global {interface Window {__installedSource:{reads:string[];writes:string[];hash:string;contentId:string;installationId:string;release:()=>void}}}
const params=new URLSearchParams(location.search),reads:string[]=[],writes:string[]=[],encoder=new TextEncoder(),sha=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
async function boot(){
 const files=await Promise.all([{path:'SKILL.md',bytes:encoder.encode('---\nname: fixed-source-skill\ndescription: 固定说明，完整配套应可读。\n---\n\n# 原安装正文\n只读取原始版本。')},{path:'references/evidence.md',bytes:encoder.encode('# 原配套文件\n编号 A=120/B=80/C=50。')},{path:'assets/sample.bin',bytes:new Uint8Array([0,255,42,10])}].map(async file=>({...file,hash:await sha(file.bytes)})))
 const hash=await sha(encoder.encode(JSON.stringify(files.map(file=>[file.path,file.hash])))),base=atomicSkillItem({id:'fixed-source-skill',title:'fixed-source-skill',version:'1.0.0',categories:[],hash,entryPath:'SKILL.md',text:new TextDecoder().decode(files[0]!.bytes),files}),item:MarketItem={...base,id:'stored-'+id,source:{kind:'stored',contentId:id},hash,author:'合成作者',license:'MIT',contentStorage:{contentId:id,createdAt:stamp,loaded:true}},latest:MarketItem={...item,id:'stored-'+newId,title:'同名最新版不可替代',version:'2.0.0',hash:'f'.repeat(64),contentStorage:{contentId:newId,createdAt:stamp,loaded:true},atomicSkill:{...item.atomicSkill!,version:'2.0.0',text:'不得显示的同名新版本',hash:'f'.repeat(64)}}
 const record:SkillInstallationRecord={id:installationId,ownerId:'local:test-owner',source:{kind:'atomic',contentId:id,contentHash:hash,resourceId:'fixed-source-skill',resourceVersion:'1.0.0'},bundleHash:hash,native:{name:'fixed-source-skill',description:'固定说明，完整配套应可读。',modelInvocable:true,userInvocable:true,bodyHash:files[0]!.hash},state:'installed',version:2,createdAt:stamp,updatedAt:stamp}
 let release=()=>{};window.__installedSource={reads,writes,hash,contentId:id,installationId,release:()=>release()}
 const noWrite=()=>{writes.push('unexpected-write');throw Error('fixture forbids writes')},content={pending:()=>undefined,pendingGithubImport:()=>undefined,recoveryMessage:()=>undefined,list:async()=>{reads.push('content/list');return params.has('missing')?[latest]:[latest,params.has('mismatch')?{...item,hash:'e'.repeat(64)}:item]},hydrate:async(row:MarketItem)=>{reads.push('hydrate/'+row.contentStorage?.contentId);if(params.has('late'))await new Promise<void>(resolve=>{release=resolve});return row}},skills={list:async()=>({items:[record],usages:[]}),get:async(value:string)=>{reads.push('skill/get/'+value);if(params.has('forbidden'))throw Object.assign(Error('not owned'),{code:'teloa/forbidden'});if(value!==record.id)throw Error('wrong installation');return record},pending:()=>undefined,recoveryMessage:()=>undefined,observe:async()=>({installationId,state:'available',scope:'default-workspace',current:{...record.native,provider:'fixture',source:'managed'}}),preview:noWrite,install:noWrite,recover:noWrite,uninstall:noWrite}
 const style:CSSProperties={...prototypeThemes.light,minHeight:'100vh'};document.body.style.margin='0';document.body.dataset.teloaUiFont='true'
 const snapshot={locale:'zh-CN' as const,dshLocale:'zh',revision:1},runtime:TeloaI18n={t:(key,values)=>translateMessage('zh-CN',key,values),subscribe:()=>()=>{},getSnapshot:()=>snapshot}
 const catalog={list:async()=>({catalogVersion:'source-fixture',items:[],nextCursor:null,counts:{role:0,skill:0,solution:0,dashboard:0,connector:0,model:0},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),add:noWrite}
 function App(){
  const [state,change]=useState<MarketState>({items:[],intents:[]}),[selected,select]=useState<string|null>(null),[installation,setInstallation]=useState<string|null>(params.has('maintenance')?'skill:'+installationId:null)
  // 受控夹具仅给本用例实际读取端口；其余业务写统一抛错，不能把替身数据算安装态证据。
  const props={visible:true,navigationState:{category:'apps',mobileLayer:'list'},state,change,itemId:selected,intentId:null,open:(value?:string)=>select(value??null),seed:null,clearSeed:()=>{},contentApi:content,marketCatalogApi:catalog,skillInstallApi:skills,githubSourceApi:{pending:()=>undefined,recoveryMessage:()=>undefined},marketPluginInstallApi:{pending:()=>undefined},installations:{visible:!!installation,selected:installation,open:(value?:string)=>setInstallation(value??null),market:()=>setInstallation(null)},industryLoads:{loads:[],error:undefined,save:noWrite,recover:noWrite},industryReview:{loads:[],upgrade:noWrite,rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:noWrite},saveResolved:noWrite,spaces:[],targets:[],planFromTemplate:noWrite,manageIndustryLoad:noWrite,update:noWrite,prepare:noWrite,capabilities:noWrite,nativeSettings:noWrite,nativeModels:noWrite,openRole:noWrite,configureBinding:noWrite,openTarget:noWrite} as unknown as MarketProps
  return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><div className={tokens.tokens} style={style}><MarketPage {...props}/></div></BusinessScopeProvider></I18nProvider>
 }
 createRoot(document.getElementById('root')!).render(<App/>);
}
void boot()
