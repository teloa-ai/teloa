/** 候选音频只在正式回复逐字匹配后放行；首包前置合成，未提交时不播放。 */
export function prepareSpeechPrefix(input:{
 text:string;signal:AbortSignal
 onDiscard?:()=>void
 synthesize:(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>Promise<void>)=>Promise<void>
}){
 const control=new AbortController(),signal=AbortSignal.any([input.signal,control.signal])
 let claimed=false,send:((bytes:Uint8Array)=>Promise<void>)|undefined,release!:()=>void,bytes=0
 const gate=new Promise<void>(resolve=>{release=resolve})
 const aborted=()=>release()
 signal.addEventListener('abort',aborted,{once:true})
 const discard=()=>{if(claimed||control.signal.aborted)return false;control.abort();release();input.onDiscard?.();return true}
 const timer=setTimeout(discard,4000);timer.unref()
 const pending=Promise.resolve().then(()=>{signal.throwIfAborted();return input.synthesize(input.text,signal,async chunk=>{
  bytes+=chunk.byteLength
  if(chunk.byteLength>512*1024||bytes>2*1024*1024)throw Error('候选音频超过上限。')
  const audio=Uint8Array.from(chunk)
  await gate;signal.throwIfAborted()
  if(!send)throw Error('候选音频尚未采用。')
  await send(audio)
 })}).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted)})
 void pending.catch(()=>{})
 return {
  discard,
  async consume(current:AbortSignal,onAudio:(bytes:Uint8Array)=>Promise<void>){
   if(claimed)throw Error('候选音频已采用。')
   claimed=true;clearTimeout(timer)
   const abort=()=>{control.abort();release()}
   current.addEventListener('abort',abort,{once:true})
   if(current.aborted)abort()
   try{current.throwIfAborted();send=onAudio;release();await pending;current.throwIfAborted();if(!bytes)throw Error('候选音频为空。')}
   finally{current.removeEventListener('abort',abort)}
  },
 }
}
