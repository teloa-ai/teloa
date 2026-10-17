import type {ReactNode} from 'react'
import {ChevronRight,Download,FileText} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import css from './ConversationWorkOverview.module.css'

/** 会话与群概况共用成果行；动作由原对象端口提供，不另建成果或推断版本。 */
export function WorkArtifactCard({label,detail,onPreview,onDownload}:{label:string;detail:ReactNode;onPreview?:(()=>void)|undefined;onDownload?:(()=>void)|undefined}){
 const {t}=useI18n()
 return <article className={css.artifactCard} data-teloa-artifact-row="true">
  <button type="button" className={css.artifactPreview} aria-label={t('overview.previewAria',{name:label})} disabled={!onPreview} onClick={onPreview}>
   <span className={css.fileIcon}><FileText size={22}/></span><span className={css.fileInfo}><strong>{label}</strong><small>{detail}</small></span><ChevronRight size={15}/>
  </button>
  {onDownload&&<button type="button" className={css.iconButton} aria-label={t('overview.downloadAria',{name:label})} onClick={onDownload}><Download size={16}/></button>}
 </article>
}
