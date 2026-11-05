import {useEffect,useMemo,useRef,useState} from 'react'
import {Download} from 'lucide-react'
import {isArtifactFile} from '@teloa/contract'
import {fileBytes,fileText,fileImageType,type ArtifactFile} from './artifact-files.js'
import {useI18n} from './i18n/provider.js'
import {artifactAssetCopy} from './artifact-asset-copy.js'
import css from './ArtifactAssetPreview.module.css'

export type ArtifactAssetKind='image'|'video'|'audio'|'text'|'binary'
type Content={kind:ArtifactAssetKind;mime:string;text?:string}
export const artifactAssetName=(file:ArtifactFile)=>file.path.split('/').at(-1)||'download'
function content(file:ArtifactFile,bytes:Uint8Array):Content{
 const image=fileImageType(bytes);if(image)return {kind:'image',mime:image}
 const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end)),extension=artifactAssetName(file).split('.').at(-1)?.toLowerCase()
 if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')return {kind:'audio',mime:'audio/wav'}
 if(ascii(4,8)==='ftyp'){
  const brand=ascii(8,12)
  if(['M4A ','M4B ','M4P '].includes(brand))return {kind:'audio',mime:'audio/mp4'}
  if(['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','dash','M4V ','qt  '].includes(brand))return {kind:'video',mime:brand==='qt  '?'video/quicktime':'video/mp4'}
 }
 if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3&&ascii(0,4096).includes('webm'))return {kind:extension==='weba'?'audio':'video',mime:extension==='weba'?'audio/webm':'video/webm'}
 if(ascii(0,4)==='OggS')return {kind:extension==='ogv'?'video':'audio',mime:extension==='ogv'?'video/ogg':'audio/ogg'}
 if(ascii(0,3)==='ID3'||bytes[0]===0xff&&bytes[1]!==undefined&&(bytes[1]&0xe0)===0xe0)return {kind:'audio',mime:'audio/mpeg'}
 // PDF、Office与压缩包不作为文本伪预览，更不交给活动文档容器。
 if(ascii(0,5)==='%PDF-'||['pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','zip','gz','rar','7z'].includes(extension??''))return {kind:'binary',mime:'application/octet-stream'}
 const text=fileText(bytes);return text===null?{kind:'binary',mime:'application/octet-stream'}:{kind:'text',mime:'text/plain;charset=utf-8',text}
}
export function artifactAssetKind(file:ArtifactFile):ArtifactAssetKind{try{return content(file,fileBytes(file)).kind}catch{return 'binary'}}
type Source={bytes:Uint8Array<ArrayBuffer>;content:Content}|null
type Ready={source:Source;url:string;error:boolean}
function useAsset(file:ArtifactFile){
 const source=useMemo<Source>(()=>{try{if(!isArtifactFile(file))return null;const bytes=fileBytes(file);return bytes.length===file.bytes?{bytes,content:content(file,bytes)}:null}catch{return null}},[file.sessionId,file.id,file.path,file.sha256,file.bytes,file.capturedAt,file.contentBase64])
 const [ready,setReady]=useState<Ready>()
 useEffect(()=>{
  let live=true,url:string|undefined
  if(!source)return
  void(async()=>{
   try{
    const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',source.bytes)),n=>n.toString(16).padStart(2,'0')).join('')
    if(!live)return
    if(actual!==file.sha256){setReady({source,url:'',error:true});return}
    url=URL.createObjectURL(new Blob([source.bytes],{type:source.content.mime}));setReady({source,url,error:false})
   }catch{if(live)setReady({source,url:'',error:true})}
  })()
  return()=>{live=false;if(url)URL.revokeObjectURL(url)}
 },[source,file.sha256])
 // 新文件/版本的首帧就隔离旧blob；迟答不能重新创建已离开的版本URL。
 return {source,current:ready?.source===source?ready:undefined,error:source===null||ready?.source===source&&ready?.error===true}
}
export function ArtifactAssetDownload({file}:{file:ArtifactFile}){
 const {locale}=useI18n(),copy=artifactAssetCopy(locale),asset=useAsset(file)
 if(!asset.current?.url||asset.error)return null
 return <a className={css.download} href={asset.current.url} download={artifactAssetName(file)}><Download size={16} aria-hidden="true"/>{copy.download}</a>
}
export function ArtifactAssetPreview({file}:{file:ArtifactFile}){
 const {locale}=useI18n(),copy=artifactAssetCopy(locale),asset=useAsset(file),[failed,setFailed]=useState<Source>(),media=useRef<HTMLVideoElement|HTMLAudioElement|null>(null)
 useEffect(()=>{const element=media.current;return()=>element?.pause()},[asset.current?.url])
 if(asset.error)return <p className={css.notice} role="status" data-asset-state="integrity-error">{copy.invalid}</p>
 if(!asset.current?.url||!asset.source)return <p className={css.notice} role="status" data-asset-state="loading">{copy.loading}</p>
 const {kind,text}=asset.source.content,url=asset.current.url,name=artifactAssetName(file)
 const unavailable=failed===asset.source
 const type=(name.includes('.')?name.split('.').at(-1):undefined)?.toUpperCase()||'BINARY'
 const size=file.bytes<1024?`${file.bytes} B`:`${new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(file.bytes/(file.bytes<1024**2?1024:1024**2))} ${file.bytes<1024**2?'KiB':'MiB'}`
 return <div className={css.preview} data-asset-kind={kind}>
  {unavailable?<div className={css.fallback} role="status" data-asset-state="media-unavailable"><p>{copy.unavailable}</p><p>{copy.meta(type,size)}</p></div>:kind==='image'?<img className={css.image} src={url} alt={copy.image(name)} decoding="async" onError={()=>setFailed(asset.source)}/>:kind==='video'?<video ref={element=>{media.current=element}} className={css.video} src={url} controls preload="metadata" onError={()=>setFailed(asset.source)}/>:kind==='audio'?<audio ref={element=>{media.current=element}} className={css.audio} src={url} controls preload="metadata" onError={()=>setFailed(asset.source)}/>:kind==='text'?<><pre className={css.source} aria-label={copy.text}>{text}</pre>{file.bytes===0&&<p className={css.notice}>{copy.empty}</p>}</>:<div className={css.fallback} role="status"><p>{copy.meta(type,size)}</p><p>{copy.unsupported}</p></div>}
 </div>
}
