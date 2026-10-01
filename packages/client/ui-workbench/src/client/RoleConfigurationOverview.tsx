import type { PreviewRole } from './role-preview.js'
import type { RoleConfigurationRelation } from './role-configuration-relations.js'
import {useI18n} from './i18n/provider.js'
import css from './RoleConfigurationOverview.module.css'

export function RoleConfigurationOverview({role,relations}:{role:PreviewRole;relations:readonly RoleConfigurationRelation[]}){
  const {t}=useI18n()
  return <section className={css.overview} aria-label={t('roleOverview.aria')}>
    <header><div><span>{t('roleOverview.relationships')}</span><h3>{t('roleOverview.configuration',{name:role.name,version:role.version})}</h3></div><small>{t(role.storage==='persistent'?'roleOverview.saved':'roleOverview.example')} · {t(role.kind==='twin'?'roleOverview.twin':'roleOverview.employee')}</small></header>
    <ol className={css.path}>
      {relations.map(relation=><li key={relation.label}><span>{relation.label}</span><strong>{relation.detail}</strong><small>{relation.note}</small></li>)}
    </ol>
  </section>
}
