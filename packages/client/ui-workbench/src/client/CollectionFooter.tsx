import {useI18n} from './i18n/provider.js'
import css from './CollectionFooter.module.css'

const copy={
 'zh-CN':['已显示 {shown} / {total} 项','再显示 50 项'],
 'zh-TW':['已顯示 {shown} / {total} 項','再顯示 50 項'],
 en:['Showing {shown} of {total}','Show 50 more'],
 ja:['{total} 件中 {shown} 件を表示','さらに 50 件を表示'],
 ko:['{total}개 중 {shown}개 표시','50개 더 보기'],
 fr:['{shown} sur {total} affichés','Afficher 50 de plus'],
 de:['{shown} von {total} angezeigt','50 weitere anzeigen'],
 es:['Mostrando {shown} de {total}','Mostrar 50 más'],
 pt:['Mostrando {shown} de {total}','Mostrar mais 50'],
 ru:['Показано {shown} из {total}','Показать ещё 50'],
} as const

export function CollectionFooter({shown,total,more,showMore}:{shown:number;total:number;more:boolean;showMore:()=>void}){
 const {locale,number}=useI18n()
 if(total<=50)return null
 const text=copy[locale as keyof typeof copy]??copy[locale.split('-')[0] as keyof typeof copy]??copy.en
 return <footer className={css.footer} data-collection-footer>
  <span role="status" aria-live="polite">{text[0].replace('{shown}',number(shown)).replace('{total}',number(total))}</span>
  {more&&<button type="button" onClick={showMore}>{text[1]}</button>}
 </footer>
}
