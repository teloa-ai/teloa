import {useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {TeloaI18n} from './i18n/index.js'
import {I18nProvider} from './i18n/provider.js'
import {CapabilityNotice} from './CapabilityNotice.js'
import type {SessionCapabilityReader} from './session-capability-presentation.js'

export function SessionCapabilityNotice({sessionId,reader,i18n}:PropsRuntime<'conversation.input.dock'>&{reader:SessionCapabilityReader;i18n:TeloaI18n}){
 const state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot)
 if(state.sessionId!==sessionId||state.status==='idle'||state.status==='ready'&&!state.deniedCapability)return null
 const reason=state.status==='checking'?'checking':state.status==='unavailable'?'unavailable':undefined
 return <I18nProvider runtime={i18n}><CapabilityNotice capability={state.deniedCapability??'general-agent'} {...(reason?{reason}:{})}/></I18nProvider>
}
