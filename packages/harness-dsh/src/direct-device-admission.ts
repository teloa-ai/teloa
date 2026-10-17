import type {TranscriptCommit} from '@teloa/contract'
import type {NativeVoiceInputAdmissions} from './native-voice-input-admission.ts'
import type {NativeHardwareInputAdmissions} from './native-hardware-input-admission.ts'

/** 同一发布链同时证明可信语音封口与受限硬件来源；任一最终守卫失效即拒绝。 */
export function admitDirectDeviceInput<T>(provider:{voice:NativeVoiceInputAdmissions;hardware:NativeHardwareInputAdmissions},commit:TranscriptCommit,assertCurrent:()=>void,dispatch:()=>Promise<T>):Promise<T>{
 return provider.hardware.withPrompt({requestId:commit.id,sessionId:commit.sessionId,text:commit.text},assertCurrent,()=>provider.voice.withPrompt(commit,assertCurrent,dispatch))
}
