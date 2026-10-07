import {useEffect,useRef,useState,useSyncExternalStore,type KeyboardEvent as ReactKeyboardEvent,type MouseEvent as ReactMouseEvent} from 'react'
import {Check,Clock3,Code2,Globe,Heart,Mail,MessageCircle,MessageSquare,ScanLine,X} from 'lucide-react'
import { BrandLogo,type BrandTheme } from './BrandLogo.js'
import wechatQrCode from '../assets/about/wechat-official-account.jpg'
import personalQrCode from '../assets/about/wechat-contact.jpg'
import rewardQrCode from '../assets/about/wechat-support.jpg'
import paypalQrCode from '../assets/about/paypal-support.jpg'
import css from './AboutSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {supportQrKind} from './support-qr.js'
import {TeloaFeedbackForm} from './TeloaFeedback.js'
import {TeloaFeedbackModel} from './TeloaFeedbackClient.js'
import {applicationPresentation,applicationProductName} from './application-presentation.js'

type QrKind='author'|'community'|'support'

// 版本说明与当前能力分开标记；尚未发布的方案不提供购买入口。
const PLAN_CARDS=[
  {id:'community',product:'Free',tagline:'about.plans.card.community.tagline',items:['about.plans.card.community.item1','about.plans.card.community.item2','about.plans.card.community.item3','about.plans.card.community.item4']},
  {id:'pro',product:'Pro',tagline:'about.plans.card.pro.tagline',items:['about.plans.card.pro.item1','about.plans.card.pro.item2','about.plans.card.pro.item3','about.plans.card.pro.item4','about.plans.card.pro.item5','about.plans.card.pro.item6']},
  {id:'enterprise',product:'Enterprise',tagline:'about.plans.card.enterprise.tagline',items:['about.plans.card.enterprise.item1','about.plans.card.enterprise.item2','about.plans.card.enterprise.item3','about.plans.card.enterprise.item4','about.plans.card.enterprise.item5','about.plans.card.enterprise.item6']},
] as const

export function AboutSettings({theme}:{theme:BrandTheme}){
  const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
  const {locale,t}=useI18n()
  const showWechat=supportQrKind(locale)==='wechat'
  const [activeQr,setActiveQr]=useState<QrKind>()
  const [feedbackOpen,setFeedbackOpen]=useState(false)
  const [feedbackModel]=useState(()=>new TeloaFeedbackModel(undefined,__TELOA_VERSION__))
  const opener=useRef<HTMLButtonElement>()
  const openQr=(kind:QrKind,event:ReactMouseEvent<HTMLButtonElement>)=>{opener.current=event.currentTarget;setActiveQr(kind)}
  const closeQr=()=>{setActiveQr(undefined);queueMicrotask(()=>opener.current?.focus({preventScroll:true}))}
  return <section className={css.about} aria-label={t('about.studio')}>
    <header className={css.brandHeader}><div className={css.identity}><div className={css.brandRow}><div className={css.brandName}><BrandLogo theme={theme} height={19}/></div></div><p>{t('about.studio')}</p></div><div className={css.release}><span>v{__TELOA_VERSION__}</span><span>{t('about.local')}</span></div><p className={css.headerTagline}>{t('about.tagline')}</p></header>
    <section className={css.plansSection} aria-label={t('about.plans.title')}>
      <div className={css.plansHeader}>
        <h2>{t('about.plans.title')}</h2>
      </div>
      <div className={css.plansGrid}>
        {PLAN_CARDS.map(card=><article key={card.id} className={card.product===application.product?`${css.planCard} ${css.planCardCurrent}`:css.planCard}>
          <span className={css.planBadge}>{t(card.product===application.product?(card.id==='community'?'about.plans.card.community.badge':'about.plans.current'):card.id==='community'?'about.plans.available':'about.plans.planned')}</span>
          <strong className={css.planName}>{applicationProductName(card.product,locale)}</strong>
          {'tagline' in card&&<p className={css.planTagline}>{t(card.tagline)}</p>}
          <ul>{card.items.map(item=><li key={item}>{card.id==='enterprise'||card.id==='pro'&&item==='about.plans.card.pro.item5'?<Clock3 size={14} aria-hidden/>:<Check size={14} aria-hidden/>}{t(item)}</li>)}</ul>
        </article>)}
      </div>
      <p className={css.plansNote}>{t('about.plans.relation')} <span className={css.plansMore}>{t('about.plans.more')}<a href="https://teloa.ai" target="_blank" rel="noreferrer">teloa.ai</a></span></p>
    </section>
    <section className={css.connectionSummary} aria-label={t('about.connections')}>
      <div className={css.contactIdentity}>
        <span className={css.contactLabel}>{t('about.developer')}</span>
        <span className={css.contactNames}><strong>Max Luo</strong><i aria-hidden>·</i><strong>Morgan Chen</strong><i aria-hidden>·</i><strong>Caleb Pan</strong></span>
      </div>
      <div className={css.contactRow}>
        <div className={css.contactLinks}>
          <a href="https://teloa.ai" target="_blank" rel="noreferrer"><Globe size={14} aria-hidden/>teloa.ai</a>
          <a href="https://github.com/teloa-ai/" target="_blank" rel="noreferrer"><Code2 size={14} aria-hidden/>GitHub</a>
        </div>
        <div className={css.connectionActions}>
          {showWechat&&<button type="button" onClick={event=>openQr('author',event)}><MessageCircle size={14} aria-hidden/>{t('about.author')}</button>}
          {showWechat&&<button type="button" onClick={event=>openQr('community',event)}><ScanLine size={14} aria-hidden/>{t('about.followAccount')}</button>}
          <button type="button" onClick={event=>openQr('support',event)}><Heart size={14} aria-hidden/>{t('about.support')}</button>
        </div>
      </div>
      <div className={css.contactEmails}>
        <div className={css.contactCard}>
          <h3 className={css.contactCardTitle}><MessageSquare size={16} aria-hidden/>{t('about.contactSupport')}</h3>
          <div className={css.contactCardActions}>
            <a href="mailto:support@teloa.ai">support@teloa.ai</a>
            <button type="button" className={css.feedbackButton} onClick={()=>setFeedbackOpen(true)} aria-haspopup="dialog">{t('feedback.open')}</button>
          </div>
        </div>
        <div className={css.contactCard}>
          <h3 className={css.contactCardTitle}><Mail size={16} aria-hidden/>{t('about.contactBusiness')}</h3>
          <div className={css.contactCardActions}><a href="mailto:hi@teloa.ai">hi@teloa.ai</a></div>
        </div>
      </div>
      <p className={css.foundationLine}>{t('about.foundationDescription')}</p>
    </section>
    {activeQr&&<QrDialog kind={activeQr} close={closeQr}/>} 
    {feedbackOpen&&<TeloaFeedbackForm model={feedbackModel} onClose={()=>setFeedbackOpen(false)}/>}
  </section>
}

function QrDialog({kind,close}:{kind:QrKind;close:()=>void}){
  const {locale,t}=useI18n()
  const closeButton=useRef<HTMLButtonElement>(null)
  useEffect(()=>{closeButton.current?.focus({preventScroll:true})},[])
  const supportQr=supportQrKind(locale)==='wechat'
    ? {src:rewardQrCode,viewBox:'212 266 404 404',width:828,height:1124}
    : {src:paypalQrCode,viewBox:'290 940 600 600',width:1179,height:2556}
  const details=kind==='author'
    ? {title:t('about.author'),description:`${t('about.wechat')} · neteyes`,src:personalQrCode,viewBox:'100 268 688 688',width:888,height:1131,caption:t('about.addWechat')}
    : kind==='community'
      ? {title:t('about.followAccount'),description:`${t('about.officialAccount')} · 白帽子罗棋琛`,src:wechatQrCode,viewBox:'0 0 430 430',width:430,height:430,caption:t('about.followAccount')}
      : {title:t('about.support'),description:t('about.supportDescription'),...supportQr,caption:t('about.rewardCaption')}
  const onKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){event.preventDefault();close()}
    if(event.key==='Tab'){event.preventDefault();closeButton.current?.focus()}
  }
  return <div className={css.dialogBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget)close()}}>
    <div className={css.qrDialog} role="dialog" aria-modal="true" aria-labelledby="about-qr-title" tabIndex={-1} onKeyDown={onKeyDown}>
      <header><div><h2 id="about-qr-title">{details.title}</h2><p>{details.description}</p></div><button ref={closeButton} type="button" aria-label={t('about.close')} onClick={close}><X size={18}/></button></header>
      <QrCode src={details.src} viewBox={details.viewBox} width={details.width} height={details.height} label={details.title} caption={details.caption}/>
    </div>
  </div>
}

// 使用原图像素的正方形视窗，保留二维码与静区，不重绘或改变扫码内容。
function QrCode({src,label,caption,viewBox,width,height}:{src:string;label:string;caption:string;viewBox:string;width:number;height:number}){
  return <figure className={css.qrCode}>
    <svg className={css.qrImage} role="img" aria-label={label} viewBox={viewBox} width="196" height="196">
      <image href={src} width={width} height={height}/>
    </svg>
    <figcaption>{caption}</figcaption>
  </figure>
}
