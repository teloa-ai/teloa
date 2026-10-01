import {useState} from 'react'
import {FileText} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {producedPaths} from './produced-files.js'
import css from './ProducedFileCards.module.css'
export function ProducedFileCards({turn,seq,preview,openFile}:PropsRuntime<'conversation.chat.turnTail'>&{preview:(path:string)=>void}){
 const {locale,t}=useI18n()
 const [error,setError]=useState('')
 // deliverables 是可选原生插件贡献；公开入口未导出其数据扩位，按未知值读取后由 producedPaths 校验。
 const data=(turn.data.get as (key:string)=>unknown)('deliverables')
 const matched=producedPaths(data,seq)
 if(!matched.length)return null
 return <section className={css.files} aria-label={t('producedFiles.aria')}><strong>{t('producedFiles.count',{count:matched.length})}</strong>
 <div className={css.list}>{matched.map(path=><div className={css.card} key={path}><button type="button" onClick={()=>{try{preview(path);setError('')}catch(cause){setError(localizeWorkError(locale,cause))}}}><FileText size={16}/><span>{path}</span></button><button type="button" aria-label={t('producedFiles.openAria',{path})} onClick={()=>void Promise.resolve().then(()=>openFile(path)).catch(cause=>setError(localizeWorkError(locale,cause)))}>{t('producedFiles.open')}</button></div>)}</div>
 {error&&<p role="alert">{error}</p>}</section>
}
