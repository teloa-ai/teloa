import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent} from 'react'
import {createPortal} from 'react-dom'
import {Mic,MicOff,PhoneOff,MessageCircle,Volume2,Square,X} from 'lucide-react'
import type {VoiceCall,RoleAvatarKey} from '@teloa/contract'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {TwinAvatar} from './TwinAvatar.js'
import {openVoiceMicrophone,encodeVoiceWav} from './voice-microphone.js'
import {openDuplexVoice,type DuplexVoiceClient,type DuplexClientEvent} from '@teloa/realtime-voice/client'
import type {EmployeeVoiceApi,VoiceMediaBinding,VoiceMediaSnapshot} from './employee-voice-api.js'
import {employeeVoiceCopy} from './employee-voice-copy.js'
import {useI18n} from './i18n/provider.js'
import {companionSafePoint} from './assistant-companion-position.js'
import css from './EmployeeVoiceCall.module.css'
import assistantAvatar from '../brand/companion/icon.webp'
type RoleTarget={id:string;version:number;name:string;avatarKey?:RoleAvatarKey|undefined;roleKind?:'employee'|'twin';initials?:string}
export type VoiceCallTarget=({kind:'role'}&RoleTarget)|{kind:'assistant';name:string;contextVersion:number}
type State='preparing'|'connecting'|'listening'|'recording'|'thinking'|'speaking'|'muted'|'ended'|'closeFailed'
/** 非模态通话条在导航和抽屉之外常驻；关详情不挂断，挂断不停止原会话工作。 */
type Props={onEnded?:(()=>void)|undefined;api:EmployeeVoiceApi;sessionId:string|undefined;openConversation:(id:string)=>void;dismiss:()=>void}&({role:RoleTarget;target?:never}|{target:VoiceCallTarget;role?:never})
export function EmployeeVoiceCall({api,role,target:providedTarget,sessionId,openConversation,dismiss,onEnded}:Props){
 const [target]=useState<VoiceCallTarget>(()=>providedTarget??{kind:'role',...role!})
 const {locale}=useI18n(),copy=(key:Parameters<typeof employeeVoiceCopy>[1])=>employeeVoiceCopy(locale,key)
 const [state,setState]=useState<State>('preparing'),[error,setError]=useState<string>(),[muted,setMuted]=useState(false),[playBlocked,setPlayBlocked]=useState(false),[lastText,setLastText]=useState<string>(),[elapsed,setElapsed]=useState(0)
 const startTime=useRef<number>(),started=useRef(false),controls=useRef<{hangup:()=>Promise<void>;mute:()=>Promise<void>;interrupt:()=>Promise<void>;send:()=>void;play:()=>Promise<void>;sessionId:string}|undefined>()
 const done=useRef(false)
 const [surface,setSurface]=useState<HTMLElement|null>(null)
 const panelRef=useRef<HTMLElement|null>(null),positionRef=useRef<{x:number;y:number;maxWidth:number;maxHeight:number}>(),drag=useRef<{pointerId:number;handle:HTMLElement;start:{x:number;y:number};origin:{x:number;y:number};moved:boolean}>()
 const [position,setPosition]=useState<typeof positionRef.current>(),[dragging,setDragging]=useState(false)
 function place(point:{x:number;y:number}){
  const box=panelRef.current?.getBoundingClientRect();if(!box?.width||!box.height)return
  const viewport=window.visualViewport,bounds={x:viewport?.offsetLeft??0,y:viewport?.offsetTop??0,width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight}
  const next={...companionSafePoint(point,box,bounds,[]),maxWidth:Math.max(0,bounds.width-32),maxHeight:Math.max(0,bounds.height-16)},previous=positionRef.current
  if(previous&&previous.x===next.x&&previous.y===next.y&&previous.maxWidth===next.maxWidth&&previous.maxHeight===next.maxHeight)return
  positionRef.current=next;setPosition(next)
 }
 function releaseDrag(){
  const current=drag.current;drag.current=undefined;setDragging(false)
  if(current?.handle.hasPointerCapture(current.pointerId))current.handle.releasePointerCapture(current.pointerId)
 }
 function beginDrag(event:ReactPointerEvent<HTMLElement>){
  if(!event.isPrimary||event.button!==0||event.target instanceof Element&&event.target.closest('button,a,input,textarea,select,[contenteditable="true"]'))return
  const box=panelRef.current?.getBoundingClientRect();if(!box)return
  event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId)
  drag.current={pointerId:event.pointerId,handle:event.currentTarget,start:{x:event.clientX,y:event.clientY},origin:{x:box.x,y:box.y},moved:false};setDragging(true)
 }
 function moveDrag(event:ReactPointerEvent<HTMLElement>){
  const current=drag.current;if(!current||current.pointerId!==event.pointerId)return
  const dx=event.clientX-current.start.x,dy=event.clientY-current.start.y
  if(Math.hypot(dx,dy)>5)current.moved=true
  if(current.moved){event.preventDefault();place({x:current.origin.x+dx,y:current.origin.y+dy})}
 }
 function endDrag(event:ReactPointerEvent<HTMLElement>){if(drag.current?.pointerId!==event.pointerId)return;if(event.type==='pointerup')moveDrag(event);releaseDrag()}
 function moveWithKeyboard(event:ReactKeyboardEvent<HTMLElement>){
  const step=({ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}} as Record<string,{x:number;y:number}>)[event.key],box=panelRef.current?.getBoundingClientRect()
  if(!step||!box)return
  event.preventDefault();event.stopPropagation();const distance=event.shiftKey?40:16;place({x:box.x+step.x*distance,y:box.y+step.y*distance})
 }
 useEffect(()=>{
  const panel=panelRef.current;if(!panel)return
  const fit=()=>{const box=panel.getBoundingClientRect();place(positionRef.current??{x:box.x,y:box.y})},observer=new ResizeObserver(fit)
  observer.observe(panel);fit();window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit)
  return()=>{observer.disconnect();window.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('scroll',fit);releaseDrag()}
 },[surface])
 useEffect(()=>{
  // 原生模态层会使外部控件 inert；只移动控制条的展示，不重新建立媒体或会话。
  const sync=()=>{
   // 原生 backdrop 的命中对象是实际最上层 dialog，不能用 DOM 顺序代替打开顺序。
   const native=document.elementFromPoint(1,1)?.closest<HTMLElement>('dialog:modal')
   const top=native??Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(node=>node.isConnected&&node.getClientRects().length>0).at(-1)
   setSurface(previous=>previous===(top??document.body)?previous:top??document.body)
  }
  sync();const observer=new MutationObserver(sync)
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden','aria-hidden']})
  return ()=>observer.disconnect()
 },[])
 const [initialSession,setInitialSession]=useState(sessionId)
 useEffect(()=>{if(!initialSession&&sessionId)setInitialSession(sessionId)},[initialSession,sessionId])
 useEffect(()=>{const timer=setInterval(()=>{if(startTime.current&&!done.current)setElapsed(Math.floor((Date.now()-startTime.current)/1000))},1000);return ()=>clearInterval(timer)},[])
 useEffect(()=>{
  if(!initialSession||started.current)return
  const sessionId=initialSession
  started.current=true
  const requestId=crypto.randomUUID(),mediaAbort=new AbortController();let active=true,closing=false,localMuted=false,waiting=false,finished=false,finishPromise:Promise<boolean>|undefined,turnCommit:string|undefined,call:VoiceCall|null=null,bound:VoiceMediaBinding|undefined,mic:Awaited<ReturnType<typeof openVoiceMicrophone>>|undefined,duplex:DuplexVoiceClient|undefined,mediaKind:'legacy'|'realtime'|undefined,realtimePhase:'listening'|'recording'|'thinking'|'speaking'='listening',audio:HTMLAudioElement|undefined,audioUrl:string|undefined,playingGeneration=-1,polled=false,timer:ReturnType<typeof setTimeout>|undefined
  let parts:Float32Array[]=[],rate=0,samples=0,silent=0,voiced=0
  const stateTo=(next:State)=>{if(active&&!closing)setState(next)}
  const resetCapture=()=>{parts=[];samples=0;silent=0;voiced=0}
  const stopAudio=()=>{audio?.pause();if(audio){audio.onplaying=null;audio.onended=null;audio.onerror=null;audio.removeAttribute('src');audio.load()}audio=undefined;if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=undefined;if(active)setPlayBlocked(false)}
  const stopLocal=async()=>{mediaAbort.abort();resetCapture();stopAudio();await Promise.all([mic?.close(),duplex?.close()]);mic=undefined;duplex=undefined}
  const finish=():Promise<boolean>=>{
   if(finished)return Promise.resolve(true)
   if(finishPromise)return finishPromise
   closing=true;done.current=true;if(timer)clearTimeout(timer)
   finishPromise=(async()=>{
    let localClosed=true
    try{await stopLocal()}catch{localClosed=false}
    // 首次 media 回包可能仍在途；关闭也必须能纯读绑定并回执，不依赖已停止的轮询。
    if(!bound){
     try{
      const original=await api.read(requestId)
      if(original){const snapshot=await api.media({callId:original.id,callGeneration:original.callGeneration});if(snapshot)bound={callId:original.id,callGeneration:original.callGeneration,token:snapshot.token}}
     }catch{/* 纯读绑定失败仍按原 requestId 尝试结束宿主预约。 */}
    }
    if(localClosed&&bound)await api.closed(bound).catch(()=>{})
    const result=await api.end(requestId)
    if(!localClosed||result.call?.failure==='media-close-failed'){if(active){setState('closeFailed');setError(copy('closeFailed'))}return false}
    finished=true
    if(active){setState('ended');setError(undefined);onEnded?.()}
    return true
   })().finally(()=>{finishPromise=undefined})
   return finishPromise
  }
  const fail=async(reason:string)=>{if(active)setError(reason);try{if(await finish()&&active)setError(reason)}catch{if(active){setState('closeFailed');setError(copy('closeFailed'))}}}
  const upload=()=>{
   if(!active||closing||localMuted||waiting||!bound||call?.state!=='connected')return
   const buffer=parts,capturedRate=rate,voiceSamples=voiced;resetCapture()
   if(voiceSamples<capturedRate*.2)return
   waiting=true;setError(undefined);stateTo('thinking')
   const bytes=encodeVoiceWav(buffer,capturedRate);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
   const current=bound
   void api.audio({...current,turnId:crypto.randomUUID(),audio:btoa(binary)}).then(result=>{
    if(!active||closing||bound!==current)return
    if(result.text){setLastText(result.text);turnCommit=(result.receipt as {commitId?:string}|null)?.commitId;if(!turnCommit){waiting=false;setError(copy('failed'));stateTo(localMuted?'muted':'listening')}}
    else{waiting=false;stateTo(localMuted?'muted':'listening')}
   }).catch(()=>{if(active&&!closing){waiting=false;setError(copy('failed'));stateTo(localMuted?'muted':'listening')}})
  }
  const samplesReceived=(chunk:Float32Array,sampleRate:number)=>{
   if(!active||closing||localMuted||waiting||call?.state!=='connected'||audio&&!audio.paused)return
   rate=sampleRate;let energy=0;for(const value of chunk)energy+=value*value
   const voicedNow=Math.sqrt(energy/chunk.length)>.015
   if(!samples&&!voicedNow)return
   parts.push(chunk);samples+=chunk.length
   if(voicedNow){voiced+=chunk.length;silent=0;stateTo('recording')}else silent+=chunk.length
   if(silent>rate*.9||samples>=rate*15)upload()
  }
  const play=async()=>{if(closing)return;try{if(duplex)await duplex.play();else if(audio)await audio.play();else return;if(active)setPlayBlocked(false)}catch{if(active)setPlayBlocked(true)}}
  const mediaEvent=(event:DuplexClientEvent)=>{
   if(!active||closing)return
   if(event.type==='phase'){realtimePhase=event.phase;stateTo(localMuted?'muted':event.phase)}
   else if(event.type==='transcript')setLastText(event.text)
   else if(event.type==='play-blocked')setPlayBlocked(true)
   else if(event.type==='error')void fail(copy(event.reason==='microphone-denied'?'denied':event.reason==='provider-unconfigured'?'missing':'failed'))
   else if(event.type==='closed')void finish().catch(()=>{if(active){setState('closeFailed');setError(copy('closeFailed'))}})
  }
  const prepareMedia=async(snapshot:VoiceMediaSnapshot)=>{
   const kind=snapshot.realtime?'realtime':'legacy'
   if(mediaKind){if(mediaKind!==kind)throw Error('媒体类型已变化。');return}
   if(!bound||closing)return
   mediaKind=kind
   // 只有宿主回包确定媒体类型后才取得麦克风；实时和旧媒体不会并行采集。
   if(snapshot.realtime)duplex=await openDuplexVoice({url:snapshot.realtime.path,...bound,onEvent:mediaEvent,signal:mediaAbort.signal})
   else mic=await openVoiceMicrophone(samplesReceived,{signal:mediaAbort.signal})
   if(!active||closing){await stopLocal();return}
   if(duplex&&!startTime.current)startTime.current=Date.now()
  }
  const poll=async()=>{
   if(polled||!active||closing)return
   polled=true
   try{
    call=await api.read(requestId);if(!active||closing)return
    if(call){
     const identity={callId:call.id,callGeneration:call.callGeneration},snapshot=await api.media(identity)
     if(!active||closing)return
     if(!snapshot){if(call.state!=='connecting')await fail(copy('failed'));return}
     if(!bound)bound={...identity,token:snapshot.token}
     else if(bound.callId!==identity.callId||bound.callGeneration!==identity.callGeneration||bound.token!==snapshot.token)throw Error('媒体绑定已变化。')
     if(snapshot.closing||call.state==='ended'||call.state==='failed'){
      const failure=call.failure;await finish();if(active&&failure)setError(copy(failure==='media-close-failed'?'closeFailed':'failed'));return
     }
     await prepareMedia(snapshot);if(!active||closing)return
     if(mediaKind==='legacy'&&call.state==='connecting'&&mic?.isLive())await api.ready(bound)
     if(call.state==='connected'){
      if(mediaKind==='realtime'){if(!duplex)throw Error('实时媒体尚未连接。');return}
      if(!mic?.isLive()){await fail(copy('failed'));return}
      if(!startTime.current){startTime.current=Date.now();stateTo('listening')}
      if(turnCommit&&!snapshot.speech&&!audio){
       const turn=await api.turn({callId:call.id,commitId:turnCommit})
       if(!active||closing)return
       if(turn.state==='active'||turn.state==='ended'&&turn.reason==='completed')setError(undefined)
       if(turn.state==='ended'&&(!turn.replyExpected||['suppressed','unknown'].includes(turn.speech))){waiting=false;turnCommit=undefined;stateTo(localMuted?'muted':'listening');if(turn.reason!=='completed')setError(copy('failed'))}
      }
      if(audio&&playingGeneration!==snapshot.playbackGeneration){stopAudio();waiting=false;stateTo(localMuted?'muted':'listening')}
      if(snapshot.speech&&snapshot.speech.playbackGeneration!==playingGeneration){
       stopAudio();waiting=true;playingGeneration=snapshot.speech.playbackGeneration
       const binding=bound,generation=playingGeneration,binary=atob(snapshot.speech.audio),bytes=Uint8Array.from(binary,value=>value.charCodeAt(0))
       audioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/mpeg'}));audio=new Audio(audioUrl)
       audio.onplaying=()=>{setError(undefined);stateTo('speaking');void api.playback({...binding,playbackGeneration:generation,state:'playing'}).catch(()=>{void fail(copy('failed'))})}
       audio.onended=()=>{void api.playback({...binding,playbackGeneration:generation,state:'idle'}).catch(()=>{});waiting=false;stateTo(localMuted?'muted':'listening')}
       audio.onerror=()=>{void fail(copy('failed'))}
       await play()
      }
     }
    }
   }catch(error){if(active&&!closing)await fail(copy(error instanceof DOMException&&error.name==='NotAllowedError'?'denied':'failed'))}
   finally{polled=false;if(active&&!closing)timer=setTimeout(()=>{void poll()},650)}
  }
  controls.current={sessionId,hangup:async()=>{await finish()},send:()=>{if(duplex)duplex.commit();else upload()},play,async mute(){
   if(!call||!bound||closing)return
   const next=!localMuted;resetCapture()
   const local=async(value:boolean)=>{if(duplex)await duplex.setMuted(value);else mic?.setMuted(value);localMuted=value;setMuted(value);stateTo(value?'muted':duplex?realtimePhase:waiting?'thinking':'listening')}
   try{if(next)await local(true);await api.muted({callId:call.id,callGeneration:call.callGeneration,muted:next});if(!next)await local(false)}catch{if(active&&!closing)setError(copy('failed'))}
  },async interrupt(){
   if(!call||closing)return
   stopAudio();resetCapture();waiting=false
   try{if(duplex)duplex.interrupt();else call=await api.interrupt(call.id);stateTo(localMuted?'muted':'listening')}catch{await fail(copy('failed'))}
  }}
  void (async()=>{
   try{
    stateTo('connecting');const readiness=await api.readiness();if(!active||closing)return
    if(readiness.status!=='ready'){await fail(copy('missing'));return}
    // 先预约本人原会话；poll 读取媒体契约后才打开唯一采集端。
    void api.start(target.kind==='assistant'?{requestId,target:'assistant',expectedContextVersion:target.contextVersion,sessionId}:{requestId,roleId:target.id,expectedRoleVersion:target.version,sessionId}).catch(()=>{if(active&&!closing)void fail(copy('failed'))})
    void poll()
   }catch(error){await fail(copy(error instanceof DOMException&&error.name==='NotAllowedError'?'denied':'failed'))}
  })()
  const endHidden=()=>{void finish().catch(()=>{if(active){setState('closeFailed');setError(copy('closeFailed'))}})}
  const pageShown=()=>{if(closing)endHidden()}
  window.addEventListener('pagehide',endHidden);window.addEventListener('pageshow',pageShown)
  return ()=>{window.removeEventListener('pagehide',endHidden);window.removeEventListener('pageshow',pageShown);active=false;void finish().catch(()=>{})}
 },[initialSession,api,target])
 const panel=<section ref={panelRef} className={[css.panel,target.kind==='assistant'?css.assistant:''].join(' ')} role="region" aria-label={copy('call')} data-dragging={dragging||undefined} style={position?{left:position.x,top:position.y,right:'auto',bottom:'auto',maxWidth:position.maxWidth,maxHeight:position.maxHeight}:undefined}>
  <header tabIndex={0} aria-label={copy('call')} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={event=>{if(drag.current?.pointerId===event.pointerId)releaseDrag()}} onKeyDown={moveWithKeyboard}><span>{copy('call')}</span>{startTime.current&&<time>{Math.floor(elapsed/60).toString().padStart(2,'0')}:{(elapsed%60).toString().padStart(2,'0')}</time>}</header>
  <div className={css.avatar} data-state={state} aria-hidden="true">{target.kind==='assistant'?<img src={assistantAvatar} alt=""/>:target.roleKind==='twin'?<TwinAvatar initials={target.initials??''}/>:<EmployeeAvatar avatarKey={target.avatarKey} size="lg"/>}</div>
  <strong className={css.name}>{target.name}</strong>
  <p className={css.status} role="status"><span data-state={state}/>{copy(state)}</p>
  {lastText&&<p className={css.transcript}>{lastText}</p>}
  {error&&<p className={css.error} role="alert">{error}</p>}
  <div className={css.actions}>
   <button type="button" disabled={!initialSession} onClick={()=>{if(initialSession)openConversation(initialSession)}} title={copy('conversation')} aria-label={copy('conversation')}><MessageCircle size={18}/></button>
   {state!=='ended'&&<><button type="button" disabled={!controls.current||state==='connecting'||state==='preparing'||state==='closeFailed'} aria-pressed={muted} onClick={()=>{void controls.current?.mute()}} title={copy(muted?'unmute':'mute')} aria-label={copy(muted?'unmute':'mute')}>{muted?<MicOff size={18}/>:<Mic size={18}/>}</button>
   <button type="button" disabled={!controls.current||state==='connecting'||state==='preparing'||state==='closeFailed'} onClick={()=>{if(state==='recording')controls.current?.send();else void controls.current?.interrupt()}} title={copy(state==='recording'?'send':'interrupt')} aria-label={copy(state==='recording'?'send':'interrupt')}>{state==='recording'?<Square size={15}/>:<Volume2 size={18}/>}</button></>}
   {playBlocked&&<button type="button" onClick={()=>{void controls.current?.play()}}>{copy('play')}</button>}
   {state==='ended'?<button type="button" onClick={dismiss} aria-label={copy('dismiss')} title={copy('dismiss')}><X size={18}/></button>:<button type="button" className={css.hangup} onClick={()=>{if(controls.current)void controls.current.hangup().catch(()=>{setState('closeFailed');setError(copy('closeFailed'))});else dismiss()}} title={copy('hangup')} aria-label={copy('hangup')}><PhoneOff size={18}/></button>}
  </div>
 </section>
 return surface?createPortal(panel,surface):panel
}
