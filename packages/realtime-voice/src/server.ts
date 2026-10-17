import {createHash, randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import WebSocket from 'ws'
import {WorkError, readVoiceTranscriptSeal, type VoiceTranscriptSeal} from '@teloa/contract'
import type {TeloaVoicePluginPort, VoiceMediaAdapter, VoiceTransportConnectInput, VoiceConnection,VoiceStageTiming,VoicePcmSession,VoiceActivityDetector} from '@teloa/harness-dsh/voice-plugin'
import {createPcmTurns, encodePcmWav} from './pcm-turns.ts'
import {createNeuralPcmTurns} from './neural-pcm-turns.ts'
import {speechSegments} from './speech-segments.ts'
import {prepareSpeechPrefix} from './prepared-speech.ts'

export const realtimeVoicePath = '/teloa-voice/stream'
export const realtimeVoiceProtocol = 'teloa.voice.pcm.v1'

type Channel = {
  input: VoiceTransportConnectInput
  token: string
  claimed: boolean
  socket?: WebSocket
  closed: boolean
  closing: boolean
  muted: boolean
  generation: number
  turnGeneration?: number
  latestTurnId?: string
  lastSeen: number
  abort: AbortController
  speech?: AbortController
  pcm?:Promise<VoicePcmSession|null>
  pcmReady?:VoicePcmSession
  pcmRetryAt?:number
  recognitionPreview?:{hash:string;started:number;completed?:number;signal:AbortSignal;result:ReturnType<TeloaVoicePluginPort['speech']['transcribe']>}
  recognitionPreparing?:Promise<unknown>
  prepared?:{utteranceId:string;text:string;generation:number;signature:Promise<string|undefined>;audio:ReturnType<typeof prepareSpeechPrefix>}
  removeAbort?: () => void
  closingPromise?: Promise<void>
  turns: ReturnType<typeof createPcmTurns>|ReturnType<typeof createNeuralPcmTurns>
  vad?:VoiceActivityDetector
  captureEpoch:number
  captureAbort:AbortController
  capturePending:Promise<void>
  captureBytes:number
  readyResolve: () => void
  readyReject: (error: unknown) => void
  closeResolve: () => void
  closePromise: Promise<void>
  pending: Promise<void>
  queued: number
}

const invalid = () => new WorkError('teloa/invalid-input', '实时语音媒体请求不正确。')
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value)
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw invalid()
  return row
}

/** 仅接受经过官方本人浏览器认证的 socket；认证由插件注册入口执行。 */
export function createRealtimeVoiceMedia(ports: TeloaVoicePluginPort) {
  const channels = new Map<string, Channel>()
  const seals = new Map<string, VoiceTranscriptSeal>()
  const sockets = new Set<WebSocket>()
  let disposed = false

  const send = (channel: Channel, value: Record<string, unknown>) => {
    if (channel.socket?.readyState === WebSocket.OPEN) channel.socket.send(JSON.stringify(value))
  }
  const live = (channel: Channel) => {
    if (disposed || channel.closed || channel.closing || channel.abort.signal.aborted || channel.input.signal.aborted) throw ports.failure('connection-lost')
  }
  const listening = (channel: Channel) => send(channel, {type: 'phase', phase: channel.turns.active ? 'recording' : 'listening'})
  const prepareRecognition=(channel:Channel,pcm:Uint8Array|null)=>{
    // 续说只撤销候选资格。SenseVoice 取消推理会销毁常驻 worker，下一句因此冷启动。
    // 最多保留一个本机预识别在途；静音、挂断仍由原采集/通话信号立即取消。
    delete channel.recognitionPreview
    if(!pcm||!ports.speech.prepareRecognition||channel.recognitionPreparing||channel.muted||channel.closing||channel.closed)return
    const audio=encodePcmWav(pcm),signal=AbortSignal.any([channel.abort.signal,channel.captureAbort.signal])
    const preview:NonNullable<Channel['recognitionPreview']>={hash:createHash('sha256').update(audio).digest('hex'),started:Date.now(),signal,result:Promise.resolve(null)}
    const pending=ports.speech.prepareRecognition(audio,'wav',signal).then(result=>{preview.completed=Date.now();return result},()=>null)
    preview.result=pending.finally(()=>{if(channel.recognitionPreparing===pending)delete channel.recognitionPreparing})
    channel.recognitionPreparing=pending
    channel.recognitionPreview=preview
  }
  const warmPcm=(channel:Channel)=>{
    if(!ports.openPcmSession||channel.pcm||channel.closing||channel.closed||disposed||Date.now()<(channel.pcmRetryAt??0))return
    channel.pcmRetryAt=Date.now()+10000
    const pending=Promise.resolve().then(()=>ports.openPcmSession!(channel.abort.signal)).then(async session=>{
      if(channel.pcm!==pending||channel.closing||channel.closed||channel.abort.signal.aborted){await session?.close();return null}
      if(session){channel.pcmReady=session;channel.pcmRetryAt=0}
      else delete channel.pcm
      return session
    }).catch(()=>{if(channel.pcm===pending)delete channel.pcm;return null})
    channel.pcm=pending
  }
  const closePcm=(channel:Channel)=>{
    channel.prepared?.audio.discard();delete channel.prepared
    const pending=channel.pcm
    delete channel.pcm;delete channel.pcmReady
    void pending?.then(session=>session?.close()).catch(()=>{})
  }
  const cancelPcm=async(channel:Channel,session:VoicePcmSession)=>{
    const pending=channel.pcm
    if(channel.pcmReady===session)delete channel.pcmReady
    try{await session.cancel();if(channel.pcm===pending&&!channel.closing&&!channel.closed)channel.pcmReady=session}
    catch{if(channel.pcm===pending){closePcm(channel);warmPcm(channel)}}
  }
  const timing = (channel:Channel,stage:VoiceStageTiming['stage'],identity:Pick<VoiceStageTiming,'turnId'|'requestId'>,at=Date.now()) => {
    try{ports.recordTiming?.({callId:channel.input.callId,callGeneration:channel.input.callGeneration,stage,at,...identity})}catch{/* 内部诊断不能打断媒体。 */}
  }
  const acknowledgeClosed = (channel: Channel) => {
    if (channel.closed) return
    channel.closed = true
    channel.closing = true
    channel.removeAbort?.()
    delete channel.removeAbort
    channel.abort.abort()
    channel.speech?.abort()
    closePcm(channel)
    channel.turns.reset()
    void channel.vad?.close().catch(()=>{})
    delete channel.turnGeneration
    channel.readyReject(ports.failure('connection-lost'))
    channel.closeResolve()
    for (const [receipt, seal] of seals) if (seal.callId === channel.input.callId) seals.delete(receipt)
  }
  const close = (channel: Channel): Promise<void> => {
    if (channel.closed) return Promise.resolve()
    if (channel.closingPromise) return channel.closingPromise
    channel.closing = true
    channel.abort.abort()
    channel.speech?.abort()
    closePcm(channel)
    channel.turns.reset()
    channel.readyReject(ports.failure('connection-lost'))
    if (!channel.socket || channel.socket.readyState === WebSocket.CLOSED) {
      acknowledgeClosed(channel)
      return Promise.resolve()
    }
    send(channel, {type: 'close'})
    const pending = (async () => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        channel.socket?.terminate()
        channel.closeResolve()
      }, 2500)
      timer.unref()
      try {
        await channel.closePromise
        if (timedOut) throw ports.failure('media-close-failed')
      } finally {
        clearTimeout(timer)
        delete channel.closingPromise
      }
    })()
    channel.closingPromise = pending
    return pending
  }
  const fail = (channel: Channel, reason: 'connection-lost' | 'provider-unavailable' | 'connection-failed') => {
    if (channel.closing || channel.closed) return
    send(channel, {type: 'error', reason})
    try {
      channel.input.onEvent({type: 'error', callGeneration: channel.input.callGeneration, reason})
    } finally {
      void close(channel).catch(() => {})
    }
  }
  const bound = (input: unknown, extra: readonly string[] = []) => {
    const row = exact(input, ['callId', 'callGeneration', 'token', ...extra])
    const channel = typeof row.callId === 'string' ? channels.get(row.callId) : undefined
    if (!channel || row.callGeneration !== channel.input.callGeneration || row.token !== channel.token) throw invalid()
    return {channel, row}
  }
  const interrupt = (channel: Channel): number => {
    channel.speech?.abort()
    // 原 service 同步推进世代，再由 transport 清播；不取消原会话工作。
    void ports.interrupt(channel.input.callId).catch(() => fail(channel, 'connection-failed'))
    return channel.generation
  }
  const transcribe = (channel: Channel, pcm: Uint8Array, expectedPlaybackGeneration: number) => {
    if (channel.queued >= 3) {
      fail(channel, 'provider-unavailable')
      return
    }
    const turnId=randomUUID(),captureEpoch=channel.captureEpoch;channel.latestTurnId=turnId
    channel.queued++
    // 识别至多三段并行，原会话提交仍串行；后段不必等前段网络往返才上传。
    const audio = encodePcmWav(pcm)
    const audioSha256 = createHash('sha256').update(audio).digest('hex')
    const preview=channel.recognitionPreview
    delete channel.recognitionPreview
    const reusable=preview?.hash===audioSha256&&!preview.signal.aborted?preview:undefined
    const recognition=Promise.resolve().then(async()=>{
      live(channel)
      if(channel.muted||channel.captureEpoch!==captureEpoch)return null
      send(channel, {type: 'phase', phase:channel.turns.active?'recording':'thinking'})
      const prepared=await reusable?.result
      timing(channel,'asr-start',{turnId},prepared?reusable!.started:Date.now())
      const result = prepared??await ports.speech.transcribe(audio, 'wav', AbortSignal.any([channel.abort.signal,channel.captureAbort.signal]))
      timing(channel,'asr-completed',{turnId},prepared?reusable!.completed:Date.now())
      return result
    })
    void recognition.catch(()=>{}) // 先完成的失败也由下方顺序准入统一处理。
    channel.pending = channel.pending.then(async () => {
      // 同包后一句的起音必须先推进世代，不能被一个立即完成的识别回包抢跑。
      await channel.capturePending
      live(channel)
      const result=await recognition
      live(channel)
      if (channel.muted || channel.captureEpoch!==captureEpoch || !result){if(channel.latestTurnId===turnId)listening(channel);return}
      if (result.audioSha256 !== audioSha256) throw ports.failure('provider-unavailable')
      const producerReceipt = randomUUID()
      const seal = readVoiceTranscriptSeal({
        ...channel.input.roleContext,
        callId: channel.input.callId,
        callGeneration: channel.input.callGeneration,
        turnId,
        speaker: 'owner',
        source: {kind: 'sealed-audio-stt', providerId: result.providerId??'minimax', audioSha256, sealReceiptId: randomUUID(), sttReceiptId: result.receiptId},
        revision: 1,
        text: result.text,
        closed: true,
        complete: true,
        producerReceipt,
      })
      seals.set(producerReceipt, seal)
      send(channel, {type: 'transcript', text: seal.text})
      try {
        await ports.acceptTranscript(producerReceipt, expectedPlaybackGeneration)
      } finally {
        seals.delete(producerReceipt)
      }
      live(channel)
    }).catch(() => {
      if (!channel.abort.signal.aborted&&channel.captureEpoch===captureEpoch) fail(channel, 'provider-unavailable')
    }).finally(() => {channel.queued--})
  }
  const drainCompleted = async (channel: Channel, first: Uint8Array | null) => {
    const expected = channel.turnGeneration
    if (first && expected === undefined) throw invalid()
    for (let turn = first; turn; turn = (await channel.turns.push(new Uint8Array())).turn) transcribe(channel, turn, expected!)
    if (!channel.turns.active) delete channel.turnGeneration
  }
  const playback = (channel: Channel, value: unknown, state: unknown) => {
    if (!generation(value) || value !== channel.generation || state !== 'playing' && state !== 'idle') return
    channel.input.onEvent({type: 'playback', callGeneration: channel.input.callGeneration, playbackGeneration: value, state})
    if (state === 'idle') listening(channel)
  }
  const heartbeat = setInterval(() => {
    for (const channel of channels.values()) {
      if (channel.closed || channel.closing) continue
      if (Date.now() - channel.lastSeen > 12000) fail(channel, 'connection-lost')
      else if (channel.socket?.readyState === WebSocket.OPEN) channel.socket.ping()
    }
  }, 4000)
  heartbeat.unref()

  const transport: VoiceMediaAdapter['transport'] = {
    async readiness() {
      const providerId = await ports.providerId()
      return await ports.configured() ? {status: 'ready', providerId} : {status: 'unavailable', providerId, reason: 'provider-unconfigured'}
    },
    async connect(input) {
      if (disposed || input.signal.aborted || channels.has(input.callId)) throw ports.failure('connection-failed')
      let readyResolve!: () => void, readyReject!: (error: unknown) => void, closeResolve!: () => void
      const ready = new Promise<void>((resolve, reject) => {readyResolve = resolve; readyReject = reject})
      const closePromise = new Promise<void>(resolve => {closeResolve = resolve})
      const channel: Channel = {
        input, token: randomUUID(), claimed: false, closed: false, closing: false, muted: false,
        generation: 0, lastSeen: Date.now(), abort: new AbortController(), turns:createPcmTurns(),
        captureEpoch:0,captureAbort:new AbortController(),capturePending:Promise.resolve(),captureBytes:0,
        readyResolve, readyReject, closeResolve, closePromise, pending: Promise.resolve(), queued: 0,
      }
      channels.set(input.callId, channel)
      const preparation=ports.openVad?ports.openVad().then(async vad=>{
        if(!vad)return
        if(disposed||channel.closing||channel.closed||input.signal.aborted){await vad.close();return}
        channel.vad=vad;channel.turns=createNeuralPcmTurns(vad,pcm=>prepareRecognition(channel,pcm))
      }):Promise.resolve()
      channel.capturePending=preparation
      const abort = () => {void close(channel).catch(() => {})}
      const timeout = setTimeout(() => readyReject(ports.failure('connection-failed')), 15000)
      timeout.unref()
      input.signal.addEventListener('abort', abort, {once: true})
      channel.removeAbort = () => input.signal.removeEventListener('abort', abort)
      try {
        await Promise.all([ready,preparation])
        live(channel)
      } catch (error) {
        acknowledgeClosed(channel)
        channel.socket?.terminate()
        if (channels.get(input.callId) === channel) channels.delete(input.callId)
        throw error
      } finally {
        clearTimeout(timeout)
      }
      // 在用户讲话、识别及原模型准备时并行握手；失败仍保留原 HTTP 媒体通路。
      void ports.speech.warm?.(channel.abort.signal).catch(()=>{})
      warmPcm(channel)
      const connection: VoiceConnection = {
        close: () => close(channel),
        async setMuted({muted, callGeneration}) {
          live(channel)
          if (callGeneration !== input.callGeneration) throw invalid()
          channel.muted = muted
          channel.captureEpoch++
          channel.prepared?.audio.discard();delete channel.prepared
          channel.captureAbort.abort();channel.captureAbort=new AbortController()
          channel.turns.reset()
          delete channel.turnGeneration
        },
        async interruptPlayback({playbackGeneration}) {
          live(channel)
          if (!generation(playbackGeneration) || playbackGeneration < channel.generation) throw invalid()
          channel.generation = playbackGeneration
          channel.prepared?.audio.discard();delete channel.prepared
          channel.speech?.abort()
          send(channel, {type: 'clear', generation: playbackGeneration})
          listening(channel)
          // 等取消确认期间，新句走独立 HTTP 流，不排在旧 WS 的取消栅栏后。
          const session=channel.pcmReady
          if(session)await cancelPcm(channel,session)
        },
        prepareSpeech({utteranceId,text,callGeneration,playbackGeneration}){
          live(channel)
          warmPcm(channel)
          if(callGeneration!==input.callGeneration||playbackGeneration!==channel.generation||channel.speech)throw invalid()
          channel.prepared?.audio.discard()
          const session=channel.pcmReady
          const signature=Promise.resolve().then(()=>ports.speech.signature?.())
          const prepared={utteranceId,text,generation:playbackGeneration,signature,audio:prepareSpeechPrefix({text,signal:channel.abort.signal,onDiscard:()=>{if(session&&channel.pcmReady===session&&!channel.closing&&!channel.closed)void cancelPcm(channel,session)},synthesize:async(text,signal,onAudio)=>{
            await signature;signal.throwIfAborted();timing(channel,'tts-prefetch-start',{requestId:utteranceId})
            let first=true
            const receive=(bytes:Uint8Array)=>{if(first){first=false;timing(channel,'tts-prefetch-first-pcm',{requestId:utteranceId})}return onAudio(bytes)}
            if(session)await session.synthesize(text,signal,receive)
            else await ports.speakPcm(text,signal,receive)
          }})}
          channel.prepared=prepared
          return ()=>{prepared.audio.discard();if(channel.prepared===prepared)delete channel.prepared}
        },
        async enqueueSpeech({utteranceId,text, callGeneration, playbackGeneration}) {
          live(channel)
          warmPcm(channel)
          if (callGeneration !== input.callGeneration || !generation(playbackGeneration) || playbackGeneration < channel.generation) throw invalid()
          channel.speech?.abort()
          const control = new AbortController()
          channel.speech = control
          channel.generation = playbackGeneration
          const signal = AbortSignal.any([control.signal, channel.abort.signal, input.signal])
          const draft=channel.prepared
          delete channel.prepared
          let prepared=draft&&draft.utteranceId===utteranceId&&draft.generation===playbackGeneration-1&&text.startsWith(draft.text)?draft:undefined
          if(draft&&!prepared)draft.audio.discard()
          let firstAudioAt: number | undefined, sent = 0, remainder = Buffer.alloc(0)
          const current = () => {
            signal.throwIfAborted()
            live(channel)
            if (channel.generation !== playbackGeneration) throw ports.failure('connection-lost')
          }
          send(channel, {type: 'speech-start', generation: playbackGeneration})
          timing(channel,'tts-start',{requestId:utteranceId})
          try {
            if(prepared&&(await prepared.signature)!==(await ports.speech.signature?.())){prepared.audio.discard();prepared=undefined}
            // 预热只做并行准备，尚未就绪时不能把网络握手等待叠在首句上。
            let session=channel.pcmReady
            current()
            const transmit=async(raw:Uint8Array)=>{
              current()
              const all = remainder.length ? Buffer.concat([remainder, raw]) : Buffer.from(raw)
              const even = all.length - all.length % 2
              remainder = Buffer.from(all.subarray(even))
              if(even&&firstAudioAt===undefined){firstAudioAt=Date.now();timing(channel,'tts-first-pcm',{requestId:utteranceId},firstAudioAt)}
              for (let offset = 0; offset < even; offset += 4096) {
                current()
                // 从首个音频字节开始计时，供应商首包等待不能扩大提前量。
                let ahead = firstAudioAt! + sent / 48 - Date.now() - 1200
                while (ahead > 0) {
                  await delay(Math.min(ahead, 500), undefined, {signal})
                  current()
                  ahead = firstAudioAt! + sent / 48 - Date.now() - 1200
                }
                const part = all.subarray(offset, Math.min(offset + 4096, even))
                const frame = Buffer.allocUnsafe(part.length + 4)
                frame.writeUInt32LE(playbackGeneration, 0)
                part.copy(frame, 4)
                const socket = channel.socket
                if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) throw ports.failure('connection-lost')
                await new Promise<void>((resolve, reject) => socket.send(frame, {binary: true}, error => error ? reject(ports.failure('connection-lost')) : resolve()))
                if(!sent)timing(channel,'audio-first-send',{requestId:utteranceId})
                sent += part.length
              }
            }
            // 持久双向TTS已能连续分句，不再等每个小句的播放背压结束才发送下一句。
            // 候选首句单独采用，后文从其末尾继续；HTTP回退保持原来的按句供给。
            const tail=prepared?text.slice(prepared.text.length):text
            const remaining=speechSegments(tail,session?'continuous':'sentences')
            const segments=prepared?[prepared.text,...remaining]:remaining
            for(const [index,segment] of segments.entries()){
              current()
              if(!segment.trim())continue
              const segmentStart=sent
              try{
                if(prepared&&index===0)await prepared.audio.consume(signal,transmit)
                else if(session)await session.synthesize(segment,signal,transmit)
                else await ports.speakPcm(segment,signal,transmit)
              }catch(error){
                current()
                if(!session&&!(prepared&&index===0))throw error
                closePcm(channel);session=undefined;warmPcm(channel)
                // 仅当前段尚未输出时回退，前文与已输出的半句都不能重播。
                if(sent!==segmentStart)throw error
                remainder=Buffer.alloc(0)
                await ports.speakPcm(segment,signal,transmit)
              }
              if(remainder.length)throw ports.failure('provider-unavailable')
            }
            current()
            if (remainder.length || !sent) throw ports.failure('provider-unavailable')
            send(channel, {type: 'speech-end', generation: playbackGeneration})
          } finally {
            prepared?.audio.discard()
            if (channel.speech === control) delete channel.speech
          }
        },
      }
      return connection
    },
    async closePending(input) {
      const channel = channels.get(input.callId)
      if (channel?.input.callGeneration === input.callGeneration) await close(channel)
    },
  }

  const media: VoiceMediaAdapter = {
    transport,
    conversationState(input){
      const channel=channels.get(input.callId)
      if(!channel||channel.closed||channel.closing||channel.input.callGeneration!==input.callGeneration||channel.generation!==input.playbackGeneration||channel.latestTurnId!==input.turnId)return
      if(input.state==='idle'){if(!channel.speech)listening(channel)}
      else send(channel,{type:'phase',phase:channel.turns.active?'recording':'thinking'})
    },
    snapshot(value) {
      const row = exact(value, ['callId', 'callGeneration'])
      const channel = typeof row.callId === 'string' ? channels.get(row.callId) : undefined
      if (!channel) return null
      if (row.callGeneration !== channel.input.callGeneration) throw invalid()
      return {token: channel.token, closing: channel.closing, muted: channel.muted, playbackGeneration: channel.generation, speech: null, realtime: {path: realtimeVoicePath, protocol: realtimeVoiceProtocol}}
    },
    ready() {throw invalid()},
    closed(value) {
      const {channel} = bound(value)
      acknowledgeClosed(channel)
      channel.socket?.close(1000, 'closed')
    },
    playback(value) {
      const {channel, row} = bound(value, ['playbackGeneration', 'state'])
      live(channel)
      playback(channel, row.playbackGeneration, row.state)
    },
    async transcribe() {throw invalid()},
    async readTranscriptSeal(receipt) {return seals.get(receipt) ?? null},
    inactiveCalls() {
      return [...channels.values()].filter(channel => channel.closed || channel.closing).map(channel => ({callId: channel.input.callId, callGeneration: channel.input.callGeneration}))
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(heartbeat)
      for (const channel of channels.values()) acknowledgeClosed(channel)
      for (const socket of sockets) socket.terminate()
      sockets.clear()
      channels.clear()
      seals.clear()
    },
  }

  const accept = (socket: WebSocket) => {
    if (disposed) {socket.terminate(); return}
    sockets.add(socket)
    let channel: Channel | undefined
    const handshake = setTimeout(() => socket.close(1008, 'voice handshake timeout'), 5000)
    handshake.unref()
    socket.on('pong', () => {if (channel) channel.lastSeen = Date.now()})
    socket.on('message', (data, binary) => {
      try {
        if (!channel) {
          if (binary) throw invalid()
          const row = exact(JSON.parse(data.toString()), ['type', 'callId', 'callGeneration', 'token'])
          if (row.type !== 'hello') throw invalid()
          const candidate = typeof row.callId === 'string' ? channels.get(row.callId) : undefined
          if (!candidate || candidate.claimed || candidate.closing || candidate.closed || candidate.input.signal.aborted || row.callGeneration !== candidate.input.callGeneration || row.token !== candidate.token) throw invalid()
          channel = candidate
          channel.claimed = true
          channel.socket = socket
          channel.lastSeen = Date.now()
          clearTimeout(handshake)
          channel.readyResolve()
          send(channel, {type: 'ready'})
          return
        }
        // 回收确认在 closing 后仍有效；迟到音频不重开采集或阻挡确认。
        if (!binary) {
          const row = object(JSON.parse(data.toString()))
          if (row.type === 'closed') {
            exact(row, ['type'])
            acknowledgeClosed(channel)
            socket.close(1000, 'closed')
            return
          }
          if (channel.closing) return
          live(channel)
          channel.lastSeen = Date.now()
          if (row.type === 'mute') {
            exact(row, ['type', 'muted'])
            if (typeof row.muted !== 'boolean') throw invalid()
            channel.muted = row.muted
            channel.captureEpoch++
            channel.captureAbort.abort();channel.captureAbort=new AbortController()
            channel.turns.reset()
            delete channel.turnGeneration
          } else if (row.type === 'interrupt') {
            exact(row, ['type'])
            interrupt(channel)
          } else if (row.type === 'commit') {
            exact(row, ['type'])
            if (!channel.muted) {
              const held=channel,epoch=held.captureEpoch
              held.capturePending=held.capturePending.then(async()=>{if(held.closing||held.muted||held.captureEpoch!==epoch)return;await drainCompleted(held,await held.turns.flush())}).catch(()=>{if(!held.closing&&held.captureEpoch===epoch)fail(held,'provider-unavailable')})
            }
          } else if (row.type === 'playback') {
            exact(row, ['type', 'generation', 'state'])
            playback(channel, row.generation, row.state)
          } else throw invalid()
          return
        }
        if (channel.closing) return
        live(channel)
        channel.lastSeen = Date.now()
        if (channel.muted) return
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.length > 64 * 1024 || bytes.length % 2) throw invalid()
        const held=channel,epoch=held.captureEpoch
        held.captureBytes+=bytes.length
        if(held.captureBytes>64*1024)throw invalid()
        // 每路串行检测、有界排队；静音/关闭使正在等待的概率及旧转写失效。
        held.capturePending=held.capturePending.then(async()=>{
          for(let offset=0;offset<bytes.length&&!held.closing&&!held.muted&&held.captureEpoch===epoch;offset+=640){
            const result=await held.turns.push(bytes.subarray(offset,offset+640))
            if(held.closing||held.muted||held.captureEpoch!==epoch)return
            if(result.started){held.turnGeneration=interrupt(held);send(held,{type:'phase',phase:'recording'})}
            await drainCompleted(held,result.turn)
          }
        }).catch(()=>{if(!held.closing&&held.captureEpoch===epoch)fail(held,'provider-unavailable')}).finally(()=>{held.captureBytes-=bytes.length})
      } catch {
        socket.close(1008, 'invalid voice message')
        if (channel) fail(channel, 'connection-failed')
      }
    })
    socket.on('close', () => {
      clearTimeout(handshake)
      sockets.delete(socket)
      if (channel) {
        const unexpected = !channel.closing
        acknowledgeClosed(channel)
        if (unexpected) channel.input.onEvent({type: 'disconnected', callGeneration: channel.input.callGeneration})
      }
    })
    socket.on('error', () => {if (channel) fail(channel, 'connection-lost')})
  }
  return Object.freeze({
    media,
    accept,
    async closeAll() {await Promise.allSettled([...channels.keys()].map(callId => ports.end(callId)))},
  })
}
