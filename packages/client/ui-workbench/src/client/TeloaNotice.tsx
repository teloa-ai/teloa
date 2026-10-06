import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react'
import clsx from 'clsx'
import tokens from './theme-tokens.module.css'
import css from './TeloaNotice.module.css'
import {useI18n} from './i18n/provider.js'
import {applicationPresentation} from './application-presentation.js'
import {TELOA_NOTICE_VERSION,noticeStorage,readNoticeAcknowledged,writeNoticeAcknowledged} from './teloa-notice.js'

const titleId='teloa-notice-title'

/** Teloa 个人版预览声明；取代 DSH 内测声明，排在 DSH 的 API Key 引导之前。 */
export function TeloaNotice({complete}:{complete:()=>void}){
  const {t}=useI18n()
  const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
  const applicable=application.product==='Free'
  // 首帧读取一次，避免同一次引导里因其它渲染反复切换显示状态。
  const [acknowledged]=useState(()=>applicable&&readNoticeAcknowledged(noticeStorage(),TELOA_NOTICE_VERSION))
  const title=useRef<HTMLHeadingElement>(null)
  const finished=useRef(false)
  const finish=useCallback(()=>{if(finished.current)return;finished.current=true;complete()},[complete])
  // 只在首次呈现时聚焦标题；complete 的身份每次重渲染都会变，不能把聚焦挂在它上面。
  useEffect(()=>{if(applicable&&!acknowledged)title.current?.focus({preventScroll:true})},[applicable,acknowledged])
  // 其他产品继续后续原生引导，不把跳过写成 Free 声明已确认。
  useEffect(()=>{if(!applicable||acknowledged)finish()},[applicable,acknowledged,finish])
  if(!applicable||acknowledged)return null
  return <div className={clsx(tokens.tokens,css.backdrop)}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId} ref={title} tabIndex={-1}>{t('notice.title')}</h2>
      <div className={css.copy}>{t('notice.body',{version:__TELOA_VERSION__}).split('\n\n').map(paragraph=><p key={paragraph}>{paragraph}</p>)}</div>
      {/* 写入失败不阻塞引导：仍然完成本步骤，只是下次启动还会看到声明。 */}
      <div className={css.actions}><button type="button" onClick={()=>{writeNoticeAcknowledged(noticeStorage(),TELOA_NOTICE_VERSION);finish()}}>{t('notice.continue')}</button></div>
    </div>
  </div>
}
