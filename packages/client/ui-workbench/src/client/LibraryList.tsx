import {Clock3,FileText,Folder,Search,Star} from 'lucide-react'
import {EmptyBlock} from './EmptyState.js'
import type {LibraryPreferences,LibraryRow,LibraryView} from './library-views.js'
import {useI18n} from './i18n/provider.js'
import {businessLibraryText} from './business-library-presentation.js'
import css from './ResourceManager.module.css'
import {useBusinessScopes} from './business-scope-context.js'
export function LibraryViews({view,onChange,retrieval=false}:{view:LibraryView;onChange:(view:LibraryView)=>void;retrieval?:boolean}){
 const {t}=useI18n()
 return <nav className={css.views} aria-label={t('library.views')}>{([['recent',Clock3],['star',Star],['mine',FileText],['local',Folder],...(retrieval?[['retrieval',Search] as const]:[])] as const).map(([key,Icon])=><button key={key} type="button" aria-current={view===key?'page':undefined} onClick={()=>onChange(key)}><Icon size={16}/>{t(`library.${key}`)}</button>)}</nav>
}
export function LibraryList({rows,view,query,preferences,open,favorite,clear,loading,browseAll,add}:{rows:LibraryRow[];view:LibraryView;query:string;preferences:LibraryPreferences;open:(row:LibraryRow)=>void;favorite:(id:string)=>void;clear:()=>void;loading:boolean;browseAll:()=>void;add:()=>void}){
 const {locale,t}=useI18n(),copy=businessLibraryText(locale),time=(at:number)=>new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(at)
 const scopeNames=useBusinessScopes(),scopeLabel=(row:LibraryRow)=>row.scopeIds?.map(scope=>scopeNames[scope]??scope).join(' · ')||'—',displayLocation=(row:LibraryRow)=>['market:','resource:','knowledge:'].some(prefix=>row.location.startsWith(prefix))?'':row.location
 if(!rows.length){
  const searching=!!query.trim(),idle=!loading&&!searching
  return <div className={css.emptyDetail}><EmptyBlock status={loading} icon={loading?undefined:searching?Search:view==='recent'?Clock3:view==='star'?Star:view==='local'?Folder:FileText}
   title={t(loading?'knowledge.role.loading':searching?'library.noMatch':view==='recent'?'library.noRecent':'library.empty')}
   description={idle&&t(view==='recent'?'library.emptyRecent':view==='star'?'library.emptyStar':view==='local'?'library.emptyLocal':'knowledge.manager.emptyDescription')}
   actions={searching?[{label:t('library.clear'),onClick:clear}]:idle&&view==='recent'?[{label:t('library.browseAll'),onClick:browseAll},{label:t('library.add'),onClick:add,primary:true}]:undefined}/></div>
 }
 return <><p className={css.listCount}>{t('library.count',{count:rows.length})}</p><div className={css.tableScroll}><table className={css.fileTable}><thead><tr><th>{t('library.name')}</th><th>{t('library.location')}</th><th>{copy.version}</th><th>{t('library.status')}</th><th>{t('library.visited')}</th><th aria-label={t('library.star')}/></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><button type="button" className={css.fileName} title={row.title} data-teloa-entry={row.id} onClick={()=>open(row)}><FileText size={17}/><span>{row.title}</span></button></td><td><span className={css.fileScope} title={scopeLabel(row)}>{scopeLabel(row)}</span>{displayLocation(row)&&<span className={css.fileLocation} title={displayLocation(row)}>{displayLocation(row)}</span>}</td><td>{row.kind==='knowledge'?copy.body:copy.record} v{row.version}{row.kind!=='knowledge'&&<><br/><small>{row.knowledgeVersion?copy.body+' v'+row.knowledgeVersion:copy.unknownVersion}</small></>}</td><td>{t(row.kind==='knowledge'?'library.savedKnowledge':row.status==='draft'?'knowledge.manager.statusDraft':row.status==='active'?'library.available':'knowledge.manager.statusWithdrawn')}</td><td>{row.visitedAt===undefined?t('library.unvisited'):time(row.visitedAt)}</td><td><button type="button" className={css.favorite} aria-pressed={preferences.favorites.includes(row.id)} aria-label={t(preferences.favorites.includes(row.id)?'library.unfavorite':'library.favorite',{name:row.title})} onClick={()=>favorite(row.id)}><Star size={16} fill={preferences.favorites.includes(row.id)?'currentColor':'none'}/></button></td></tr>)}</tbody></table></div></>
}
