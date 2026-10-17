import {BookOpen,ListTree,Users} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import css from './GroupContextStart.module.css'

/** “开始”只列当前群的有效入口，不继承上一单聊的本地目录或终端权限。 */
export function GroupContextStart({open}:{open:(panel:'overview'|'materials'|'members')=>void}){
 const {t}=useI18n()
 return <section className={css.root} aria-label={t('group.panel.start')}><p>{t('group.panel.startHint')}</p>{([['overview','overview.title',ListTree],['materials','collaboration.view.materials',BookOpen],['members','group.panel.members',Users]] as const).map(([panel,key,Icon])=><button type="button" key={panel} onClick={()=>open(panel)}><Icon size={18}/><span>{t(key)}</span></button>)}<p>{t('collaboration.approval.boundary')}</p></section>
}
