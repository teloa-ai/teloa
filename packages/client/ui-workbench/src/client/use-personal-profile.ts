import {useSyncExternalStore} from 'react'
import {personalAvatarInitials,personalDisplayName,personalProfile} from './personal-profile.js'
import {useI18n} from './i18n/provider.js'

/** 所有本人展示共用当前语言兜底，不修改宿主身份或写回资料。 */
export function usePersonalProfile(){
  const {t}=useI18n()
  const profile=useSyncExternalStore(personalProfile.subscribe,personalProfile.getSnapshot,personalProfile.getSnapshot)
  return {...profile,displayName:personalDisplayName(profile.displayName,t('profile.account')),initials:personalAvatarInitials(profile.displayName)}
}
