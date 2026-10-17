import {access} from 'node:fs/promises'
import {join} from 'node:path'
import {createSileroVad} from '@teloa/device-gateway/vad'
import type {VoiceActivityDetector} from './voice-plugin.ts'

/** 复用官方 SenseVoice 的固定模型文件，不复制权重、不自动下载或改动默认识别器。 */
export async function openLocalVoiceVad(dshHome:string):Promise<VoiceActivityDetector|null>{
 const path=join(dshHome,'speech-to-text/sensevoice/models/silero/silero_vad.onnx')
 try{await access(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
 return createSileroVad(path)
}
