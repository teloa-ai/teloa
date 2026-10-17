import {useEffect,useRef,useState} from 'react'
import {useI18n} from './i18n/provider.js'
import {subscribeSettingsPanelVisible} from './AutoDreamSettingsPage.js'
import {voiceServiceCopy} from './voice-service-copy.js'
import type {SpeechProviderId,SpeechRecognitionProviderId,VoiceServiceApi,VoiceServiceSettings} from './voice-service-api.js'
import css from './AutoDreamSettingsPage.module.css'
import voiceCss from './MiniMaxVoiceSettings.module.css'
import {MiniMaxVoicePicker} from './MiniMaxVoicePicker.js'
import {miniMaxVoiceName,type MiniMaxVoice} from './minimax-voice-catalog.js'

type Draft={model:string;voiceId:string;apiKey:string}
/** 播报和识别分别配置；试听不启动通话、麦克风或员工任务。 */
export function MiniMaxVoiceSettings({api}:{api:VoiceServiceApi}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof voiceServiceCopy>[1])=>voiceServiceCopy(locale,key)
 const [status,setStatus]=useState<VoiceServiceSettings>(),[selection,setSelection]=useState<SpeechProviderId>(),[drafts,setDrafts]=useState<Partial<Record<SpeechProviderId,Draft>>>({}),[asrKey,setAsrKey]=useState(''),[asrSelection,setAsrSelection]=useState<SpeechRecognitionProviderId>()
 const [saving,setSaving]=useState(false),[testing,setTesting]=useState(false),[error,setError]=useState(false),[saved,setSaved]=useState<'tts'|'asr'|'asr-key'>(),[clip,setClip]=useState<string>(),[previewVoice,setPreviewVoice]=useState<MiniMaxVoice>(),[appliedVoice,setAppliedVoice]=useState<MiniMaxVoice>(),[playBlocked,setPlayBlocked]=useState(false)
 const audio=useRef<HTMLAudioElement>(null),request=useRef<AbortController>(),url=useRef<string>(),generation=useRef(0),statusGeneration=useRef(0),visible=useRef(true),mounted=useRef(false)
 const stop=()=>{generation.current++;request.current?.abort();request.current=undefined;audio.current?.pause();if(url.current)URL.revokeObjectURL(url.current);url.current=undefined;setClip(undefined);setTesting(false);setPreviewVoice(undefined);setPlayBlocked(false);setAppliedVoice(undefined)}
 useEffect(()=>{
  mounted.current=true
  const load=()=>{const current=++statusGeneration.current;api.status().then(value=>{if(mounted.current&&current===statusGeneration.current){setStatus(value);setError(false)}},()=>{if(mounted.current&&current===statusGeneration.current)setError(true)})}
  load();const off=subscribeSettingsPanelVisible(next=>{visible.current=next;if(next)load();else stop()})
  return()=>{mounted.current=false;generation.current++;statusGeneration.current++;off();request.current?.abort();audio.current?.pause();if(url.current)URL.revokeObjectURL(url.current)}
 },[api])
 useEffect(()=>{if(clip&&visible.current){const current=generation.current;void audio.current?.play().catch(()=>{if(current===generation.current)setPlayBlocked(true)})}},[clip])
 const selected=status?.providers.find(p=>p.id===(selection??status.providerId)),draft=selected?(drafts[selected.id]??{model:selected.model,voiceId:selected.voiceId,apiKey:''}):undefined
 const profileDirty=!!(selected&&draft&&(draft.model!==selected.model||draft.voiceId!==selected.voiceId||draft.apiKey.trim())),dirty=profileDirty||selected?.id!==status?.providerId
 const asrProviderId=asrSelection??status?.asr.providerId,asrDirty=!!status&&asrProviderId!==status.asr.providerId
 const writable=!!status?.writable&&status.secure
 const edit=(patch:Partial<Draft>)=>{if(!selected||!draft)return;stop();setDrafts(before=>({...before,[selected.id]:{...draft,...patch}}));setSaved(undefined);setAppliedVoice(undefined)}
 const useVoice=async(voice:MiniMaxVoice)=>{
  if(saving||!selected?.configured||!writable)return
  stop();statusGeneration.current++;setSaving(true);setError(false);setSaved(undefined);setAppliedVoice(undefined)
  try{
   const result=await api.save({providerId:'minimax',voiceId:voice.id})
   if(!mounted.current)return
   statusGeneration.current++;setStatus(result);setAppliedVoice(result.providerId==='minimax'&&result.voiceId===voice.id?voice:undefined)
   // 选用不提交或清空尚未保存的模型与密钥草稿。
   setDrafts(before=>before.minimax?{...before,minimax:{...before.minimax,voiceId:voice.id}}:before)
  }catch{if(mounted.current)setError(true)}finally{if(mounted.current)setSaving(false)}
 }
 const save=async(kind:'tts'|'asr'|'asr-key'='tts')=>{
  if(!status||!selected||!draft||!asrProviderId)return
  const target=kind==='asr-key'?status.providers.find(p=>p.id==='minimax')!:selected,value=kind==='tts'?draft:{model:target.model,voiceId:target.voiceId,apiKey:asrKey}
  stop();statusGeneration.current++;setSaving(true);setSaved(undefined);setAppliedVoice(undefined);setError(false)
  try{
   const result=await api.save(kind==='asr'?{asrProviderId}:{providerId:target.id,model:value.model.trim(),voiceId:value.voiceId.trim(),...(value.apiKey.trim()?{apiKey:value.apiKey.trim()}:{}),...(kind==='asr-key'?{setDefault:false}:{})})
   if(!mounted.current)return
   statusGeneration.current++;setStatus(result)
   if(kind==='asr-key')setAsrKey('');else if(kind==='asr')setAsrSelection(undefined);else setDrafts(before=>{const next={...before};delete next[target.id];return next})
   setSaved(kind)
  }catch{if(mounted.current)setError(true)}finally{if(mounted.current)setSaving(false)}
 }
 const preview=async(voice?:MiniMaxVoice)=>{
  if(!selected||saving)return
  stop();const current=generation.current,abort=new AbortController();request.current=abort;setTesting(true);setError(false);setPreviewVoice(voice)
  try{const result=await api.test(selected.id,abort.signal,voice?{model:selected.model,voiceId:voice.id,sampleLanguage:voice.language}:undefined);if(abort.signal.aborted||current!==generation.current)return;const bytes=Uint8Array.from(atob(result.audio),char=>char.charCodeAt(0));url.current=URL.createObjectURL(new Blob([bytes],{type:result.mime}));setClip(url.current)}
  catch{if(!abort.signal.aborted&&current===generation.current){setError(true);setPreviewVoice(undefined)}}finally{if(current===generation.current){setTesting(false);request.current=undefined}}
 }
 return <section className={css.page} aria-label={copy('title')}><h2>{copy('title')}</h2>
  {error&&<p className={voiceCss.notice} role="alert">{copy('failed')}</p>}
  <div className={css.row}>
   <div className={css.rowText}><strong>{copy('speech')}</strong><p>{selected?.configured?copy('configured'):copy('missing')}</p></div>
   <div className={css.rowControl}><select aria-label={copy('provider')} value={selected?.id??''} disabled={saving||!status} onChange={event=>{stop();setSelection(event.target.value as SpeechProviderId);setSaved(undefined);setAppliedVoice(undefined);setError(false)}}>{status?.providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
  </div>
  {selected?.id==='minimax'&&<><MiniMaxVoicePicker currentVoiceId={status?.providerId==='minimax'?selected.voiceId:undefined} disabled={saving||!writable} configured={selected.configured} previewId={previewVoice?.id} previewing={testing} onPreview={voice=>void preview(voice)} onStop={stop} onUse={voice=>void useVoice(voice)}/>{appliedVoice&&<p className={voiceCss.inlineStatus} role="status">{copy('voiceApplied')} · {miniMaxVoiceName(appliedVoice,locale)}</p>}</>}
  {(testing||clip||selected?.id!=='minimax')&&<div className={voiceCss.preview}>
   {selected?.id!=='minimax'&&<div className={voiceCss.actions}><button type="button" disabled={saving||testing||!selected?.configured||profileDirty} onClick={()=>void preview()}>{copy('test')}</button>{(testing||clip)&&<button type="button" onClick={stop}>{copy('stop')}</button>}</div>}
   {selected?.id!=='minimax'&&profileDirty&&<p>{copy('saveFirst')}</p>}
   {testing&&<p role="status">{copy('testing')}{previewVoice?' · '+miniMaxVoiceName(previewVoice,locale):''}</p>}
   {clip&&<><audio ref={audio} controls src={clip} onEnded={()=>setPreviewVoice(undefined)}/>{playBlocked&&<p>{copy('playFailed')}</p>}</>}
  </div>}
  <section aria-label={copy('recognition')}>
   <form className={css.row} onSubmit={event=>{event.preventDefault();void save('asr')}}>
    <div className={css.rowText}><strong>{copy('recognition')}</strong><p>{status&&(status.asr.providerId==='sensevoice-local'?copy('asrLocal')+' · '+(status.asr.configured?copy('ready'):copy('notReady')):copy('asrCloud')+' · '+(status.asr.configured?copy('configured'):copy('missing')))}</p></div>
    <div className={css.rowControl}><select aria-label={copy('asrProvider')} value={asrProviderId??''} disabled={saving||!writable} onChange={event=>{stop();setAsrSelection(event.target.value as SpeechRecognitionProviderId);setSaved(undefined);setError(false)}}><option value="minimax">{copy('asrCloud')}</option><option value="sensevoice-local">{copy('asrLocal')}</option></select>
     {asrDirty&&<button type="submit" disabled={saving||!writable}>{copy('saveAsrSettings')}</button>}{(saved==='asr'||saved==='asr-key')&&<span role="status">{copy('saved')}</span>}
    </div>
   </form>
   {asrProviderId==='sensevoice-local'&&!status?.asr.configured&&<p className={voiceCss.notice}>{copy('asrLocalHint')}</p>}
  </section>
  <details className={voiceCss.advanced} open={selected?.id!=='minimax'||!selected.configured}><summary>{copy('advancedVoice')}</summary>
   <form className={voiceCss.form} onSubmit={event=>{event.preventDefault();void save()}}>
    <div className={voiceCss.fields}><div><label htmlFor="voice-model">{copy('model')}</label><input id="voice-model" value={draft?.model??''} onChange={event=>edit({model:event.target.value})} disabled={saving||!writable} maxLength={128}/></div><div><label htmlFor="voice-id">{copy('voice')}</label><input id="voice-id" value={draft?.voiceId??''} onChange={event=>edit({voiceId:event.target.value})} disabled={saving||!writable} maxLength={128}/></div></div>
    <label htmlFor="voice-key">{copy('key')}</label><input id="voice-key" type="password" autoComplete="new-password" value={draft?.apiKey??''} placeholder={selected?.configured?copy('replace'):'API Key'} onChange={event=>edit({apiKey:event.target.value})} disabled={saving||!writable}/><p>{copy('hint')}</p>
    <div className={voiceCss.actions}><button type="submit" disabled={saving||!writable||!dirty||!draft?.model.trim()||!draft.voiceId.trim()||!selected?.configured&&!draft.apiKey.trim()}>{copy('save')}</button><button type="button" disabled={saving||!dirty} onClick={()=>{stop();if(selected)setDrafts(before=>{const next={...before};delete next[selected.id];return next});setSelection(status?.providerId);setSaved(undefined)}}>{copy('cancel')}</button>{saved==='tts'&&<span role="status">{copy('saved')}</span>}</div>
   </form>
   {asrProviderId==='minimax'&&selected?.id!=='minimax'&&<form className={voiceCss.form} onSubmit={event=>{event.preventDefault();void save('asr-key')}}><label htmlFor="voice-asr-key">{copy('asrKey')}</label><input id="voice-asr-key" type="password" autoComplete="new-password" value={asrKey} placeholder={status?.providers.find(p=>p.id==='minimax')?.configured?copy('replace'):'API Key'} onChange={event=>{setAsrKey(event.target.value);setSaved(undefined)}} disabled={saving||!writable}/><div className={voiceCss.actions}><button type="submit" disabled={saving||!writable||!asrKey.trim()}>{copy('saveAsr')}</button></div></form>}
  </details>
  {status&&(!status.writable||!status.secure)&&<p className={voiceCss.notice}>{copy('locked')}</p>}
 </section>
}
