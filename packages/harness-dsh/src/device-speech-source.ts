import type {VoiceSpeech} from './voice-service.ts'

/** 一个待消费块；供应商 await 回调直接继承 DAC 窗口的背压。return 同时取消真实 TTS。 */
export async function* deviceSpeechSource(speech:VoiceSpeech,text:string,signal:AbortSignal):AsyncGenerator<Uint8Array>{
 const controller=new AbortController(),linked=AbortSignal.any([signal,controller.signal])
 let slot:Uint8Array|undefined,consumed:(()=>void)|undefined,wake:(()=>void)|undefined,done=false,failure:unknown,total=0
 const notify=()=>{wake?.();wake=undefined}
 const aborted=()=>{consumed?.();notify()};linked.addEventListener('abort',aborted,{once:true})
 const pending=speech.speak(text,linked,async bytes=>{
  linked.throwIfAborted();total+=bytes.length;if(total>8*1024*1024)throw new Error('设备播报超出限制。')
  for(let offset=0;offset<bytes.length;offset+=16384){
   slot=Uint8Array.from(bytes.subarray(offset,offset+16384))
   const wait=new Promise<void>(resolve=>{consumed=resolve});notify();await wait;linked.throwIfAborted()
  }
 }).catch(error=>{failure=error}).finally(()=>{done=true;notify()})
 try{
  while(true){
   linked.throwIfAborted()
   if(slot){const value=slot;slot=undefined;yield value;consumed?.();consumed=undefined;continue}
   if(done){if(failure)throw failure;break}
   await new Promise<void>(resolve=>{wake=resolve})
  }
 }finally{controller.abort();linked.removeEventListener('abort',aborted);consumed?.();void pending}
}
