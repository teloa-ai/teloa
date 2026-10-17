import test from 'node:test'
import assert from 'node:assert/strict'

// 本地 ffmpeg/libmp3lame 编码的合成音调与静音，仅用于编解码边界，不代表语音质量。
const stereo44100 = Buffer.from('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', 'base64')
const mono22050 = Buffer.from('SUQzAwAAAAAAI1RTU0UAAAAPAAAATGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA//NAxAAUOHKEH1gIAFJJJaI3G43G43G43G6eMQw7DkO5DlVgZd8zEMgC4imjuRikpLAwfB8Hz8EAQ4Pv5yjz/KO0B/gR2gP8CO4f6Pf0fwfAgIAgCAYB8H3wICHf0EFwAIIIMIGBAAD/80LEChcxHqGXmpgCPszr//0vmU/V9kaqoCKwUDJjgGPDAB1FwjmgHnIkwB8k4s4UEKC/IaOaOaUv8ixFjEul3/ykRYixiXSZMv5YKgqIgr/wVEQVBURHjv/5URBUNFqIAADzCDT/3///80DECRTIei4130gAaCfuUafgsAHDgAMAQDUwGAAbEIFiYIsMeGhjC55hp4PIYRmBFGAlgDhgEwCaYBwAMhgAiFwAJEa/YVM7/s/9v/q/d//////+23bVlAAAFsbELkGa+Wpa+rdlHf/zQsQQEpByOl4PuCxF4qAGjIFxgEBOmE6p8biaYZjBdnXzUZUEZh8DAoGobMFfqiuAtudV3Zqz+j+v7X/+7//V0/93v1bqFYAABE7/efqJuBDbXCyZiQgZSTmlJBw8KYIsCPGG5jP5tf/zQMQhEyB6Igjf+oAWNtHogXmcCUGA44jAYEgJkoBKytEfeXya+5d3///Yjoft3/+7//X//+7+peAAPlNYP/XP5fnX6YEnaSBhkqImQrvAImBhlShnORD4VRSjJsCxMKUEIwSAGz+g//NCxC8TQHYplNewhA1S9S9YXQyo7ovY+uhbV/7/7F+jVm9dv/+pn/u/6/gAABcLkFKB/6/Wql6Vvw2Usm4QwAYYIgLhgkBCGKoJAcgxSJhpgMmCqFKYOYIZgYgOobIOJgS0eDFXpaz///NAxD4TKGpCX14YAN2LXtZ1///f//r6f0/degHJSCQBIJBcLgMBgKAvLhrJtAjAbbgGZcDnnQikHDfA9ZcURopUroc3Uwb8HKDL+hdxPonchgwvqZC4AQL8KgNrjlf3/C7wbqDhDCj/80LETCWbHspfkIACF/xvhv///4cgLYHqCEYsYgmJ4E4CUP///8X4nMQnF8I8FIDGiPxjxlhHg1Bzf////8g5Kk8QQpFUg5MlsghNFQi5FSTIp///0uM1EcQXuRy3fj/1W+ZrTSJFGgb/80DEERQ4Xqo/xggAASJxIloKgqPDRYGj2JQVgqoGjwiPFQVgrBo9wVlYiPKfBWCrhEHFB2CsSuLHp6Jeo9BqJc7Z14K9R7lXcGusNExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqg==', 'base64')
const silence8000 = Buffer.from('SUQzAwAAAAAAI1RTU0UAAAAPAAAATGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64')

const codecs = () => import('../src/audio-codecs.ts')
const opus = async () => (await import('opusscript')).default
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function* chunks(bytes: Uint8Array, size = 17) {
 for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
}
async function collect(source: AsyncIterable<Uint8Array>, signal = new AbortController().signal) {
 const packets: Uint8Array[] = []
 for await (const packet of (await codecs()).transcodeSpeechMp3(source, signal)) packets.push(packet)
 return packets
}
function tone(samples: Int16Array, hz: number) {
 let sine = 0, cosine = 0
 for (let i = 0; i < samples.length; i++) {
  sine += samples[i]! * Math.sin(2 * Math.PI * hz * i / 24000)
  cosine += samples[i]! * Math.cos(2 * Math.PI * hz * i / 24000)
 }
 return Math.hypot(sine, cosine) / samples.length
}

test('真实 Opus 上行往返输出恰好 960 个 Int16 样本，关闭后拒绝继续解码', async () => {
 const Opus = await opus(), encoder = new Opus(16000, 1, Opus.Application.VOIP)
 const decoder = (await codecs()).createOpusDecoder()
 try {
  const pcm = Buffer.alloc(1920)
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2)
  const decoded = decoder.decode(encoder.encode(pcm, 960))
  assert.ok(decoded instanceof Int16Array)
  assert.equal(decoded.length, 960)
  assert.ok(decoded.some(value => Math.abs(value) > 1000))
  decoder.close()
  decoder.close()
  assert.throws(() => decoder.decode(encoder.encode(pcm, 960)))
 } finally { decoder.close(); encoder.delete() }
})

test('上行拒绝 20ms、120ms、双声道及损坏包，不能补零伪造完整指令', async () => {
 const Opus = await opus()
 for (const [channels, samples] of [[1, 320], [1, 640], [2, 960]] as const) {
  const encoder = new Opus(16000, channels, Opus.Application.AUDIO)
  const decoder = (await codecs()).createOpusDecoder()
  try {
   const packet = encoder.encode(Buffer.alloc(samples * channels * 2), samples)
   assert.throws(() => decoder.decode(packet))
  } finally { decoder.close(); encoder.delete() }
 }
 for (const packet of [new Uint8Array(), new Uint8Array(4097), Uint8Array.of(0xff), Uint8Array.of(0x1b, 0x41), Uint8Array.of(0x19, 0, 0)]) {
  const decoder = (await codecs()).createOpusDecoder()
  try { assert.throws(() => decoder.decode(packet)) } finally { decoder.close() }
 }
})

test('跨 chunk 的 44.1kHz 双声道 MP3 重采样并混音，真实下行每包 1440 样本且音高保留', async () => {
 const packets = await collect(chunks(stereo44100))
 const Opus = await opus(), decoder = new Opus(24000, 1, Opus.Application.AUDIO)
 try {
  assert.ok(packets.length >= 4 && packets.length <= 6)
  const pcm = packets.map(packet => {
   assert.ok(packet.length > 0 && packet.length <= 4096)
   const decoded = decoder.decode(Buffer.from(packet))
   assert.equal(decoded.length, 2880)
   return decoded
  })
  const bytes = Buffer.concat(pcm), samples = new Int16Array(bytes.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  const center = samples.slice(1800, 5400)
  assert.ok(tone(center, 440) > 500)
  assert.ok(tone(center, 880) > 500)
 } finally { decoder.delete() }
})

test('分段 MP3 拼接和中途采样率变化均继续输出，尾包只在下行有界补齐', async () => {
 const single = await collect(chunks(mono22050, 1))
 const joined = await collect(chunks(Buffer.concat([stereo44100, mono22050]), 19))
 const rawJoined = await collect(chunks(Buffer.concat([stereo44100.subarray(45), mono22050.subarray(45)]), 23))
 assert.ok(single.length >= 3 && single.length <= 5)
 assert.ok(joined.length >= 8 && joined.length <= 10)
 assert.ok(rawJoined.length >= 8 && rawJoined.length <= 10)
 const Opus = await opus(), decoder = new Opus(24000, 1, Opus.Application.AUDIO)
 try { for (const packet of joined) assert.equal(decoder.decode(Buffer.from(packet)).length, 2880) }
 finally { decoder.delete() }
})

test('空、损坏和截断的 MP3 拒绝，源异常传回消费者', async () => {
 for (const data of [new Uint8Array(), Uint8Array.of(1, 2, 3, 4), stereo44100.subarray(0, -1)]) {
  await assert.rejects(collect(chunks(data)))
 }
 async function* broken() { throw new Error('供应商原始响应：private-speech-input'); yield new Uint8Array() }
 await assert.rejects(collect(broken()), error => error instanceof Error && error.message === '语音合成媒体读取失败。' && !error.message.includes('private-speech-input'))
})

test('每句超过 8MiB 的编码输入拒绝并关闭源', async () => {
 let closed = false
 async function* oversized() { try { yield new Uint8Array(8 * 1024 * 1024 + 1) } finally { closed = true } }
 await assert.rejects(collect(oversized()), /8 MiB/)
 assert.equal(closed, true)
})

test('解码超过 120 秒立即停止，不能用低码率输入绕过时长上限', async () => {
 const frame = silence8000.subarray(-72), input = new Uint8Array(frame.length * 1800)
 for (let i = 0; i < 1800; i++) input.set(frame, i * frame.length)
 await assert.rejects(collect(chunks(input, 4096)), /120 秒/)
})

test('消费者暂停时不再拉取源，return 与打断均释放媒体源', async () => {
 for (const abort of [false, true]) {
  let reads = 0, closed = false
  async function* source() {
   try { for (const bytes of [stereo44100, mono22050, stereo44100]) { reads++; yield bytes } }
   finally { closed = true }
  }
  const controller = new AbortController()
  const stream = (await codecs()).transcodeSpeechMp3(source(), controller.signal)
  assert.equal((await stream.next()).done, false)
  const before = reads
  await delay(25)
  assert.equal(reads, before)
  assert.equal(reads, 1)
  if (abort) {
   controller.abort()
   await delay(25)
   assert.equal(closed, true)
   await assert.rejects(stream.next(), {name: 'AbortError'})
  } else {
   await stream.return(undefined)
   assert.equal(closed, true)
  }
 }
})

test('等待无响应的合成源时取消也及时结束，预先取消不消费源', async () => {
 let returned = false, reads = 0
 const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
  next() { reads++; return new Promise<IteratorResult<Uint8Array>>(() => {}) },
  async return() { returned = true; return {done: true, value: undefined} },
 } } }
 const controller = new AbortController(), stream = (await codecs()).transcodeSpeechMp3(source, controller.signal)
 const pending = stream.next()
 void pending.catch(() => {})
 for (let attempt = 0; attempt < 100 && reads === 0; attempt++) await delay(10)
 assert.equal(reads, 1)
 controller.abort()
 await assert.rejects(Promise.race([pending, delay(500).then(() => {throw new Error('取消未及时释放')})]), {name: 'AbortError'})
 assert.equal(returned, true)
 const cancelled = new AbortController(); cancelled.abort()
 const before = reads
 await assert.rejects(collect(source, cancelled.signal), {name: 'AbortError'})
 assert.equal(reads, before)
})
