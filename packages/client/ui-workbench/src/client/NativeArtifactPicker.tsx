import { useEffect,useRef,useState } from 'react'
import { artifactMessageKey,nativeImagePreviewControl,type ArtifactMessage,type ArtifactImage,type NativeArtifactApi,type NativeArtifactPage } from './artifact-native.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import base from './TaskPage.module.css'
import css from './NativeArtifactPicker.module.css'

export function NativeArtifactPicker({sessionId,api,selected,select}:{sessionId:string;api:NativeArtifactApi;selected:ArtifactMessage[];select:(message:ArtifactMessage)=>void}){
  const {locale,t,dateTime}=useI18n()
  const [page,setPage]=useState<NativeArtifactPage>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),generation=useRef(0)
  const read=async(beforeSeq?:number)=>{
    const current=++generation.current;setLoading(true);setError('')
    try{
      const next=await api.read(sessionId,beforeSeq)
      if(current!==generation.current)return
      if(next.sessionId!==sessionId){setError(t('nativeArtifact.wrongSession'));return}
      setPage(previous=>beforeSeq===undefined||!previous?next:{...next,items:[...previous.items,...next.items.filter(item=>!previous.items.some(old=>artifactMessageKey(old)===artifactMessageKey(item)))]})
    }catch(cause){if(current===generation.current)setError(localizeWorkError(locale,cause))}
    finally{if(current===generation.current)setLoading(false)}
  }
  useEffect(()=>{void read();return()=>{generation.current++}},[sessionId,api])
  return <section className={css.picker} aria-label={t('nativeArtifact.pickerAria')} aria-busy={loading}>
    <p>{t('nativeArtifact.description')}</p>
    {error&&<p role="alert" className={base.error}>{error}</p>}{loading&&<p role="status">{t('nativeArtifact.loading')}</p>}
    {page?.items.map(message=><section className={css.choice} key={artifactMessageKey(message)}>
      <strong>{t(message.role==='user'?'nativeArtifact.userMessage':'nativeArtifact.modelReply')} · {dateTime(message.at)}</strong>
      <p>{message.text.slice(0,220)||t('nativeArtifact.imageMessage')}{message.text.length>220?'…':''}</p>
      <small>{t('nativeArtifact.messageMeta',{count:message.images.length,interrupted:message.interrupted?t('nativeArtifact.interruptedSuffix'):'',seq:message.seq})}</small>
      <details><summary>{t('nativeArtifact.original')}</summary><p className={css.identity}>{message.messageId}</p><p className={css.original}>{message.text||t('nativeArtifact.noText')}</p></details>
      <button type="button" disabled={selected.some(item=>artifactMessageKey(item)===artifactMessageKey(message))||message.text.length>16000} onClick={()=>select(message)}>{t(selected.some(item=>artifactMessageKey(item)===artifactMessageKey(message))?'nativeArtifact.selected':'nativeArtifact.select')}</button>
      {message.text.length>16000&&<p>{t('nativeArtifact.tooLong')}</p>}
    </section>)}
    {!loading&&page&&!page.items.length&&<p>{t('nativeArtifact.empty')} {t(page.nextBeforeSeq!==null?'nativeArtifact.emptyOlder':'nativeArtifact.emptyReturn')}</p>}
    <div className={base.buttons}><button type="button" disabled={loading} onClick={()=>void read()}>{t('nativeArtifact.refresh')}</button>{page?.nextBeforeSeq!==null&&page?.nextBeforeSeq!==undefined&&<button type="button" disabled={loading} onClick={()=>void read(page.nextBeforeSeq!)}>{t('nativeArtifact.older')}</button>}</div>
  </section>
}

export function ArtifactMessages({messages,api,enabled,remove,append}:{messages:ArtifactMessage[];api:NativeArtifactApi;enabled:boolean;remove?:(message:ArtifactMessage)=>void;append?:(text:string)=>void}){
  const {t,dateTime}=useI18n()
  if(!messages.length)return null
  return <section className={css.references} aria-label={t('nativeArtifact.referencesAria')}><h3>{t('nativeArtifact.referencesCount',{count:messages.length})}</h3>
    <p>{t('nativeArtifact.referencesDescription')}</p>
    {!enabled&&<p role="status">{t('nativeArtifact.imageSourceUnavailable')}</p>}
    {messages.map(message=><section key={artifactMessageKey(message)} className={css.choice}>
      <strong>{t(message.role==='user'?'nativeArtifact.userMessage':'nativeArtifact.modelReply')} · {dateTime(message.at)}</strong>
      {message.interrupted&&<p>{t('nativeArtifact.interrupted')}</p>}
      <details><summary>{t('nativeArtifact.identity')}</summary><p className={css.identity}>{t('nativeArtifact.identityMeta',{session:message.sessionId,message:message.messageId,seq:message.seq})}</p><p className={css.original}>{message.text||t('nativeArtifact.noText')}</p>{message.omittedBlocks>0&&<p>{t('nativeArtifact.omitted',{count:message.omittedBlocks})}</p>}</details>
      {message.images.map(image=><NativeImage key={image.blockIndex} message={message} image={image} api={api} enabled={enabled}/>)}
      <div className={base.buttons}>{append&&message.text.trim()&&<button type="button" onClick={()=>append(message.text)}>{t('nativeArtifact.append')}</button>}{remove&&<button type="button" onClick={()=>remove(message)}>{t('nativeArtifact.remove')}</button>}</div>
    </section>)}
  </section>
}
function NativeImage({message,image,api,enabled}:{message:ArtifactMessage;image:ArtifactImage;api:NativeArtifactApi;enabled:boolean}){
  const {locale,t}=useI18n()
  const [url,setUrl]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[decoded,setDecoded]=useState(false),[expanded,setExpanded]=useState(false),generation=useRef(0)
  useEffect(()=>{generation.current++;setUrl('');setLoading(false);setDecoded(false);setExpanded(false);setError('');return()=>{generation.current++}},[enabled,message.sessionId,image.attachment.attachmentId])
  const load=async()=>{
    const current=++generation.current;setLoading(true);setError('');setDecoded(false);setExpanded(false);setUrl('')
    try{const value=await api.imageUrl(message,image);if(current===generation.current){if(!value.startsWith('blob:')){setError(t('nativeArtifact.imageInvalid'));return}setUrl(value)}}
    catch(cause){if(current===generation.current)setError(localizeWorkError(locale,cause))}
    finally{if(current===generation.current)setLoading(false)}
  }
  const ref=image.attachment,filename=(ref.name||'teloa-image.'+ref.mediaType.split('/')[1]).replace(/[\\/:*?"<>|]/g,'_')
  const previewControl=nativeImagePreviewControl(decoded,expanded)
  return <div className={css.image}>
    <strong>{ref.name||t('nativeArtifact.unnamedImage')}</strong><small>{ref.width}×{ref.height} · {ref.bytes} bytes · {ref.mediaType}</small>
    <details><summary>{t('nativeArtifact.imageIdentity')}</summary><p className={css.identity}>{t('nativeArtifact.imageIdentityMeta',{id:ref.attachmentId,index:image.blockIndex})}</p></details>
    {error&&<p role="alert" className={base.error}>{error}</p>}
    {url&&enabled&&<img className={expanded?css.expandedImage:css.thumbnail} src={url} alt={t('nativeArtifact.imageAlt',{name:ref.name||t('nativeArtifact.unnamedImage')})} onLoad={()=>setDecoded(true)} onError={()=>{setUrl('');setDecoded(false);setExpanded(false);setError(t('nativeArtifact.imageDecodeFailed'))}}/>}
    <div className={base.buttons}><button type="button" disabled={!enabled||loading} onClick={()=>void load()}>{t(loading?'nativeArtifact.imageLoading':url?'nativeArtifact.imageReload':'nativeArtifact.imageView')}</button>{previewControl&&url&&enabled&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(previewControl.expanded)}>{t(previewControl.expanded?'nativeArtifact.imageExpand':'nativeArtifact.imageCollapse')}</button>}{decoded&&url&&enabled&&<a href={url} download={filename}>{t('nativeArtifact.imageDownload')}</a>}{url&&<button type="button" onClick={()=>{generation.current++;setUrl('');setDecoded(false);setExpanded(false)}}>{t('nativeArtifact.imageHide')}</button>}</div>
  </div>
}
