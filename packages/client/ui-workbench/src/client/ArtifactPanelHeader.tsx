import type {ReactNode} from 'react'
import {useI18n} from './i18n/provider.js'
import css from './ArtifactPanel.module.css'

/** 本人和群内只读成果共用标题与动作层级，权限仍由各自读取口持有。 */
export function ArtifactPanelHeader({count,children}:{count:number;children:ReactNode}){
 const {t}=useI18n()
 return <header><div className={css.panelTitle}><strong>{t('artifact.panel.text.006')}</strong><span>{count}</span></div><div className={css.previewActions}>{children}</div></header>
}
