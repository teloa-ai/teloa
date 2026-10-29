import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {IndustryUpdatePreview} from '../../src/client/IndustryUpdatePreview.js'
import {readIndustryDirectory} from '../../src/client/industry-directory.js'
import type {IndustryLoadRecord,IndustryLoadUpgradeInput} from '../../src/client/industry-load-api.js'
import type {MarketItem} from '../../src/client/market-preview.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'

const at='2026-10-29T00:00:00.000Z',loadId='11111111-1111-4111-8111-111111111111',spaceId='55555555-5555-4555-8555-555555555555',mappingHash='a'.repeat(64)
const ids={baseline:'44444444-4444-4444-8444-444444444444',candidate:'22222222-2222-4222-8222-222222222222',next:'33333333-3333-4333-8333-333333333333'}
const bodies={baseline:'# 已加载手册\n\n旧版固定规则。',candidate:'# 候选手册一\n\n第一份候选规则。',next:'# 候选手册二\n\n切换后应显示这份规则。'}
type FixtureData={items:MarketItem[];load:IndustryLoadRecord}
type Request={contentId:string;hash:string;settled:boolean;resolve:(item:MarketItem)=>void;reject:(cause:Error)=>void}
const full=new Map<string,MarketItem>(),requests:Request[]=[],upgrades:IndustryLoadUpgradeInput[]=[]
async function source(key:keyof typeof ids,version:string):Promise<MarketItem>{
 const manifest={format:'teloa.business-package/v2',id:'update-preview-fixture',title:'摘要更新验收',version,domain:'general',scope:'general',description:'只读摘要升级比较',resources:[{id:'guide',kind:'knowledge',title:'手册',version,required:true,source:{kind:'local',path:'guide.md'}}],relations:[],entrypoints:[]}
 const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
 const item=await readIndustryDirectory([file('teloa.json',JSON.stringify(manifest)),file('guide.md',bodies[key])],'teloa.json','摘要更新验收')
 return {...item,id:'fixed-'+ids[key],hash:item.packageContent!.hash,contentStorage:{contentId:ids[key],createdAt:at,loaded:true}}
}
const summary=(item:MarketItem):MarketItem=>{const {packageContent:_content,...rest}=item;return {...rest,contentStorage:{...item.contentStorage!,loaded:false}}}
const hydrate=(item:MarketItem):Promise<MarketItem>=>new Promise((resolve,reject)=>requests.push({contentId:item.contentStorage!.contentId,hash:item.hash!,settled:false,resolve,reject}))
const release=(index:number,outcome='success')=>{
 const request=requests[index];if(!request||request.settled)return
 request.settled=true
 if(outcome==='error'){request.reject(Object.assign(Error('Fixture offline'),{code:'teloa/source-unavailable'}));return}
 const value=structuredClone(full.get(request.contentId)!)
 if(outcome==='wrong-hash')value.packageContent={...value.packageContent!,hash:'b'.repeat(64)}
 if(outcome==='wrong-id')value.contentStorage={...value.contentStorage!,contentId:'99999999-9999-4999-8999-999999999999'}
 request.resolve(value)
}
const initial=async():Promise<FixtureData>=>{
 const items=await Promise.all([source('baseline','1.0.0'),source('candidate','1.0.1'),source('next','1.0.2')]);for(const item of items)full.set(item.contentStorage!.contentId,item)
 return {items:items.map(summary),load:{id:loadId,ownerId:'fixture-owner',contentId:ids.baseline,contentHash:items[0]!.packageContent!.hash,templateId:'update-preview-fixture',templateVersion:'1.0.0',templateTitle:'摘要更新验收',domain:'general',scope:'general',description:'摘要基线',targetVersion:1,space:{id:spaceId,name:'验收团队',version:1,scope:'space-'+spaceId},items:[{localId:'guide',instanceId:'77777777-7777-4777-8777-777777777777',kind:'knowledge',title:'手册',version:'1.0.0',required:true,status:'instantiated'}],relations:[],entrypoints:[],createdAt:at,mappingHash,status:'active'}}
}
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
function App(){
 const [data,setData]=useState<FixtureData>()
 useEffect(()=>{void initial().then(setData)},[])
 Object.assign(window,{updatePreviewFixture:{ids,loadId,mappingHash,bodies,requests,upgrades,release,resolvePending:()=>requests.forEach((request,index)=>{if(!request.settled)release(index)}),hash:(id:string)=>full.get(id)?.hash}})
 return <main className={tokens.tokens} style={{...prototypeThemes.light,minHeight:'100vh',padding:24,background:'var(--teloa-background)',color:'var(--teloa-text)'} as any}>{data&&<IndustryUpdatePreview item={data.items[1]!} items={data.items} spaces={[]} context={{industryRoles:[],tasks:[],plans:[]}} open={()=>{}} loads={[data.load]} upgrade={async input=>{upgrades.push(structuredClone(input))}} rolesReady rolesFailed={false} refreshRoles={()=>{}} hydrate={hydrate}/>}</main>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
