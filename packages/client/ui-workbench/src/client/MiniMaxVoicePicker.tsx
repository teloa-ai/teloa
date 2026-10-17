import {useState} from 'react'
import {Volume2,Square} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {miniMaxVoices,miniMaxVoiceName,type MiniMaxVoice} from './minimax-voice-catalog.js'
import {voiceServiceCopy} from './voice-service-copy.js'
import {useI18n} from './i18n/provider.js'
import css from './MiniMaxVoiceSettings.module.css'
import settingsCss from './AutoDreamSettingsPage.module.css'

type Props={currentVoiceId:string|undefined;disabled:boolean;configured:boolean;previewId:string|undefined;previewing:boolean;onPreview:(voice:MiniMaxVoice)=>void;onStop:()=>void;onUse:(voice:MiniMaxVoice)=>void}
/** 浏览与试听不保存；只有明确选用才更新通话音色。 */
export function MiniMaxVoicePicker({currentVoiceId,disabled,configured,previewId,previewing,onPreview,onStop,onUse}:Props){
 const {locale}=useI18n(),copy=(key:Parameters<typeof voiceServiceCopy>[1])=>voiceServiceCopy(locale,key)
 const [selection,setSelection]=useState<string>()
 const voiceId=selection??currentVoiceId??miniMaxVoices[0]!.id,current=miniMaxVoices.find(row=>row.id===currentVoiceId)
 const voice=miniMaxVoices.find(row=>row.id===voiceId)??{id:voiceId,language:'zh' as const,zh:copy('customVoice'),hant:copy('customVoice'),en:copy('customVoice')}
 const name=miniMaxVoiceName(voice,locale),playing=voiceId===previewId,changed=voiceId!==currentVoiceId
 return <section className={settingsCss.row} aria-label={copy('voices')}>
  <div className={settingsCss.rowText}><strong>{copy('voices')}</strong><p>{!configured?copy('configureBeforePreview'):changed?copy('voicePending'):copy('currentVoice')+' · '+(current?miniMaxVoiceName(current,locale):copy('customVoice'))}</p></div>
  <div className={settingsCss.rowControl+' '+css.voiceControl}>
   <select aria-label={copy('voices')} value={voiceId} disabled={disabled} onChange={event=>{onStop();setSelection(event.target.value)}}>
    {!miniMaxVoices.some(row=>row.id===voiceId)&&<option value={voiceId}>{copy('customVoice')}</option>}
    {(['zh','en'] as const).map(language=><optgroup key={language} label={language==='zh'?copy('mandarin'):'English'}>{miniMaxVoices.filter(row=>row.language===language).map(row=><option key={row.id} value={row.id}>{miniMaxVoiceName(row,locale)} · {locale.startsWith('zh')?row.en:row.zh}</option>)}</optgroup>)}
   </select>
   <ToolbarIconButton label={`${playing?copy('stop'):copy('listen')} · ${name}`} icon={playing?Square:Volume2} disabled={disabled||!configured||previewing&&!playing} onClick={()=>playing?onStop():onPreview(voice)}/>
   {changed&&<button type="button" className={css.applyVoice} disabled={disabled||!configured} onClick={()=>onUse(voice)}>{copy('useVoice')}</button>}
  </div>
 </section>
}
