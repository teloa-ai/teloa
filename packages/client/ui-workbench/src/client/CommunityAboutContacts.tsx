import {useEffect,useRef,useState,useSyncExternalStore,type KeyboardEvent as ReactKeyboardEvent,type MouseEvent as ReactMouseEvent} from 'react'
import {Code2,Heart,MessageCircle,ScanLine,X} from 'lucide-react'
import wechatQrCode from '../assets/about/wechat-official-account.jpg'
import personalQrCode from '../assets/about/wechat-contact.jpg'
import rewardQrCode from '../assets/about/wechat-support.jpg'
import paypalQrCode from '../assets/about/paypal-support.jpg'
import css from './AboutSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {supportQrKind} from './support-qr.js'
import {applicationPresentation} from './application-presentation.js'
import {OfficialAboutContacts} from './OfficialAboutContacts.js'

type QrKind='author'|'community'|'support'

// 仅社区构建导入本模块；商业构建的依赖图不包含个人资料或二维码。
export function AboutContacts(){
 const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
 const {locale,t}=useI18n()
 const communityContacts=application.product==='Free'
 const showWechat=supportQrKind(locale)==='wechat'
 const [activeQr,setActiveQr]=useState<QrKind>()
 useEffect(()=>{if(!communityContacts)setActiveQr(undefined)},[communityContacts])
 const opener=useRef<HTMLButtonElement>()
 const openQr=(kind:QrKind,event:ReactMouseEvent<HTMLButtonElement>)=>{opener.current=event.currentTarget;setActiveQr(kind)}
 const closeQr=()=>{setActiveQr(undefined);queueMicrotask(()=>opener.current?.focus({preventScroll:true}))}
 if(!communityContacts)return <OfficialAboutContacts/>
 return <OfficialAboutContacts
  identity={<div className={css.contactIdentity}>
   <span className={css.contactLabel}>{t('about.developer')}</span>
   <span className={css.contactNames}><strong>Max Luo</strong><i aria-hidden>·</i><strong>Morgan Chen</strong><i aria-hidden>·</i><strong>Caleb Pan</strong></span>
  </div>}
  links={<a href="https://github.com/teloa-ai/" target="_blank" rel="noreferrer"><Code2 size={14} aria-hidden/>GitHub</a>}
  actions={<div className={css.connectionActions}>
   {showWechat&&<button type="button" onClick={event=>openQr('author',event)}><MessageCircle size={14} aria-hidden/>{t('about.author')}</button>}
   {showWechat&&<button type="button" onClick={event=>openQr('community',event)}><ScanLine size={14} aria-hidden/>{t('about.followAccount')}</button>}
   <button type="button" onClick={event=>openQr('support',event)}><Heart size={14} aria-hidden/>{t('about.support')}</button>
  </div>}>
  {activeQr&&<QrDialog kind={activeQr} close={closeQr}/>}
 </OfficialAboutContacts>
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
