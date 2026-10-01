import {isIndustryManifest} from './industry-manifest.ts'
import { useEffect, useRef, useState } from 'react'
import { referenceCandidates, resolveIndustryReferences, type IndustryReferenceChoice } from './industry-reference.js'
import type { MarketItem } from './market-preview.js'
import css from './MarketPage.module.css'
import base from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'
import {localizedMarketItemCopy} from './market-home-presentation.js'
import {localizedIndustryResourceTitle} from './industry-template-presentation.js'
const choiceKey=(choice:IndustryReferenceChoice)=>JSON.stringify([choice.resourceId,choice.sourceContentId??null,choice.sourceItemId,choice.sourceResourceId,choice.sourceHash])
export function IndustryReferences({item,items,save,embedded=false,requireAll=false}:{item:MarketItem;items:readonly MarketItem[];save:(item:MarketItem)=>void|Promise<void>;embedded?:boolean;requireAll?:boolean}){
 const {locale,t}=useI18n()
 const [selected,setSelected]=useState<Record<string,IndustryReferenceChoice>>(()=>Object.fromEntries(item.packageContent?.resolved?.map(row=>[row.resourceId,row])||[]))
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),generation=useRef(0)
 useEffect(()=>()=>{generation.current++},[])
 if(!isIndustryManifest(item.manifest)||!item.packageContent)return null
 const refs=item.manifest.resources.filter(row=>row.source.kind==='public')
 if(!refs.length)return null
 const submit=()=>{const token=++generation.current;setBusy(true);setError('')
  void resolveIndustryReferences(item,items,Object.values(selected)).then(next=>save(next)).catch(()=>{if(token===generation.current)setError(t('market.industry.references.failed'))}).finally(()=>{if(token===generation.current)setBusy(false)})
 }
 const fields=<>{refs.map(resource=>{
  const resourceTitle=localizedIndustryResourceTitle(resource,locale)
  const candidates=referenceCandidates(item,items,resource.id),current=selected[resource.id],stale=current&&!candidates.some(row=>choiceKey(row)===choiceKey(current))
  return <div key={resource.id}><label>{resourceTitle}<select aria-label={t('market.industry.references.sourceAria',{title:resourceTitle})} disabled={busy} value={current?choiceKey(current):''} onChange={event=>{const choice=candidates.find(row=>choiceKey(row)===event.target.value);setSelected(previous=>{const next={...previous};if(choice)next[resource.id]=choice;else delete next[resource.id];return next});setError('')}}><option value="">{requireAll?t('market.industry.references.chooseFixed'):t('market.industry.references.defer')}</option>{stale&&<option value={choiceKey(current)}>{t('market.industry.references.stale')}</option>}{candidates.map(choice=>{const sourceItem=items.find(row=>row.id===choice.sourceItemId);return <option key={choiceKey(choice)} value={choiceKey(choice)}>{sourceItem?localizedMarketItemCopy(sourceItem,locale).title:choice.sourceItemId} · {resource.version} · {choice.sourceHash.slice(0,10)}</option>})}</select></label>{!candidates.length&&<p>{['plan','plugin'].includes(resource.kind)?t('market.industry.references.mappingNeeded'):t('market.industry.references.noSkill')}</p>}</div>
 })}<button type={embedded?'button':'submit'} disabled={busy||requireAll&&!refs.every(resource=>selected[resource.id])} onClick={embedded?submit:undefined}>{busy?t('market.industry.references.saving'):requireAll?t('market.industry.references.fixTemplate'):t('market.industry.references.save')}</button></>
 return <section className={css.sheet} aria-label={t('market.industry.references.aria')}><h3>{t('market.industry.references.title')}</h3><p>{t('market.industry.references.help')}</p>{error&&<p role="alert">{error}</p>}{embedded?<div className={base.form}>{fields}</div>:<form className={base.form} onSubmit={event=>{event.preventDefault();submit()}}>{fields}</form>}</section>
}
