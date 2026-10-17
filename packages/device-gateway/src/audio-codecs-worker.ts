import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import OpusScript from 'opusscript'
import { MPEGDecoder } from 'mpg123-decoder'
const { create: createResampler } = createRequire(import.meta.url)('@alexanderolsen/libsamplerate-js') as typeof import('@alexanderolsen/libsamplerate-js')

const port = parentPort!
type Input = { type: 'input'; done?: boolean; bytes?: Uint8Array }
let receive: ((input: Input) => void) | undefined

async function* source(): AsyncGenerator<Uint8Array> {
 while (true) {
  const input = await new Promise<Input>(resolve => { receive = resolve; port.postMessage({ type: 'input' }) })
  if (input.done) return
  yield input.bytes!
 }
}

/** 严格保留 MPEG 帧边界，跨回调帧头与分段 ID3 不会导致采样率混用。 */
async function* mpegFrames(): AsyncGenerator<Uint8Array | null> {
 const input = source()
 let buffer: Uint8Array = new Uint8Array(), offset = 0, ended = false
 const read = async (size: number, allowEnd = false): Promise<Uint8Array | undefined> => {
  const output = new Uint8Array(size)
  let written = 0
  while (written < size) {
   if (offset === buffer.length) {
    if (ended) { if (written === 0 && allowEnd) return; throw new Error('MP3 媒体帧不完整。') }
    const next = await input.next()
    if (next.done) { ended = true; continue }
    buffer = next.value; offset = 0
   }
   const count = Math.min(size - written, buffer.length - offset)
   output.set(buffer.subarray(offset, offset + count), written)
   offset += count; written += count
  }
  return output
 }
 const skip = async (size: number) => { while (size > 0) { const count = Math.min(size, 4096); await read(count); size -= count } }
 while (true) {
  const head = await read(4, true)
  if (!head) return
  if (head[0] === 73 && head[1] === 68 && head[2] === 51) {
   const rest = (await read(6))!
   if (![2, 3, 4].includes(head[3]!) || rest.subarray(2).some(value => value > 127)) throw new Error('MP3 元数据不兼容。')
   const size = rest[2]! * 2097152 + rest[3]! * 16384 + rest[4]! * 128 + rest[5]!
   await skip(size + ((rest[1]! & 16) && head[3] === 4 ? 10 : 0))
   yield null
   continue
  }
  if (head[0] === 84 && head[1] === 65 && head[2] === 71) { await skip(124); yield null; continue }
  const version = (head[1]! >> 3) & 3, layer = (head[1]! >> 1) & 3
  const bitrateIndex = head[2]! >> 4, rateIndex = (head[2]! >> 2) & 3
  if (head[0] !== 255 || (head[1]! & 224) !== 224 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) throw new Error('MP3 媒体帧无效或不兼容。')
  const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]!
  const rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((head[2]! >> 1) & 1)
  const frame = new Uint8Array(length)
  frame.set(head); frame.set((await read(length - 4))!, 4)
  yield frame
 }
}

async function* transcode(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
 const decoder = new MPEGDecoder({ enableGapless: false })
 let encoder: OpusScript | undefined
 let resampler: Awaited<ReturnType<typeof createResampler>> | undefined
 let rate = 0, inputSamples = 0, outputSamples = 0, seconds = 0, decodedAny = false
 let pcm = Buffer.alloc(2880), fill = 0
 const encode = function* (samples: Float32Array): Generator<Uint8Array<ArrayBuffer>> {
  for (const value of samples) {
   if (!Number.isFinite(value)) throw new Error('MP3 解码返回了无效样本。')
   pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)), fill * 2)
   if (++fill === 1440) {
    yield Uint8Array.from(encoder!.encode(pcm, 1440))
    fill = 0; pcm.fill(0)
   }
  }
 }
 const flush = function* (): Generator<Uint8Array<ArrayBuffer>> {
  if (!resampler) return
  const remaining = Math.round(inputSamples * 24000 / rate) - outputSamples
  if (remaining > 0) {
   // full API 无 EOF 参数；有界静音只排出滤波器已缓存的真实句尾，不扩大音频时长。
   const tail = resampler.full(new Float32Array(4096))
   if (tail.length < remaining) throw new Error('音频重采样尾部未完整输出。')
   yield* encode(tail.subarray(0, remaining))
  }
  resampler.destroy(); resampler = undefined
 }
 try {
  await decoder.ready
  encoder = new OpusScript(24000, 1, OpusScript.Application.AUDIO)
  for await (const frame of mpegFrames()) {
   if (frame === null) {
    yield* flush()
    if (decodedAny) await decoder.reset()
    rate = 0
    continue
   }
   const audio = decoder.decodeFrame(frame)
   if (audio.errors.length) throw new Error('MP3 媒体解码失败。')
   if (!audio.samplesDecoded) continue
   if (!audio.sampleRate || audio.channelData.length < 1 || audio.channelData.some(channel => channel.length !== audio.samplesDecoded)) throw new Error('MP3 解码格式无效。')
   seconds += audio.samplesDecoded / audio.sampleRate
   if (seconds > 120) throw new Error('单句 MP3 解码时长超过 120 秒。')
   decodedAny = true
   if (rate !== audio.sampleRate) {
    yield* flush()
    rate = audio.sampleRate; inputSamples = 0; outputSamples = 0
    if (rate !== 24000) resampler = await createResampler(1, rate, 24000)
   }
   const mono = new Float32Array(audio.samplesDecoded)
   for (const channel of audio.channelData) for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + channel[i]! / audio.channelData.length
   inputSamples += mono.length
   const samples = resampler ? resampler.full(mono) : mono
   outputSamples += samples.length
   yield* encode(samples)
  }
  if (!decodedAny) throw new Error('语音合成没有返回可解码的 MP3 音频。')
  yield* flush()
  // 仅下行编码尾包补零，最多 1439 样本；此路径从不用于上行 ASR。
  if (fill) yield Uint8Array.from(encoder.encode(pcm, 1440))
 } finally {
  resampler?.destroy()
  encoder?.delete()
  await decoder.ready
  decoder.free()
 }
}

const output = transcode()
let pulling = false
port.on('message', (message: Input | { type: 'pull' }) => {
 if (message.type === 'input') { const resolve = receive; receive = undefined; resolve?.(message); return }
 if (pulling) return
 pulling = true
 void output.next().then(result => {
  if (result.done) port.postMessage({ type: 'done' })
  else port.postMessage({ type: 'packet', packet: result.value }, [result.value.buffer])
 }).catch((error: unknown) => port.postMessage({ type: 'error', message: error instanceof Error ? error.message : '音频转码失败。' }))
 .finally(() => { pulling = false })
})
