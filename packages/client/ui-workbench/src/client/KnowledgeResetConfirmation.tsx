import type {KnowledgeResetPreview} from './knowledge-reset.js'
import {useI18n} from './i18n/provider.js'
import css from './KnowledgeDocument.module.css'
export function KnowledgeResetConfirmation({preview,busy,confirm,cancel}:{preview:KnowledgeResetPreview;busy:boolean;confirm:()=>void;cancel:()=>void}){
 const {t}=useI18n()
 return <section className={css.resetConfirmation} aria-label={t('employeeKnowledge.reset.title')}><h4>{t('employeeKnowledge.reset.title')}</h4><p>{t('employeeKnowledge.reset.description',{count:preview.documents.length})}</p><ul>{preview.documents.map(row=><li key={row.roleId+':'+row.resourceId}><strong>{row.title}</strong><span>v{row.bodyVersion}</span></li>)}</ul><div className={css.documentActions}><button type="button" disabled={busy} onClick={cancel}>{t('knowledge.manager.cancel')}</button><button type="button" className={css.save} disabled={busy} onClick={confirm}>{busy?t('knowledge.ui.043'):t('employeeKnowledge.reset.confirm')}</button></div></section>
}
