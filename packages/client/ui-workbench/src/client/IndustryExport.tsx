import {isIndustryManifest} from './industry-manifest.ts'
import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import type { MarketItem } from './market-preview.js'
import { exportIndustryArchive } from './industry-export.js'
import css from './MarketPage.module.css'
import {useI18n} from './i18n/provider.js'

export function IndustryExport({item}:{item:MarketItem}){
 const {t}=useI18n()
 const alive=useRef(true),running=useRef(false)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 if(!isIndustryManifest(item.manifest)||!item.packageContent)return null
 const download=async()=>{
  if(running.current)return
  running.current=true;setBusy(true);setError('');setNotice('')
  try{
   const result=await exportIndustryArchive(item)
   if(!alive.current)return
   const url=URL.createObjectURL(new Blob([Uint8Array.from(result.bytes)],{type:'application/zip'})),anchor=document.createElement('a')
   anchor.href=url;anchor.download=result.name;document.body.append(anchor);anchor.click();anchor.remove()
   setTimeout(()=>URL.revokeObjectURL(url),10000)
   setNotice(t('market.industry.export.done'))
  }catch{if(alive.current)setError(t('market.industry.export.failed'))}
  finally{running.current=false;if(alive.current)setBusy(false)}
 }
 return <section className={css.sheet} aria-label={t('market.industry.export.aria')}><h3>{t('market.industry.export.title')}</h3><p>{t('market.industry.export.description')}</p><button type="button" disabled={busy} onClick={()=>void download()}><Download size={16}/>{busy?t('market.industry.export.generating'):t('market.industry.export.download')}</button>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</section>
}
