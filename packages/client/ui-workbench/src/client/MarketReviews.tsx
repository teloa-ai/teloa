import {useEffect,useId,useReducer,useRef,useState} from 'react'
import {Star} from 'lucide-react'
import {marketSignature,type MarketRating,type MarketRatingDistribution,type MarketReview,type MarketReviewPage,type MarketOwnReview,type MarketAccountStatus,type MarketLinkStart} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {MarketReviewsApi} from './market-reviews-api.js'
import css from './MarketCatalogSection.module.css'

/** 五颗单色 SVG 星（前 rating 颗实心）；只作装饰，可读的「N 星」由外层 aria-label 或文字给出。不用星形符号字符：部分浏览器会画成彩色 emoji。 */
export function ReviewStars({rating}:{rating:number}){
 return <span className={css.stars} aria-hidden="true">{[1,2,3,4,5].map(value=><Star key={value} size={12} strokeWidth={1.8} fill={value<=rating?'currentColor':'none'} data-filled={value<=rating?'true':'false'}/>)}</span>
}
/** 评分分布：5 星到 1 星五行横条（纯 CSS 条，整条 aria-hidden），每行文字写「N 星」与条数；与均分同口径，含只评分不写正文的评价。 */
export function ReviewDistribution({distribution}:{distribution:MarketRatingDistribution}){
 const {t,number}=useI18n()
 const total=distribution[1]+distribution[2]+distribution[3]+distribution[4]+distribution[5]
 return <ul className={css.distribution} aria-label={t('market.catalog.reviews.distribution')}>{([5,4,3,2,1] as const).map(stars=><li key={stars}>
  <span>{t(stars===1?'market.catalog.reviews.ratingOne':'market.catalog.reviews.ratingAria',{rating:stars})}</span>
  <span className={css.distributionBar} aria-hidden="true"><i style={{width:(total?distribution[stars]/total*100:0)+'%'}}/></span>
  <span>{number(distribution[stars])}</span>
 </li>)}</ul>
}
/** 发表文案按审核方式：只有先发后审（post）写「发表」与「任何人都能看到」；先审后发或未给出写「提交」与「提交后经审核公开」。 */
export const reviewPublishKeys=(status:{moderation?:'pre'|'post'})=>status.moderation==='post'
 ?{confirm:'market.catalog.reviews.confirm' as const,publish:'market.catalog.reviews.publish' as const,confirmPublish:'market.catalog.reviews.confirmPublish' as const}
 :{confirm:'market.catalog.reviews.confirmPending' as const,publish:'market.catalog.reviews.submit' as const,confirmPublish:'market.catalog.reviews.confirmSubmit' as const}
export const reviewSummaryLabel=(rating:MarketRating|undefined,format:(avg:number)=>string=avg=>avg.toFixed(1))=>rating?{key:'market.catalog.reviews.summary' as const,params:{avg:format(rating.avg),count:rating.count}}:{key:'market.catalog.reviews.title' as const,params:{}}

/**
 * 二次确认状态机（规格 §13）：发表确认时记下署名昵称快照；确认期间账号断开或换号（`account` 事件带来的昵称不同）即回到确认前，
 * 发表只在确认状态且署名未变时放行（`publishAllowed`）。
 */
export type ReviewConfirm={kind:'none'}|{kind:'publish';nickname:string}|{kind:'delete'}
export type ReviewConfirmEvent={type:'ask-publish';nickname:string}|{type:'ask-delete'}|{type:'cancel'}|{type:'done'}|{type:'account';nickname:string|null}
export function reviewConfirmReducer(state:ReviewConfirm,event:ReviewConfirmEvent):ReviewConfirm{
 switch(event.type){
  case 'ask-publish':return {kind:'publish',nickname:event.nickname}
  case 'ask-delete':return {kind:'delete'}
  case 'cancel':case 'done':return {kind:'none'}
  case 'account':
   if(event.nickname===null)return {kind:'none'}
   return state.kind==='publish'&&state.nickname!==event.nickname?{kind:'none'}:state
 }
}
export const publishAllowed=(state:ReviewConfirm,nickname:string|null)=>state.kind==='publish'&&nickname!==null&&state.nickname===nickname

type Props={api:MarketReviewsApi;entryId:string;rating?:MarketRating|undefined}

const errorCode=(reason:unknown)=>reason!==null&&typeof reason==='object'&&'code' in reason?(reason as {code?:unknown}).code:undefined
const nicknameOf=(status:MarketAccountStatus)=>status.linked?status.nickname:null
const isolateNickname=(nickname:string)=>`\u2068${nickname}\u2069`
/** 已连接账号的署名：GitHub 账号写 @用户名，邮箱账号写昵称。 */
const accountName=(status:{nickname:string;provider:'email'|'github'})=>isolateNickname(marketSignature(status.nickname,status.provider))

/**
 * 评价列表：只列有正文的评价（只评分的计入均分与分布，不进列表）；署名为 GitHub 用户名形态时写 @用户名。
 * 昵称、正文、回复全部按纯文本渲染（React 文本节点），评价字段一律不当链接地址；昵称与作者名用 bdi 隔离书写方向。
 */
export function MarketReviewList({items}:{items:readonly MarketReview[]}){
 const {t,date}=useI18n()
 return <ul>{items.filter(item=>item.body).map(item=><li key={item.id}>
  <p className={css.meta}><strong><bdi>{marketSignature(item.nickname)}</bdi></strong> · <span role="img" aria-label={t(item.rating===1?'market.catalog.reviews.ratingOne':'market.catalog.reviews.ratingAria',{rating:item.rating})}><ReviewStars rating={item.rating}/></span> · {item.entryVersion} · {date(item.updatedAt)}</p>
  <p className={css.reviewBody}>{item.body}</p>
  {item.reply&&<p className={css.meta}><strong><bdi>{item.reply.by==='teloa'?t('market.catalog.reviews.replyTeloa'):t('market.catalog.reviews.replyAuthor',{name:marketSignature(item.reply.name)})}</bdi></strong> <span className={css.reviewBody}>{item.reply.body}</span></p>}
 </li>)}</ul>
}

/**
 * 官方目录卡片的「评价」折叠区（规格 §12、§13、§14）：展开时才读取；未连接时只给「连接市场账号」（设备码，在浏览器完成授权，可取消）；
 * 发表与删除都要本人二次确认：进入确认前先重读账号，确认块写明署名账号、星级与将公开的全文并锁定表单，发表前再复核署名，变化即回到确认前。
 * 令牌失效（forbidden）后回到未连接并保留「请重新连接」提示直到本人再次操作；conflict / 限流按评价场景文案显示。
 */
export function MarketReviews({api,entryId,rating}:Props){
 const {t,locale,number}=useI18n()
 const [open,setOpen]=useState(false)
 const [revision,setRevision]=useState(0)
 const [page,setPage]=useState<MarketReviewPage>()
 const [account,setAccount]=useState<MarketAccountStatus>()
 const [mine,setMine]=useState<MarketOwnReview|null>(null)
 const [error,setError]=useState<string>()
 const [link,setLink]=useState<MarketLinkStart>()
 const [linkEnded,setLinkEnded]=useState(false)
 const [reconnect,setReconnect]=useState(false)
 const [draft,setDraft]=useState({rating:5,body:''})
 const [confirm,dispatch]=useReducer(reviewConfirmReducer,{kind:'none'})
 const [notice,setNotice]=useState<string>()
 const [busy,setBusy]=useState(false)
 const rootRef=useRef<HTMLDetailsElement>(null)
 const confirmTextId=useId()
 const zh=locale.startsWith('zh')

 useEffect(()=>{
  if(!open)return
  let active=true
  setError(undefined)
  void Promise.all([api.list(entryId),api.account()]).then(async([list,status])=>{
   if(!active)return
   setPage(list);setAccount(status)
   const own=status.linked?await api.mine(entryId):null
   if(!active)return
   setMine(own)
   if(own)setDraft({rating:own.rating,body:own.body})
  }).catch(reason=>{if(active)setError(t('market.catalog.reviews.failed',{reason:localizeWorkError(locale,reason)}))})
  return()=>{active=false}
 },[open,revision,api,entryId])

 // 连接轮询：按宿主给出的间隔；连接成功重新读取，过期、拒绝或失败即停
 useEffect(()=>{
  if(!link)return
  let active=true,timer:ReturnType<typeof setTimeout>|undefined
  const tick=()=>{timer=setTimeout(()=>{void api.linkPoll().then(result=>{
   if(!active)return
   if(result.status==='pending')return tick()
   setLink(undefined)
   if(result.status==='linked')setRevision(value=>value+1)
   else setLinkEnded(true)
  },reason=>{if(active){setLink(undefined);setError(t('market.catalog.reviews.actionFailed',{reason:localizeWorkError(locale,reason)}))}})},link.interval*1000)}
  tick()
  return()=>{active=false;if(timer)clearTimeout(timer)}
 },[link,api])

 // 操作结束、按钮恢复可用后再移动焦点；账号失效使表单卸载时回到「连接」。首次读取不抢焦点。
 const focus=(name:string)=>rootRef.current?.querySelector<HTMLElement>(`[data-teloa-focus="${name}"]`)?.focus()
 const previousFocus=useRef({confirm:confirm.kind,linking:link!==undefined,linked:account?.linked})
 useEffect(()=>{
  if(busy)return
  const was=previousFocus.current,next={confirm:confirm.kind,linking:link!==undefined,linked:account?.linked}
  previousFocus.current=next
  if(was.linked===true&&next.linked===false)focus('connect')
  else if(was.confirm!==next.confirm)focus(confirm.kind==='publish'?'confirm-publish':confirm.kind==='delete'?'confirm-delete':'submit')
  else if(was.linking!==next.linking)focus(next.linking?'cancel-connect':next.linked?'submit':'connect')
 },[confirm.kind,link,busy,account?.linked])

 /** 评价场景的失败文案：conflict 按动作区分、限流按码，其余走通用本地化。 */
 const failure=(reason:unknown,context:'connect'|'review')=>{
  const code=errorCode(reason)
  if(code==='teloa/conflict')return t(context==='connect'?'market.catalog.reviews.alreadyLinked':'market.catalog.reviews.selfEntry')
  if(code==='teloa/dependency-unavailable')return t('market.catalog.reviews.rateLimited')
  return t('market.catalog.reviews.actionFailed',{reason:localizeWorkError(locale,reason)})
 }
 const run=async(action:()=>Promise<void>,context:'connect'|'review')=>{
  setBusy(true);setNotice(undefined);setError(undefined)
  try{await action()}
  catch(reason){
   dispatch({type:'cancel'})
   // 令牌失效（宿主已删本机记录）：回到「未连接」，并保留「请重新连接」提示直到本人再次操作
   if(errorCode(reason)==='teloa/forbidden'){setReconnect(true);setLinkEnded(false);setRevision(value=>value+1)}
   else setError(failure(reason,context))
  }
  finally{setBusy(false)}
 }
 const connect=()=>run(async()=>{setLinkEnded(false);setReconnect(false);setLink(await api.linkStart())},'connect')
 const cancelConnect=()=>run(async()=>{setLink(undefined);await api.linkPoll({cancel:true})},'connect')
 const disconnect=()=>run(async()=>{dispatch({type:'cancel'});setAccount(await api.unlink());setReconnect(false);setMine(null);setDraft({rating:5,body:''})},'review')
 // 进入确认前重读账号：确认块上的署名必须是当下的账号
 const askPublish=()=>run(async()=>{
  const status=await api.account()
  setAccount(status)
  if(!status.linked){setMine(null);setReconnect(true);return}
  dispatch({type:'ask-publish',nickname:status.nickname})
 },'review')
 const publish=()=>run(async()=>{
  // 发表前复核署名：与确认块上的昵称不一致（断开、换号、改名）即回到确认前，不发表
  const status=await api.account(),current=nicknameOf(status)
  setAccount(status)
  if(!publishAllowed(confirm,current)){
   dispatch({type:'account',nickname:current})
   if(current===null){setMine(null);setReconnect(true)}
   setNotice(t('market.catalog.reviews.accountChanged'))
   return
  }
  const review=await api.publish(entryId,draft)
  dispatch({type:'done'})
  setMine(review)
  setNotice(t(review.status==='visible'?'market.catalog.reviews.published':review.status==='pending'?'market.catalog.reviews.pending':'market.catalog.reviews.hidden'))
  setRevision(value=>value+1)
 },'review')
 const remove=()=>run(async()=>{await api.remove(entryId);dispatch({type:'done'});setMine(null);setDraft({rating:5,body:''});setNotice(t('market.catalog.reviews.deleted'));setRevision(value=>value+1)},'review')
 const summary=reviewSummaryLabel(rating,avg=>number(avg,{minimumFractionDigits:1,maximumFractionDigits:1}))
 const locked=busy||confirm.kind!=='none'

 return <details ref={rootRef} className={css.details} data-teloa-reviews={entryId} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{t(summary.key,summary.params)}</summary>
  {error&&<p className={css.error} role="alert">{error} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('market.catalog.official.retry')}</button></p>}
  {open&&!page&&!error&&<p className={css.status} role="status">{t('market.catalog.reviews.loading')}</p>}
  {page?.distribution&&page.count>0&&<ReviewDistribution distribution={page.distribution}/>}
  {page&&(page.items.some(item=>item.body)?<MarketReviewList items={page.items}/>:<p className={css.status}>{t(page.count?'market.catalog.reviews.noText':'market.catalog.reviews.empty')}</p>)}
  {page&&<p className={css.meta}>
   <a href={`https://market.teloa.ai/${zh?'':'en/'}${entryId}/#reviews`} target="_blank" rel="noreferrer">{t('market.catalog.reviews.viewAll')}</a> · <a href={`https://docs.teloa.ai/${zh?'':'en/'}reference/market-reviews`} target="_blank" rel="noreferrer">{t('market.catalog.reviews.privacy')}</a>
  </p>}
  {account&&!account.linked&&<div className={css.actions} data-teloa-reviews-account="unlinked">
   {link?<>
    <span role="status">{t('market.catalog.reviews.connectCode',{code:link.userCode})}</span>
    <a href={link.verificationUri} target="_blank" rel="noreferrer">{t('market.catalog.reviews.connectOpen')}</a>
    <button type="button" data-teloa-focus="cancel-connect" disabled={busy} onClick={()=>void cancelConnect()}>{t('market.catalog.reviews.connectCancel')}</button>
   </>:<>
    <span role={reconnect?'status':undefined}>{t(reconnect?'market.catalog.reviews.reconnect':linkEnded?'market.catalog.reviews.connectExpired':'market.catalog.reviews.connectHint')}</span>
    <button type="button" className={css.primary} data-teloa-focus="connect" disabled={busy} onClick={()=>void connect()}>{t('market.catalog.reviews.connect')}</button>
   </>}
  </div>}
  {account?.linked&&<form className={css.reviewForm} data-teloa-reviews-account="linked" onSubmit={event=>{event.preventDefault();void askPublish()}}>
   <div className={css.actions}><span>{t('market.catalog.reviews.connected',{nickname:accountName(account)})}</span><button type="button" disabled={locked} onClick={()=>void disconnect()}>{t('market.catalog.reviews.disconnect')}</button></div>
   {mine&&mine.status!=='visible'&&<p className={css.status}>{t(mine.status==='pending'?'market.catalog.reviews.pending':'market.catalog.reviews.hidden')}</p>}
   <label>{t('market.catalog.reviews.rating')} <select value={draft.rating} disabled={locked} onChange={event=>setDraft({...draft,rating:Number(event.target.value)})}>{[5,4,3,2,1].map(value=><option key={value} value={value}>{t(value===1?'market.catalog.reviews.ratingOne':'market.catalog.reviews.ratingAria',{rating:value})}</option>)}</select></label>
   <label>{t('market.catalog.reviews.body')} <textarea value={draft.body} maxLength={2000} rows={3} disabled={locked} onChange={event=>setDraft({...draft,body:event.target.value})}/></label>
   {confirm.kind==='publish'?<div className={css.confirm} role="group" aria-label={t(reviewPublishKeys(account).confirmPublish)}>
    <p id={confirmTextId}>{t(reviewPublishKeys(account).confirm,{nickname:accountName({nickname:confirm.nickname,provider:account.provider}),stars:t(draft.rating===1?'market.catalog.reviews.ratingOne':'market.catalog.reviews.ratingAria',{rating:draft.rating})})}</p>
    {draft.body.trim()&&<p className={css.reviewBody}>{draft.body}</p>}
    <div className={css.actions}>
     <button type="button" className={css.primary} data-teloa-focus="confirm-publish" aria-describedby={confirmTextId} disabled={busy} onClick={()=>void publish()}>{t(reviewPublishKeys(account).confirmPublish)}</button>
     <button type="button" disabled={busy} onClick={()=>dispatch({type:'cancel'})}>{t('market.catalog.reviews.cancel')}</button>
    </div>
   </div>:confirm.kind==='delete'?<div className={css.actions} role="group" aria-label={t('market.catalog.reviews.delete')}>
    <span id={confirmTextId}>{t('market.catalog.reviews.confirmDelete')}</span>
    <button type="button" className={css.primary} data-teloa-focus="confirm-delete" aria-describedby={confirmTextId} disabled={busy} onClick={()=>void remove()}>{t('market.catalog.reviews.delete')}</button>
    <button type="button" disabled={busy} onClick={()=>dispatch({type:'cancel'})}>{t('market.catalog.reviews.cancel')}</button>
   </div>:<div className={css.actions}>
    <button type="submit" className={css.primary} data-teloa-focus="submit" disabled={busy}>{t(mine?'market.catalog.reviews.update':reviewPublishKeys(account).publish)}</button>
    {mine&&<button type="button" disabled={busy} onClick={()=>dispatch({type:'ask-delete'})}>{t('market.catalog.reviews.delete')}</button>}
   </div>}
   {notice&&<p className={css.status} role="status">{notice}</p>}
  </form>}
 </details>
}
