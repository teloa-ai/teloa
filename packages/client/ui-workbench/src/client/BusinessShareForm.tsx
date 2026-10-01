import {isIndustryManifest} from './industry-manifest.ts'
import {useEffect,useRef,useState} from 'react'
import {Download,Store} from 'lucide-react'
import type {BusinessShareInput} from './business-share-package.js'
import {businessShareEnglishResourceNotice,businessShareExclusionText,businessSharePublicationNotice,businessShareReady,type BusinessShareApi} from './business-share-flow.js'
import {BusinessDeclaration} from './IndustryContents.js'
import {inspectIndustryContent} from './industry-content.js'
import type {TeloaTranslate} from './i18n/index.js'
import type {MarketItem} from './market-preview.js'
import {useI18n} from './i18n/provider.js'
import base from './TaskPage.module.css'
import css from './BusinessShareForm.module.css'

type Source=Pick<BusinessShareInput,'objectTypes'|'views'|'actions'|'sources'|'available'>
type Draft=Pick<BusinessShareInput,'packageId'|'packageVersion'|'title'|'description'|'english'>
type Props={scope:string;api:BusinessShareApi;openMarket:(id?:string)=>void}
type Busy='read'|'plan'|'download'|'fix'|undefined

const initialDraft=(scope:string,t:TeloaTranslate):Draft=>({
 packageId:scope.toLocaleLowerCase()+'-ledger',packageVersion:'1.0.0',title:t('business.share.defaultName',{scope}),description:t('business.share.defaultSummary'),
})

/** 浏览器下载只消费 API 已经完成核对的 ZIP 字节，页面不参与归档与哈希计算。 */
function saveArchive(bytes:Uint8Array,name:string){
 const url=URL.createObjectURL(new Blob([Uint8Array.from(bytes)],{type:'application/zip'})),anchor=document.createElement('a')
 anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove()
 setTimeout(()=>URL.revokeObjectURL(url),10000)
}

/**
 * 分享前只让用户编辑包的门面信息；声明、来源名词与可用项由现有本地固定内容读取，
 * 因此不会把快照、连接地址或凭据重新暴露成可编辑字段。
 */
export function BusinessShareForm({scope,api,openMarket}:Props){
 const {t}=useI18n()
 const alive=useRef(true)
 const [source,setSource]=useState<Source>()
 const [draft,setDraft]=useState<Draft>(()=>initialDraft(scope,t))
 const [item,setItem]=useState<MarketItem>()
 const [excluded,setExcluded]=useState<Awaited<ReturnType<BusinessShareApi['plan']>>['excluded']>([])
 const [busy,setBusy]=useState<Busy>('read')
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const [fixedItemId,setFixedItemId]=useState<string>()

 useEffect(()=>{alive.current=true;setSource(undefined);setItem(undefined);setExcluded([]);setError('');setNotice('');setDraft(initialDraft(scope,t));setBusy('read');void api.source.read(scope).then(value=>{if(alive.current)setSource(value)}).catch(()=>{if(alive.current)setError(t('business.share.failed'))}).finally(()=>{if(alive.current)setBusy(undefined)});return()=>{alive.current=false}},[api,scope,t])
 const english=draft.english?.title.trim()&&draft.english.description.trim()?draft.english:undefined
 const input=source?{scope,packageId:draft.packageId,packageVersion:draft.packageVersion,title:draft.title,description:draft.description,...(english?{english}:{}),...source}:undefined
 const ready=input!==undefined&&businessShareReady(input)
 const update=<K extends keyof Draft>(key:K,value:Draft[K])=>setDraft(current=>({...current,[key]:value}))
 const generate=async()=>{
  if(!input||!ready)return
  setBusy('plan');setError('');setNotice('')
  try{const result=await api.plan(input);if(!alive.current)return;setItem(result.item);setExcluded(result.excluded)}catch{if(alive.current)setError(t('business.share.failed'))}finally{if(alive.current)setBusy(undefined)}
 }
 const download=async()=>{
  if(!item)return
  setBusy('download');setError('');setNotice('')
  try{const archive=await api.download(item);if(!alive.current)return;saveArchive(archive.bytes,archive.name);setNotice(t('business.share.downloaded'))}catch{if(alive.current)setError(t('business.share.failed'))}finally{if(alive.current)setBusy(undefined)}
 }
 const fix=async()=>{
  if(!item)return
  setBusy('fix');setError('');setNotice('')
  try{const saved=await api.fix(item);if(!alive.current)return;setFixedItemId(saved.id);setNotice(t('business.share.fixed'))}catch{if(alive.current)setError(t('business.share.failed'))}finally{if(alive.current)setBusy(undefined)}
 }

 if(busy==='read')return <section className={css.panel} aria-label={t('business.share.title')}><p className={css.muted}>{t('business.share.loading')}</p></section>
 if(!source)return <section className={css.panel} aria-label={t('business.share.title')}><p className={css.muted}>{error||t('business.share.empty')}</p></section>
 if(!source.objectTypes.length)return <section className={css.panel} aria-label={t('business.share.title')}><header><h2>{t('business.share.title')}</h2></header><p className={css.muted}>{t('business.share.empty')}</p></section>
 if(isIndustryManifest(item?.manifest)&&item.packageContent){
  const declarations=inspectIndustryContent(item.manifest,item.packageContent).filter(row=>row.state==='parsed'&&row.definition&&(row.definition.kind==='object-type'||row.definition.kind==='business-view'||row.definition.kind==='business-action'))
  return <section className={css.panel} aria-label={t('business.share.preview')}><header><div><h2>{t('business.share.preview')}</h2><p>{t('business.share.description')}</p></div><button type="button" disabled={!!busy} onClick={()=>{setItem(undefined);setExcluded([]);setError('');setNotice('')}}>{t('business.share.back')}</button></header>
   {error&&<p className={base.error} role="alert">{error}</p>}{notice&&<div className={css.notice} role="status"><span>{notice}</span>{notice===t('business.share.fixed')&&<button type="button" onClick={()=>openMarket(fixedItemId)}>{t('business.share.openMarket')}</button>}</div>}
   <p className={css.safe}>{t('business.share.safe')}</p>
   {businessSharePublicationNotice(english)&&<p className={css.notice}>{t('business.share.localOnly')}</p>}
   {businessShareEnglishResourceNotice(english)&&<p className={css.notice}>{t('business.share.englishFallback')}</p>}
   <section className={css.declarations} aria-label={t('business.share.preview')}>{declarations.map(row=><article key={row.id}><h3>{row.id}</h3><BusinessDeclaration definition={row.definition! as Extract<NonNullable<typeof row.definition>,{kind:'object-type'}|{kind:'business-view'}|{kind:'business-action'}>}/></article>)}</section>
   <section className={css.sources} aria-label={t('business.share.sources')}><h3>{t('business.share.sources')}</h3><ul>{source.sources.map(row=><li key={row.sourceId}>{row.sourceNoun??row.sourceId}</li>)}</ul></section>
   {!!excluded.length&&<section className={css.excluded} aria-label={t('business.share.excluded')}><h3>{t('business.share.excluded')}</h3><ul>{excluded.map(row=><li key={row.kind+'/'+row.localId}>{businessShareExclusionText(row)}</li>)}</ul></section>}
   <footer><button type="button" disabled={!!busy} onClick={()=>void download()}><Download size={15}/>{busy==='download'?t('business.share.generating'):t('business.share.download')}</button><button type="button" disabled={!!busy} onClick={()=>void fix()}><Store size={15}/>{busy==='fix'?t('business.share.generating'):t('business.share.fix')}</button></footer>
  </section>
 }
 return <section className={css.panel} aria-label={t('business.share.title')}><header><div><h2>{t('business.share.title')}</h2><p>{t('business.share.description')}</p></div></header>{error&&<p className={base.error} role="alert">{error}</p>}
  <div className={css.form}><label>{t('business.share.packageId')}<input value={draft.packageId} onChange={event=>update('packageId',event.target.value)}/></label><label>{t('business.share.version')}<input value={draft.packageVersion} onChange={event=>update('packageVersion',event.target.value)}/></label><label>{t('business.share.name')}<input value={draft.title} onChange={event=>update('title',event.target.value)}/></label><label>{t('business.share.summary')}<textarea rows={3} value={draft.description} onChange={event=>update('description',event.target.value)}/></label></div>
  <details className={css.english}><summary>{t('business.share.english')}</summary><div className={css.form}><label>{t('business.share.englishName')}<input value={draft.english?.title??''} onChange={event=>update('english',{title:event.target.value,description:draft.english?.description??''})}/></label><label>{t('business.share.englishSummary')}<textarea rows={3} value={draft.english?.description??''} onChange={event=>update('english',{title:draft.english?.title??'',description:event.target.value})}/></label></div></details>
  <footer><button type="button" disabled={!ready||!!busy} onClick={()=>void generate()}>{busy==='plan'?t('business.share.generating'):t('business.share.generate')}</button></footer>
 </section>
}
