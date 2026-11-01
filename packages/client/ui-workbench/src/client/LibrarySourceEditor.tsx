import {useId,useRef,useState} from 'react'
import {MarkdownPreview} from './knowledge-markdown.js'
import {useI18n} from './i18n/provider.js'
import css from './KnowledgeDocument.module.css'
/** 阅读与修改共用正文；草稿与请求身份留在调用方既有 journal。 */
export function LibrarySourceEditor({value,onChange,readOnly=false,markdown=true}:{value:string;onChange:(value:string)=>void;readOnly?:boolean;markdown?:boolean}){
 const {t}=useI18n(),[preview,setPreview]=useState(false),lines=useRef<HTMLPreElement>(null),id=useId()
 return <section className={css.sourceEditor}><div role="tablist" aria-label={t('knowledge.ui.068')} className={css.editorTabs}><button type="button" role="tab" aria-selected={!preview} aria-controls={id} onClick={()=>setPreview(false)}>{t('knowledge.ui.070')}</button><button type="button" role="tab" aria-selected={preview} aria-controls={id} onClick={()=>setPreview(true)}>{t('knowledge.ui.071')}</button></div>{preview?<article id={id} role="tabpanel" className={css.readerContent}>{markdown?<MarkdownPreview markdown={value} images={false}/>:<pre>{value}</pre>}</article>:<div id={id} role="tabpanel" className={css.sourceEditorBody}><pre aria-hidden="true" ref={lines}>{value.split('\n').map((_,index)=>index+1).join('\n')}</pre><textarea autoFocus spellCheck={false} wrap="off" aria-label={t('knowledge.ui.074')} value={value} readOnly={readOnly} onScroll={event=>{if(lines.current)lines.current.scrollTop=event.currentTarget.scrollTop}} onChange={event=>onChange(event.target.value)}/></div>}</section>
}
