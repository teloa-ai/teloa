import type {EvidenceEntry} from '@teloa/contract'
import {MarkdownPreview} from './knowledge-markdown.js'
import {useI18n} from './i18n/provider.js'
import css from './EvidenceList.module.css'

/**
 * 依据的三条格式规则在这里落地：叙述走 Markdown 固定子集，结构化字段走字段行，
 * 外部系统产出一律 pre/code 原样。分流点只有 kind 一个，避免“看起来像 Markdown 就渲染”。
 */
export function EvidenceList({entries,empty,compact=false}:{entries:readonly EvidenceEntry[];empty?:string;compact?:boolean}){
 const {t,dateTime}=useI18n()
 if(!entries.length)return <p className={css.empty}>{empty??t('evidence.empty')}</p>
 return <div className={compact?css.compact:css.list}>{entries.map((entry,index)=>{
  const key=entry.kind+'-'+index+'-'+entry.title
  // 来源与采集时间是核对依据本身的可信度所必需的，缺一项就少一行，不编造占位。
  const facts:Array<[string,string]>=[]
  if(entry.source)facts.push([t('evidence.source'),entry.source])
  if(entry.observedAt)facts.push([t('evidence.observedAt'),dateTime(entry.observedAt)])
  return <section className={css.entry} key={key} aria-label={entry.title}>
   <h4>{entry.title}</h4>
   {facts.length>0&&<dl className={css.facts}>{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
   {entry.kind==='text'
    // 依据可能来自外部系统，叙述里的图片一律不加载：远程图片会把“谁在看这条依据”泄露给图片主机。
    ?<div className={css.narrative}><MarkdownPreview markdown={entry.body} empty={t('evidence.emptyBody')} images={false}/></div>
    :<pre className={css.raw} role="region" aria-label={t(entry.kind==='log'?'evidence.rawLog':'evidence.rawCommand')} tabIndex={0}><code>{entry.body}</code></pre>}
  </section>
 })}</div>
}
