import { useEffect,useRef,useState } from 'react'
import { Check,FileText,Plus,RefreshCw,Search,X } from 'lucide-react'
import type { ResourceDirectory,WorkResource } from '@teloa/contract'
import type { ResourceApi } from './resource-api.js'
import type { HomeResourceSelection } from './home-resource-selection.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './HomeResourcePicker.module.css'

const maximum=8

export function HomeResourcePicker({api,selected,change,embedded=false,compact=false}:{api:ResourceApi;selected:readonly HomeResourceSelection[];change:(rows:HomeResourceSelection[])=>void;embedded?:boolean;compact?:boolean}){
  const {locale,t}=useI18n()
  const [directory,setDirectory]=useState<ResourceDirectory>()
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState<string>()
  const [query,setQuery]=useState('')
  const generation=useRef(0)
  const pending=useRef<AbortController|undefined>(undefined)

  const refresh=async()=>{
    const request=++generation.current
    pending.current?.abort()
    const controller=new AbortController()
    pending.current=controller
    setLoading(true)
    setError(undefined)
    try{
      const directory=await api.directory()
      if(controller.signal.aborted||request!==generation.current)return
      setDirectory(directory)
    }catch(cause){
      if(controller.signal.aborted||request!==generation.current)return
      setError(localizeWorkError(locale,cause))
    }finally{
      if(!controller.signal.aborted&&request===generation.current)setLoading(false)
    }
  }

  useEffect(()=>{
    void refresh()
    return ()=>{pending.current?.abort();generation.current++}
  },[api,locale])

  const needle=query.trim().toLocaleLowerCase()
  const available=(directory?.resources.filter(resource=>resource.status==='active')??[]).filter(resource=>!needle||resource.title.toLocaleLowerCase().includes(needle))
  const selectedIds=new Set(selected.map(row=>row.id))
  const add=(resource:WorkResource)=>{
    if(selectedIds.has(resource.id)||selected.length>=maximum)return
    change([...selected,{id:resource.id,version:resource.version,title:resource.title}])
  }
  const remove=(id:string)=>change(selected.filter(row=>row.id!==id))
  const status=(row:HomeResourceSelection)=>{
    if(!directory)return undefined
    const current=directory.resources.find(resource=>resource.id===row.id)
    if(!current)return t('homeResource.missing')
    if(current.status==='withdrawn')return t('homeResource.withdrawn')
    if(current.version!==row.version)return t('homeResource.changed',{version:current.version})
    return undefined
  }

  return <section className={[css.picker,embedded?css.embedded:'',compact?css.compact:''].filter(Boolean).join(' ')} aria-label={t('homeResource.aria')}>
    {!embedded&&<><div className={css.heading}><div><strong>{t('homeResource.title')}</strong><p>{t('homeResource.description')}</p></div><button type="button" className={css.refresh} onClick={()=>void refresh()} disabled={loading} aria-label={t('homeResource.refresh')}><RefreshCw size={15}/></button></div><p className={css.notice}>{t('homeResource.notice')}</p></>}
    <div className={css.filterRow}><label className={css.filter}><Search size={14}/><span className={css.srOnly}>{t('homeResource.search')}</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('homeResource.search')}/></label>{embedded&&<button type="button" className={css.refresh} onClick={()=>void refresh()} disabled={loading} aria-label={t('homeResource.refresh')}><RefreshCw size={15}/></button>}</div>
    {error&&<p className={css.error} role="alert">{error}</p>}
    {selected.length>0&&<ul className={css.selected} aria-label={t('homeResource.selected')}>{selected.map(row=>{
      const invalid=status(row)
      return <li key={row.id} className={invalid?css.invalid:undefined}><span className={css.resourceIcon}><Check size={14}/></span><span className={css.resourceCopy}><strong>{row.title}</strong><small>{t('homeResource.version',{version:row.version})}</small>{invalid&&<em>{invalid}</em>}</span><button type="button" onClick={()=>remove(row.id)} aria-label={t('homeResource.removeAria',{title:row.title})}><X size={14}/>{t('homeResource.remove')}</button></li>
    })}</ul>}
    {loading&&!directory&&<p className={css.muted} role="status">{t('homeResource.loading')}</p>}
    {directory&&<div className={css.directory} aria-label={t('homeResource.available')}>
      {available.length===0?<p className={css.muted}>{t(needle?'homeResource.noMatch':'homeResource.empty')}</p>:available.map(resource=>{
        const chosen=selectedIds.has(resource.id)
        return <div className={css.resource} key={resource.id}><span className={css.resourceIcon}><FileText size={15}/></span><span className={css.resourceCopy}><strong>{resource.title}</strong><small>{t('homeResource.version',{version:resource.version})}</small></span><button type="button" onClick={()=>add(resource)} disabled={chosen||selected.length>=maximum}>{chosen?<><Check size={14}/>{t('homeResource.added')}</>:selected.length>=maximum?t('homeResource.limit'):<><Plus size={14}/>{t('homeResource.add')}</>}</button></div>
      })}
    </div>}
  </section>
}
