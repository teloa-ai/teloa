import {readMarketRatings,readMarketReviewPage,readMarketOwnReview,readMarketAccountStatus,readMarketLinkStart,readMarketLinkPoll,checkMarketReviewInput,type MarketRatings,type MarketReviewPage,type MarketOwnReview,type MarketAccountStatus,type MarketLinkStart,type MarketLinkPoll} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type MarketReviewsApi=ReturnType<typeof createMarketReviewsApi>

/** 市场评价（规格 §12、§13）：回包一律按契约读取器严格校验；发表前本机先校验，界面另有二次确认。 */
export function createMarketReviewsApi(call:Call){
 return {
  summary:async():Promise<MarketRatings>=>readMarketRatings(await call('market-reviews/summary',{})),
  list:async(entryId:string):Promise<MarketReviewPage>=>readMarketReviewPage(await call('market-reviews/list',{entryId})),
  account:async():Promise<MarketAccountStatus>=>readMarketAccountStatus(await call('market-reviews/account',{})),
  linkStart:async():Promise<MarketLinkStart>=>readMarketLinkStart(await call('market-reviews/link-start',{})),
  /** `{cancel:true}` 让宿主丢弃设备码：之后网页上误点「允许」也不会被这台设备领取。 */
  linkPoll:async(options?:{cancel:true}):Promise<MarketLinkPoll>=>readMarketLinkPoll(await call('market-reviews/link-poll',options?.cancel?{cancel:true}:{})),
  unlink:async():Promise<MarketAccountStatus>=>readMarketAccountStatus(await call('market-reviews/unlink',{})),
  mine:async(entryId:string):Promise<MarketOwnReview|null>=>readMarketOwnReview(await call('market-reviews/mine',{entryId})),
  publish:async(entryId:string,input:{rating:number;body:string}):Promise<MarketOwnReview>=>{
   const checked=checkMarketReviewInput(input)
   const review=readMarketOwnReview(await call('market-reviews/publish',{entryId,...checked}))
   if(!review)throw Error('评价回执格式不正确。')
   return review
  },
  remove:async(entryId:string):Promise<void>=>{
   const value=await call('market-reviews/delete',{entryId})
   if(!value||typeof value!=='object'||(value as {deleted?:unknown}).deleted!==true)throw Error('删除回执格式不正确。')
  },
 }
}
