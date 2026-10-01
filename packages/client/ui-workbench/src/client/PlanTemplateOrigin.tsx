import type { PlanTemplate } from './plan-template.js'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'

export function PlanTemplateOrigin({template,open}:{template:PlanTemplate;open:(id:string)=>void}){
  const {t}=useI18n()
  return <section className={css.block} aria-label={t('planTemplate.aria')}><header><h3>{t('planTemplate.title',{title:template.title})}</h3><button type="button" onClick={()=>open(template.itemId)}>{t('planTemplate.open')}</button></header><p>{template.version} · {t(template.example?'planTemplate.example':'planTemplate.parsed')} · {template.source}</p><p className={css.muted}>{t('planTemplate.boundary')}</p><details><summary>{t('planTemplate.details')}</summary><p>{template.description}</p><h4>{t('planTemplate.inputs')}</h4><ul>{template.requirements.map((value,index)=><li key={index}>{value}</li>)}</ul><h4>{t('planTemplate.output')}</h4><p>{template.output}</p><h4>{t('planTemplate.skills')}</h4>{template.skills.length?<ul>{template.skills.map((skill,index)=><li key={index}>{skill.title} · {skill.id} · {skill.version} · {t('planTemplate.review')}</li>)}</ul>:<p>{t('planTemplate.noSkills')}</p>}<p>{t('planTemplate.author',{author:template.author})}</p><p>{t('planTemplate.license',{license:template.license})}</p><p>{t('planTemplate.id',{id:template.templateId})}</p>{template.hash&&<p>{t('planTemplate.hash',{hash:template.hash})}</p>}</details></section>
}
