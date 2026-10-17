import type {MouseEvent, ReactNode, Ref} from 'react'
import {useI18n} from './i18n/provider.js'
import {conversationHeaderCopy} from './conversation-header-copy.js'
import css from './EmployeeConversationHeader.module.css'

/** 只呈现外壳已核实的原员工身份；不替换独立子会话的原生导航。 */
export function EmployeeConversationHeader({name,avatar,topic,viewProfile,profileOpen,profileRef}:{
  name:string;avatar:ReactNode;topic?:string|undefined;viewProfile?:(event:MouseEvent<HTMLButtonElement>)=>void;profileOpen?:boolean;profileRef?:Ref<HTMLButtonElement>
}){
  const {t,locale}=useI18n()
  const identity=<><span className={css.avatar}>{avatar}</span><span className={css.text}><span className={css.name} title={name}>{name}</span><span className={css.topic} title={topic} aria-label={conversationHeaderCopy(locale,'topic')}>{topic}</span></span></>
  return <div className={css.header}><h1 aria-label={name}>{viewProfile
    ? <button type="button" ref={profileRef} className={css.identity} aria-label={`${t('frame.context.viewProfile')} · ${name}`} aria-expanded={profileOpen} onClick={viewProfile}>{identity}</button>
    : <span className={css.identity}>{identity}</span>}</h1></div>
}
