import {useEffect,useRef,useState} from 'react'
import {AtSign,FileText,MoreHorizontal,Plus,Search,ChevronRight} from 'lucide-react'
import type {GroupAttachment,GroupResource,MessageReference} from '@teloa/contract'
import {WorkArtifactCard} from './WorkArtifactCard.js'
import {DetailsMenu} from './DetailsMenu.js'
import {useI18n} from './i18n/provider.js'
import css from './GroupMaterialsPanel.module.css'

type Props={groupId:string;resources:readonly GroupResource[]|undefined;files:readonly GroupAttachment[]|undefined;readFailed?:boolean;blocked:boolean;references:readonly MessageReference[];preview:(resource:GroupResource)=>void;edit:(resource:GroupResource)=>void;create:()=>void;reference:(resource:GroupResource)=>void;withdraw:(resource:GroupResource)=>void;addAttachment?:(()=>void)|undefined;withdrawAttachment?:((file:GroupAttachment)=>void)|undefined;previewAttachment?:((file:GroupAttachment)=>void)|undefined;openMembers?:(()=>void)|undefined}
/** 资料列表只提供当前群的阅读与显式操作；引用回到原输入区，不修改员工授权。 */
export function GroupMaterialsPanel(props:Props){return <BoundGroupMaterialsPanel key={props.groupId} {...props}/>}
function BoundGroupMaterialsPanel({groupId,resources,files,readFailed=false,blocked,references,preview,edit,create,reference,withdraw,addAttachment,withdrawAttachment,previewAttachment,openMembers}:Props){
 const {t,time}=useI18n(),[query,setQuery]=useState(''),menu=useRef<HTMLDetailsElement>(null)
 useEffect(()=>setQuery(''),[groupId])
 const matches=(name:string)=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
 const available=resources?.filter(row=>row.groupId===groupId&&row.withdrawnAt===null),rows=available?.filter(row=>matches(row.title)),attachments=files?.filter(row=>row.state==='active'&&matches(row.name)).sort((left,right)=>right.createdAt.localeCompare(left.createdAt))
 return <section className={css.root} aria-label={t('collaboration.access.materials.title')} aria-description={t('group.materials.scopeHint')}>
  <header className={css.header}><span>{t('group.materials.count',{count:(available?.length??0)+(files?.filter(row=>row.state==='active').length??0)})}</span><DetailsMenu menuRef={menu} className={css.more}><summary aria-label={t('group.materials.add')} title={t('group.materials.add')}><Plus size={17}/></summary><div role="menu">{addAttachment&&<button type="button" role="menuitem" disabled={blocked} onClick={()=>{menu.current?.removeAttribute('open');addAttachment()}}>{t('collaboration.attachment.add')}</button>}<button type="button" role="menuitem" disabled={blocked} onClick={()=>{menu.current?.removeAttribute('open');create()}}>{t('collaboration.resources.new')}</button></div></DetailsMenu></header>
  <label className={css.search}><Search size={15}/><input aria-label={t('group.materials.search')} placeholder={t('group.materials.search')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
  {resources===undefined?<p role="status" className={css.note}>{t(readFailed?'collaboration.resources.readFailed':'collaboration.state.loading')}</p>:<div className={css.list}>{rows?.map(resource=><div className={css.row} key={resource.id}>
   <WorkArtifactCard label={resource.title} detail={<>{t('collaboration.view.materials')} · v{resource.version}</>} onPreview={()=>preview(resource)}/>
   <div className={css.rowActions}><button type="button" aria-label={t('group.materials.reference',{name:resource.title})} aria-pressed={references.some(row=>row.kind==='group-resource'&&row.id===resource.id&&row.version===resource.version)} title={t('group.materials.reference',{name:resource.title})} disabled={blocked} onClick={()=>reference(resource)}><AtSign size={15}/></button><DetailsMenu className={css.more}><summary aria-label={t('group.materials.more',{name:resource.title})}><MoreHorizontal size={17}/></summary><div role="menu"><button type="button" role="menuitem" aria-label={t('group.materials.edit',{name:resource.title})} disabled={blocked} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');edit(resource)}}>{t('collaboration.resources.edit')}</button><button type="button" role="menuitem" disabled={blocked} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');withdraw(resource)}}>{t('collaboration.resources.withdrawSaved')}</button></div></DetailsMenu></div>
  </div>)}</div>}
  {attachments?.map(file=><div className={css.file} key={file.attachmentId}><FileText size={18}/><div><button type="button" className={css.fileName} disabled={!previewAttachment} onClick={()=>previewAttachment?.(file)}>{file.name}</button><small>{t('collaboration.attachment.size',{size:new Intl.NumberFormat().format(file.bytes)+' B',type:file.mime})} · {time(file.createdAt)}</small></div>{withdrawAttachment&&<DetailsMenu className={css.more}><summary aria-label={t('group.materials.more',{name:file.name})}><MoreHorizontal size={17}/></summary><div role="menu"><button type="button" role="menuitem" disabled={blocked} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');withdrawAttachment(file)}}>{t('collaboration.attachment.withdraw')}</button></div></DetailsMenu>}</div>)}
  {resources!==undefined&&files!==undefined&&!rows?.length&&!attachments?.length&&<div className={css.empty}><FileText size={25}/><p>{t(query?'group.materials.noMatch':'collaboration.attachment.sectionEmpty')}</p></div>}
  {!!attachments?.length&&<p className={css.note}>{t('collaboration.attachment.sectionHint')}</p>}
  {openMembers&&<details className={css.help}><summary>{t('group.materials.accessHelp')}</summary><p>{t('group.materials.accessHelpBody')}</p><button type="button" onClick={openMembers}>{t('group.materials.openMembers')}<ChevronRight size={13}/></button></details>}
 </section>
}
