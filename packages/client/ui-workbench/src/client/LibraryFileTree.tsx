import {ChevronDown,ChevronRight,FileText,Folder} from 'lucide-react'
import type {WorkResource} from '@teloa/contract'
import type {KnowledgeDirectoryBranch,KnowledgeDirectoryEntry,KnowledgeDirectoryPage} from './resource-manager-presentation.js'
import {useI18n} from './i18n/provider.js'
import {libraryReaderText} from './library-reader-copy.js'
import css from './ResourceManager.module.css'

/** 文件和目录共用原目录身份；展开状态由页面持有，阅读切换不会重建。 */
export function LibraryFileTree({tree,resources,selectedNodeId,selectedResourceId,expanded,onExpanded,onFolder,onPage,onResource}:{tree:KnowledgeDirectoryBranch|undefined;resources:WorkResource[];selectedNodeId:string|undefined;selectedResourceId:string|undefined;expanded:Readonly<Record<string,boolean>>;onExpanded:(id:string,value:boolean)=>void;onFolder:(id:string)=>void;onPage:(page:KnowledgeDirectoryPage)=>void;onResource:(resource:WorkResource)=>void}){
 const {locale,t}=useI18n(),copy=libraryReaderText(locale)
 const file=(id:string,title:string,current:boolean,open:()=>void)=><button type="button" key={id} className={css.treeDocument} aria-current={current?'page':undefined} onClick={open}><FileText size={15}/><span><strong>{title}</strong></span></button>
 const folder=(id:string,title:string,children:React.ReactNode,current=false)=>{const open=expanded[id]??true;return <div key={id} className={css.fileTreeBranch}><div className={css.fileTreeFolder} data-current={current||undefined}><button type="button" aria-label={(open?copy.collapse:copy.expand)+': '+title} aria-expanded={open} className={css.fileTreeToggle} onClick={()=>onExpanded(id,!open)}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button><button type="button" className={css.fileTreeFolderName} onClick={()=>{onExpanded(id,true);if(id!=='local')onFolder(id)}}><Folder size={15}/><span>{title}</span></button></div>{open&&<div className={css.treeGroup}>{children}</div>}</div>}
 const entry=(node:KnowledgeDirectoryEntry):React.ReactNode=>node.type==='page'?file(node.id,node.title,selectedNodeId===node.id||!!node.resourceId&&selectedResourceId===node.resourceId,()=>onPage(node)):folder(node.id,node.title,node.children.map(entry),selectedNodeId===node.id)
 return <nav className={css.fileTree} aria-label={copy.tree}>{tree&&entry(tree)}{resources.length>0&&folder('local',t('library.local'),resources.map(row=>file(row.id,row.title,selectedResourceId===row.id,()=>onResource(row))))}</nav>
}
