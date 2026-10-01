import type {ReactNode} from 'react'
import {Clock3,Folder,Info,TriangleAlert,Waypoints} from 'lucide-react'
import type {EvidenceEntry,SecurityReversibility,SecurityRiskTier} from '@teloa/contract'
import type {AttentionItem} from './attention-item.js'
import {attentionNextStepKey} from './attention-decision.js'
import {attentionReasonText} from './attention-item.js'
import {EvidenceList} from './EvidenceList.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import {useI18n} from './i18n/provider.js'
import css from './AttentionDecisionCard.module.css'

export type DecisionRequest={title:string;targets:readonly string[]}

/** 风险行要自己说全：分级、可逆性、目标集大小，缺一项这行就等于没说。 */
export type AttentionRiskFacts={riskTier:SecurityRiskTier;reversible:SecurityReversibility;targets:number}

/**
 * 请求名称与涉及对象由业务适配层提供；来源、依据、下一步使用通用结构。
 * 仅有风险事实时展示分级；安全动作缺失事实时仍明确提示不可用。
 * 依据行是叙述，走 Markdown 固定子集；远程图片一律不加载，免得把“谁在看这条依据”
 * 泄露给图片主机。
 */
export function AttentionDecisionCard({id,item,sourceName,scopeName,occurred,summary,risk,request,evidence,actions}:{
 id:string;item:AttentionItem;sourceName:string;scopeName:string;occurred:string
 request?:DecisionRequest|undefined
 summary?:string|undefined;risk?:AttentionRiskFacts|undefined
 evidence:readonly EvidenceEntry[];actions:ReactNode
}){
 const {t}=useI18n()
 // 依据 = 事项原因 + 对象摘要（任务目标 / 动作 goal / 交接原因），两者都可能为空。
 const basis=[attentionReasonText(item.reason,key=>t(key)),evidence.some(entry=>entry.kind==='text'&&entry.body.trim()===summary?.trim())?undefined:summary?.trim()].filter(value=>value!==undefined&&value!=='').join('\n\n')
 return <div className={css.card} id={id}>
  {request&&<section className={css.request} aria-label={t('attention.request.title')}>
   <h3>{request.title}</h3>
   <div><span>{t('attention.request.targets')}</span><ul>{request.targets.map(target=><li key={target}>{target}</li>)}</ul></div>
  </section>}
  <dl className={css.rows}>
   <div><dt>{t('attention.row.source')}</dt><dd><span className={css.badges}><span className={css.metadata}><Waypoints size={13} aria-hidden="true"/>{sourceName}</span><span className={css.metadata}><Folder size={13} aria-hidden="true"/>{scopeName}</span><span className={css.metadata}><Clock3 size={13} aria-hidden="true"/>{occurred}</span></span></dd></div>
   <div><dt>{t('attention.row.basis')}</dt><dd><MarkdownPreview markdown={basis} empty={t('evidence.emptyBody')} images={false}/></dd></div>
   <div><dt>{t('attention.row.next')}</dt><dd>{t(attentionNextStepKey(item))}</dd></div>
   {(risk!==undefined||item.target.kind==='security-action')&&<div><dt>{t('attention.row.risk')}</dt><dd>{risk===undefined
    ?t('attention.row.riskUnavailable')
    :<span className={css.badges}>
      <span className={css.risk} data-risk={risk.riskTier}>{risk.riskTier==='low'?<Info size={14} aria-hidden="true"/>:<TriangleAlert size={14} aria-hidden="true"/>}{t('security.risk.'+risk.riskTier as 'security.risk.low')}</span>
      <span className={css.metadata}>{t('security.reversible.'+risk.reversible as 'security.reversible.reversible')}</span>
      <span className={css.metadata}>{t('attention.security.targets',{count:risk.targets})}</span>
    </span>}</dd></div>}
  </dl>
  <EvidenceList entries={evidence} compact/>
  <div className={css.actions}>{actions}</div>
 </div>
}
