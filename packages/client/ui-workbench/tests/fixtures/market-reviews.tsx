import {createRoot} from 'react-dom/client'
import {MarketReviews} from '../../src/client/MarketReviews.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {ProductLocale} from '../../src/client/i18n/locale.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import type {MarketReviewsApi} from '../../src/client/market-reviews-api.js'
import type {MarketAccountStatus,MarketOwnReview} from '@teloa/contract'

// 仅替换接口：真实 React、DOM、effect、事件与词典都在浏览器运行；不连接宿主或公共市场。
const locale=(document.documentElement.lang||'zh-CN') as ProductLocale
const snapshot={locale,dshLocale:'zh',revision:1}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage(locale,key,params)} as TeloaI18n
const stamp='2026-09-27T00:00:00.000Z'
const state={
 account:{linked:true,nickname:'测试用户',provider:'email'} as MarketAccountStatus,
 own:null as MarketOwnReview|null,
 calls:{} as Record<string,number>,
 publishError:null as string|null,
 published:[] as {rating:number;body:string}[],
}
const gates=new Map<string,{promise:Promise<void>;resolve:()=>void}>()
async function called(name:string){
 state.calls[name]=(state.calls[name]??0)+1
 await gates.get(name)?.promise
}
const api:MarketReviewsApi={
 summary:async()=>({enabled:true,asOf:null,entries:[]}),
 list:async()=>{
  await called('list')
  return {entryId:'teloa.soc',count:2,avg:1,distribution:{1:2,2:0,3:0,4:0,5:0},claimedBy:null,nextCursor:null,items:[{id:'00000000-0000-4000-8000-000000000001',nickname:'مرحبا',rating:1,body:'<b>纯文本</b>',entryVersion:'1.0.0',createdAt:stamp,updatedAt:stamp,reply:null},{id:'00000000-0000-4000-8000-000000000002',nickname:'silent',rating:1,body:'',entryVersion:'1.0.0',createdAt:stamp,updatedAt:stamp,reply:null}]}
 },
 account:async()=>{await called('account');return {...state.account}},
 mine:async()=>{await called('mine');return state.own},
 linkStart:async()=>{await called('linkStart');return {userCode:'BCDF-GHJK',verificationUri:'https://market.teloa.ai/account/connect/?code=BCDF-GHJK',expiresAt:stamp,interval:3600}},
 linkPoll:async(options)=>{await called(options?.cancel?'cancel':'poll');return {status:options?.cancel?'idle':'pending'}},
 unlink:async()=>{await called('unlink');state.account={linked:false};return state.account},
 publish:async(_entryId,input)=>{
  await called('publish')
  if(state.publishError){state.account={linked:false};throw {code:state.publishError}}
  state.published.push({...input})
  state.own={id:'00000000-0000-4000-8000-000000000009',...input,entryVersion:'1.0.0',status:'pending',createdAt:stamp,updatedAt:stamp}
  return state.own
 },
 remove:async()=>{await called('remove');state.own=null},
}
Object.assign(window,{reviewFixture:{
 state,
 defer(name:string){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});gates.set(name,{promise,resolve})},
 release(name:string){gates.get(name)?.resolve();gates.delete(name)},
}})
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={runtime}><MarketReviews api={api} entryId="teloa.soc"/></I18nProvider>)
