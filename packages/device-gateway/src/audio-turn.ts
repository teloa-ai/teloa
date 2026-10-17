export interface SealedPcmTurn {
  captureId: string
  reason: 'silence' | 'manual' | 'limit'
  wav: Buffer
  durationMs: number
  speechDurationMs: number
  segmented: boolean
  message?: string
}

export interface DiscardedPcmTurn {
  captureId: string
  reason: 'no-speech' | 'too-short' | 'aborted'
}

export type PcmTurnState = 'listening' | 'speaking' | 'sealed' | 'discarded' | 'aborted'

export function createPcmTurn(options: {captureId: string; now?: () => number; onSealed: (turn: SealedPcmTurn) => void; onDiscard: (turn: DiscardedPcmTurn) => void}) {
  if (!options.captureId) throw new Error('captureId is required')
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  // 16kHz：128/256/320/192/960ms，整轮最多15秒。
  const pcm = new Int16Array(240000)
  let state: PcmTurnState = 'listening'
  let length = 0
  let onsetSamples = 0
  let speechSamples = 0
  let silenceSamples = 0
  let lastSpeechEnd = 0

  function active() {return state === 'listening' || state === 'speaking'}
  function clear() {pcm.fill(0); length = 0}
  function discard(reason: DiscardedPcmTurn['reason']) {
    if (!active()) return
    state = reason === 'aborted' ? 'aborted' : 'discarded'
    clear()
    options.onDiscard({captureId: options.captureId, reason})
  }
  function seal(reason: SealedPcmTurn['reason']) {
    if (!active()) return
    if (speechSamples < 4096) {discard(state === 'speaking' ? 'too-short' : 'no-speech'); return}
    const kept = Math.min(length, lastSpeechEnd + 3072)
    const wav = Buffer.alloc(44 + kept * 2)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + kept * 2, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24)
    wav.writeUInt32LE(32000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(kept * 2, 40)
    for (let index = 0; index < kept; index++) wav.writeInt16LE(pcm[index]!, 44 + index * 2)
    state = 'sealed'
    const result: SealedPcmTurn = {captureId: options.captureId, reason, wav, durationMs: kept / 16, speechDurationMs: speechSamples / 16, segmented: reason === 'limit'}
    if (reason === 'limit') result.message = '本句达到15秒，已分段，可继续下一句。'
    clear()
    options.onSealed(result)
  }
  function poll() {
    if (state === 'listening' && now() - startedAt >= 8000) discard('no-speech')
  }
  function push(input: Int16Array, probability: number) {
    if (!active()) return
    if (!(input instanceof Int16Array) || input.length < 1 || input.length > 512) throw new Error('PCM window must contain 1..512 Int16 samples')
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid VAD probability')
    poll()
    if (!active()) return
    const accepted = Math.min(input.length, pcm.length - length)
    pcm.set(input.subarray(0, accepted), length)
    length += accepted
    if (state === 'listening') {
      onsetSamples = probability >= .6 ? onsetSamples + accepted : 0
      // 未确认起音时只保留前缓冲和本次连续候选，不保留整段等待音频。
      const retained = 5120 + onsetSamples
      if (length > retained) {
        pcm.copyWithin(0, length - retained, length)
        pcm.fill(0, retained, length)
        length = retained
      }
      if (onsetSamples >= 2048) {
        state = 'speaking'
        speechSamples = onsetSamples
        lastSpeechEnd = length
      }
    } else if (probability >= .35) {
      speechSamples += accepted
      silenceSamples = 0
      lastSpeechEnd = length
    } else {
      silenceSamples += accepted
      if (silenceSamples >= 15360) {seal('silence'); return}
    }
    if (length === pcm.length) seal('limit')
  }
  return {get state() {return state}, push, poll, stop() {seal('manual')}, abort() {discard('aborted')}}
}

/** 调用方串行等待push；断线使用reset，只有明确stop才flush。 */
export function createPcmWindowAdapter(options: {predict: (pcm: Int16Array) => Promise<number>; onWindow: (pcm: Int16Array, probability: number) => void}) {
  let remainder = new Int16Array(0)
  let busy = false
  let generation = 0
  async function process(input: Int16Array, flush: boolean) {
    if (busy) throw new Error('PCM adapter is busy; apply receive backpressure')
    if (!(input instanceof Int16Array) || input.length > 16000) throw new Error('PCM input must contain at most 16000 samples')
    busy = true
    const currentGeneration = generation
    const combined = new Int16Array(remainder.length + input.length)
    combined.set(remainder)
    combined.set(input, remainder.length)
    remainder = new Int16Array(0)
    let offset = 0
    try {
      while (combined.length - offset >= 512 || (flush && offset < combined.length)) {
        if (generation !== currentGeneration) return
        const original = combined.slice(offset, offset + 512)
        const window = new Int16Array(512)
        window.set(original)
        const probability = await options.predict(window)
        if (generation !== currentGeneration) return
        options.onWindow(original, probability)
        offset += original.length
      }
      if (generation === currentGeneration) remainder = combined.slice(offset)
    } finally {busy = false}
  }
  return {
    push(input: Int16Array) {return process(input, false)},
    flush() {return process(new Int16Array(0), true)},
    reset() {generation++; remainder.fill(0); remainder = new Int16Array(0)},
  }
}
