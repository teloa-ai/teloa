import {useEffect,useState,useSyncExternalStore} from 'react'
import {personalProfile} from './personal-profile.js'
import css from './PersonalProfileSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

export function PersonalProfileSettings(){
  const {locale,t}=useI18n()
  const profile=useSyncExternalStore(personalProfile.subscribe,personalProfile.getSnapshot,personalProfile.getSnapshot)
  const [name,setName]=useState(profile.displayName),[notice,setNotice]=useState('')
  useEffect(()=>setName(profile.displayName),[profile.displayName])
  return <section className={css.profile} aria-label={t('profile.title')}>
    <div><strong>{t('profile.title')}</strong><p>{t('profile.description')}</p></div>
    <form onSubmit={event=>{event.preventDefault();try{personalProfile.setDisplayName(name);setNotice(t('profile.saved'))}catch(error){setNotice(localizeWorkError(locale,error))}}}>
      <label>{t('profile.displayName')}<input aria-label={t('profile.displayName')} required maxLength={40} value={name} onChange={event=>{setName(event.target.value);setNotice('')}}/></label>
      <button type="submit" disabled={name.trim()===profile.displayName}>{t('profile.save')}</button>
    </form>
    {notice&&<p role="status" className={css.notice}>{notice}</p>}
  </section>
}
