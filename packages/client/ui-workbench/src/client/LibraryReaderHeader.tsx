import type {ReactNode} from 'react'
import css from './KnowledgeDocument.module.css'
export function LibraryReaderHeader({navigation,title,children}:{navigation?:ReactNode;title:string;children:ReactNode}){
 return <header className={css.documentHeader}><div className={css.readerIdentity}>{navigation}<h2 title={title}>{title}</h2></div><div className={css.documentActions}>{children}</div></header>
}
