import { Check, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import css from './GuidedSetup.module.css'
import {useI18n} from './i18n/provider.js'

export type GuidedSetupStep={
  title:string
  description:string
  state:'complete'|'current'|'upcoming'
  label?:string
}

export function GuidedSetup({title,description,steps}:{title:string;description:string;steps:readonly GuidedSetupStep[]}){
  const {t}=useI18n()
  return <section className={css.guide} aria-label={title}>
    <header><div><span>{t('p6.guidedSetup.path')}</span><h2>{title}</h2></div><p>{description}</p></header>
    <ol>{steps.map((step,index)=><li key={step.title} className={clsx(step.state==='current'&&css.current,step.state==='complete'&&css.complete)} aria-current={step.state==='current'?'step':undefined}>
      <span className={css.index}>{step.state==='complete'?<Check size={14}/>:index+1}</span>
      <span className={css.copy}><strong>{step.title}</strong><small>{step.description}</small></span>
      <span className={css.state}>{step.label??t(step.state==='complete'?'p6.guidedSetup.complete':step.state==='current'?'p6.guidedSetup.current':'p6.guidedSetup.upcoming')}</span>
      {index<steps.length-1&&<ChevronRight className={css.arrow} size={15} aria-hidden="true"/>}
    </li>)}</ol>
  </section>
}
