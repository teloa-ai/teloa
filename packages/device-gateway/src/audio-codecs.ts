import { Worker } from 'node:worker_threads'
import OpusScript from 'opusscript'

const invalidOpus = () => new Error('设备音频必须是单声道、60 ms 的有效 Opus 包。')

/** 上行只接收完整的 16 kHz/mono/60 ms 包，媒体损坏后不恢复解码状态。 */
export function createOpusDecoder(): { decode(packet: Uint8Array): Int16Array; close(): void } {
 const opus = new OpusScript(16000, 1, OpusScript.Application.VOIP)
 let closed = false
 const close = () => { if (!closed) { closed = true; opus.delete() } }
 return {
  close,
  decode(packet) {
   try {
    if (closed || !(packet instanceof Uint8Array) || packet.length < 1 || packet.length > 4096) throw invalidOpus()
    const toc = packet[0]!, config = toc >> 3, code = toc & 3
    const frameMs = config >= 16 ? 2.5 * (1 << (config & 3)) : config >= 12 ? 10 * (1 << (config & 1)) : [10, 20, 40, 60][config & 3]!
    const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 63 : 2
    if ((toc & 4) !== 0 || count * frameMs !== 60) throw invalidOpus()
    const decoded = opus.decode(Buffer.from(packet))
    if (decoded.byteLength !== 1920) throw invalidOpus()
    const pcm = new Int16Array(960)
    for (let i = 0; i < pcm.length; i++) pcm[i] = decoded.readInt16LE(i * 2)
    return pcm
   } catch {
    close()
    throw invalidOpus()
   }
  },
 }
}

type WorkerReply = { type: 'input' } | { type: 'packet'; packet: Uint8Array } | { type: 'done' } | { type: 'error'; message: string }
type Output = Extract<WorkerReply, { type: 'packet' | 'done' }>

/** 每次消费才拉取一个 60 ms 包；所有 MPEG 解码、混音、重采样和编码都在独立 worker。 */
export async function* transcodeSpeechMp3(source: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
 signal.throwIfAborted()
 const iterator = source[Symbol.asyncIterator]()
 const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './audio-codecs-worker.ts' : './audio-codecs-worker.js', import.meta.url))
 let closed = false, inputBytes = 0, offset = 0
 let buffered: Uint8Array = new Uint8Array()
 let failure: unknown
 let stopping: Promise<number> | undefined
 let pending: { resolve(value: Output): void; reject(error: unknown): void } | undefined
 const stop = () => {
  if (!closed) {
   closed = true
   // 合成源的 return 可能等待尚未返回的网络读取，不能让它阻塞 worker 取消。
   try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* 保留原媒体错误。 */ }
   stopping = worker.terminate()
  }
  return stopping
 }
 const fail = (error: unknown) => {
  if (closed) return
  failure = error
  pending?.reject(error)
  pending = undefined
  void stop()?.catch(() => {})
 }
 const abort = () => fail(signal.reason)
 signal.addEventListener('abort', abort, { once: true })
 worker.on('error', fail)
 worker.on('exit', () => { if (!closed) fail(new Error('音频转码线程意外停止。')) })
 worker.on('message', (reply: WorkerReply) => {
  if (closed) return
  if (reply.type === 'error') { fail(new Error(reply.message)); return }
  if (reply.type !== 'input') { pending?.resolve(reply); pending = undefined; return }
  void (async () => {
   while (offset === buffered.length) {
    let next: IteratorResult<Uint8Array>
    try { next = await iterator.next() } catch { throw new Error('语音合成媒体读取失败。') }
    if (closed) return
    if (next.done) { worker.postMessage({ type: 'input', done: true }); return }
    if (!(next.value instanceof Uint8Array)) throw new Error('语音合成返回了无效的 MP3 数据。')
    inputBytes += next.value.byteLength
    if (inputBytes > 8 * 1024 * 1024) throw new Error('单句 MP3 编码输入超过 8 MiB。')
    buffered = next.value
    offset = 0
   }
   // Buffer.slice 仍可能引用不可转移的池，显式复制为独占的 ArrayBuffer。
   const bytes = Uint8Array.from(buffered.subarray(offset, offset + 4096))
   offset += bytes.length
   if (!closed) worker.postMessage({ type: 'input', bytes }, [bytes.buffer])
  })().catch(fail)
 })
 try {
  while (true) {
   signal.throwIfAborted()
   if (failure) throw failure
   const result = await new Promise<Output>((resolve, reject) => {
    pending = { resolve, reject }
    worker.postMessage({ type: 'pull' })
   })
   if (result.type === 'done') return
   yield result.packet
  }
 } finally {
  signal.removeEventListener('abort', abort)
  await stop()
 }
}
