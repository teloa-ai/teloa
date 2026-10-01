import {useState} from 'react'
import type {PageCreateApi} from './page-create-api.js'
import type {PageCreateDraftPreview} from '@teloa/contract'
import {CreateEntry} from './CreateEntry.js'
import {useI18n} from './i18n/provider.js'
import {businessDomainAutoShortName,businessDomainScopeKeyValid,createEntityNameKey,createSentencePrompt} from './page-create-presentation.js'
import css from './BusinessDomainCreateEntry.module.css'

type Props={api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void;openMarket:()=>void;confirm:(preview:PageCreateDraftPreview)=>Promise<string>;open:(loadId:string)=>void}

/**
 * 新业务的范围在加载后才会登记，因此不能复用已有范围的下拉框，也不能拿 `general` 充数。
 * 显示名与范围键是两件事：显示名可以是任何文字，只进草案清单的标题；范围键必须是
 * `teloa_create_directory/draft` 认的 ASCII 短名（`page-create-presentation.ts` 里的判据），
 * 不合规就不渲染 `CreateEntry`。显示名恰好合规时顺手替用户填一份短名，仍可再改；
 * 中文名不做拼音或其他转写——不引库、不猜。
 */
export function BusinessDomainCreateEntry({api,prepare,openMarket,confirm,open}:Props){
 const {t}=useI18n()
 const [name,setName]=useState('')
 const [shortName,setShortName]=useState('')
 const [shortNameTouched,setShortNameTouched]=useState(false)
 const value=shortName.trim()
 const scopeValid=businessDomainScopeKeyValid(value)

 const handleName=(next:string)=>{
  setName(next)
  const auto=businessDomainAutoShortName(next,shortNameTouched)
  if(auto!==undefined)setShortName(auto)
 }
 const handleShortName=(next:string)=>{setShortNameTouched(true);setShortName(next)}

 /**
  * 「用一句话描述」那一条由 `CreateEntry` 自己拼好并回调这里；固定前缀按同样的输入重算一遍，
  * 命中后换成范围键与显示名都点名的那一版——`displayName` 只有这一支会传给 `createSentencePrompt`。
  * 对不上前缀（例如显示名为空）就原样转发，不强改模型看不懂的文本。
  */
 const handlePrepare=(prompt:{sourceId:string;title:string;text:string})=>{
  const displayName=name.trim()
  const entityLine=t('create.sentence.prompt.entity',{entity:t(createEntityNameKey('business-domain'))})
  const scopeLine=t('create.sentence.prompt.scope',{scope:value})
  const prefix=[entityLine,scopeLine,t('create.sentence.prompt')].join('\n')+'\n'
  if(!displayName||!prompt.text.startsWith(prefix)){prepare(prompt);return}
  prepare(createSentencePrompt('business-domain',value,prompt.text.slice(prefix.length),t,displayName))
 }

 return <section className={css.entry} aria-label={t('create.businessDomain.scope.aria')}>
  <label className={css.label}>{t('create.businessDomain.scope.label')}
   <input className={css.input} value={name} maxLength={80} placeholder={t('create.businessDomain.scope.placeholder')} onChange={event=>handleName(event.target.value)}/>
  </label>
  <p className={css.hint}>{t('create.businessDomain.scope.hint')}</p>
  <label className={css.label}>{t('create.businessDomain.shortName.label')}
   <input className={css.input} value={shortName} maxLength={64} placeholder={t('create.businessDomain.shortName.placeholder')} onChange={event=>handleShortName(event.target.value)}/>
  </label>
  {value&&!scopeValid
   ?<p role="alert" className={css.alert}>{t('create.businessDomain.shortName.invalid')}</p>
   :<p className={css.hint}>{t('create.businessDomain.shortName.hint')}</p>}
  {scopeValid&&<CreateEntry entity="business-domain" scope={value} api={api} prepare={handlePrepare} openMarket={openMarket} onConfirm={confirm} afterConfirm={open}/>}
 </section>
}
