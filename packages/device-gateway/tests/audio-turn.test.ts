import test from 'node:test'
import assert from 'node:assert/strict'
import {createPcmTurn, createPcmWindowAdapter, type SealedPcmTurn, type DiscardedPcmTurn} from '../src/audio-turn.ts'

function capture() {
  let time = 0
  const sealed: SealedPcmTurn[] = []
  const discarded: DiscardedPcmTurn[] = []
  const turn = createPcmTurn({captureId: 'capture-1', now: () => time, onSealed: value => sealed.push(value), onDiscard: value => discarded.push(value)})
  const frames = (count: number, probability: number, value = 1000) => {
    for (let index = 0; index < count; index++) turn.push(new Int16Array(512).fill(value), probability)
  }
  return {turn, frames, sealed, discarded, setTime: (value: number) => {time = value}}
}

test('起音必须连续达到128ms，短突发和未满256ms语音不能派发', () => {
  const state = capture()
  state.frames(3, .6)
  assert.equal(state.turn.state, 'listening')
  state.frames(1, .59)
  state.frames(3, .6)
  assert.equal(state.turn.state, 'listening')
  state.frames(1, .6)
  assert.equal(state.turn.state, 'speaking')
  state.turn.stop()
  assert.equal(state.sealed.length, 0)
  assert.equal(state.discarded[0]?.reason, 'too-short')
})

test('960ms连续静音只封口一次，WAV保留320ms前缓冲和192ms尾音', () => {
  const state = capture()
  state.frames(20, .1, -1000)
  state.frames(8, .6, 2000)
  state.frames(29, .34, 3000)
  assert.equal(state.sealed.length, 0)
  state.frames(1, .34, 3000)
  state.turn.stop()
  state.turn.poll()
  state.frames(2, .9)
  assert.equal(state.sealed.length, 1)
  assert.equal(state.discarded.length, 0)
  const result = state.sealed[0]!
  assert.equal(result.captureId, 'capture-1')
  assert.equal(result.reason, 'silence')
  assert.equal(result.segmented, false)
  assert.equal(result.wav.length, 44 + 24576)
  assert.equal(result.durationMs, 768)
  assert.equal(result.speechDurationMs, 256)
  assert.equal(result.wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(result.wav.readUInt32LE(4), 24612)
  assert.equal(result.wav.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(result.wav.readUInt32LE(16), 16)
  assert.equal(result.wav.readUInt16LE(20), 1)
  assert.equal(result.wav.readUInt16LE(22), 1)
  assert.equal(result.wav.readUInt32LE(24), 16000)
  assert.equal(result.wav.readUInt32LE(28), 32000)
  assert.equal(result.wav.readUInt16LE(32), 2)
  assert.equal(result.wav.readUInt16LE(34), 16)
  assert.equal(result.wav.toString('ascii', 36, 40), 'data')
  assert.equal(result.wav.readUInt32LE(40), 24576)
  assert.equal(result.wav.readInt16LE(44), -1000)
  assert.equal(result.wav.readInt16LE(44 + 10240), 2000)
  assert.equal(result.wav.readInt16LE(result.wav.length - 2), 3000)
})

test('0.35和短暂停顿打断静音计时，手动结束复用语音封口', () => {
  const state = capture()
  state.frames(8, .9)
  state.frames(29, .1)
  state.frames(1, .35)
  state.frames(29, .1)
  assert.equal(state.sealed.length, 0)
  state.turn.stop()
  state.turn.stop()
  assert.equal(state.sealed.length, 1)
  assert.equal(state.sealed[0]?.reason, 'manual')
  assert.equal(state.sealed[0]?.durationMs, 1408)
})

test('无语音8秒按单调时钟超时，音频样本不能代替墙钟计时', () => {
  const state = capture()
  state.frames(1000, .1)
  state.setTime(7999)
  state.turn.poll()
  assert.equal(state.discarded.length, 0)
  state.setTime(8000)
  state.turn.poll()
  state.turn.stop()
  assert.deepEqual(state.discarded, [{captureId: 'capture-1', reason: 'no-speech'}])
  assert.equal(state.sealed.length, 0)
})

test('含缓冲的PCM精确限制480000字节，回执明确已分段', () => {
  const state = capture()
  state.frames(20, .1)
  state.frames(500, .9)
  const result = state.sealed[0]!
  assert.equal(state.sealed.length, 1)
  assert.equal(result.wav.length, 480044)
  assert.equal(result.durationMs, 15000)
  assert.equal(result.reason, 'limit')
  assert.equal(result.segmented, true)
  assert.match(result.message ?? '', /分段/)
})

test('断线丢弃半句，不封口、不复用下一路缓冲或重复回执', () => {
  const state = capture()
  state.frames(8, .9, -32768)
  state.turn.abort()
  state.turn.abort()
  state.turn.stop()
  assert.equal(state.sealed.length, 0)
  assert.deepEqual(state.discarded, [{captureId: 'capture-1', reason: 'aborted'}])
  const next = capture()
  next.frames(8, .9, 32767)
  next.turn.stop()
  assert.equal(next.sealed[0]?.wav.readInt16LE(44), 32767)
})

test('非法概率和超窗PCM在修改轮次前拒绝', () => {
  const state = capture()
  for (const probability of [-.1, 1.1, NaN, Infinity]) assert.throws(() => state.turn.push(new Int16Array(512), probability))
  for (const size of [0, 513]) assert.throws(() => state.turn.push(new Int16Array(size), .9))
  assert.equal(state.turn.state, 'listening')
})

test('960样本Opus解码块按512分窗，末尾只补推理输入且不混入WAV', async () => {
  const windows: number[][] = []
  const observed: number[][] = []
  const adapter = createPcmWindowAdapter({
    predict: async pcm => {windows.push([...pcm]); return .9},
    onWindow: (pcm, probability) => {assert.equal(probability, .9); observed.push([...pcm])},
  })
  await adapter.push(new Int16Array(960).fill(7))
  assert.deepEqual(observed.map(value => value.length), [512])
  await adapter.push(new Int16Array(960).fill(9))
  assert.deepEqual(observed.map(value => value.length), [512, 512, 512])
  await adapter.flush()
  assert.deepEqual(observed.map(value => value.length), [512, 512, 512, 384])
  assert.equal(windows[3]?.length, 512)
  assert.equal(windows[3]?.[383], 9)
  assert.equal(windows[3]?.[384], 0)
  assert.equal(observed.flat().length, 1920)
  assert.equal(observed.flat()[959], 7)
  assert.equal(observed.flat()[960], 9)
})

test('分窗适配拒绝并发积压，重置后迟到预测不再投递', async () => {
  let resolvePrediction!: (value: number) => void
  let delivered = 0
  const adapter = createPcmWindowAdapter({predict: () => new Promise(resolve => {resolvePrediction = resolve}), onWindow: () => {delivered++}})
  const pending = adapter.push(new Int16Array(960))
  await assert.rejects(adapter.push(new Int16Array(960)), /busy/)
  adapter.reset()
  resolvePrediction(.9)
  await pending
  assert.equal(delivered, 0)
  await assert.rejects(adapter.push(new Int16Array(16001)), /16000/)
})

test('封口回调重置分窗后，不再推理或投递同批余下的音频', async () => {
  let predictions = 0
  let delivered = 0
  const adapter = createPcmWindowAdapter({
    predict: async () => {predictions++; return .9},
    onWindow: () => {delivered++; adapter.reset()},
  })
  await adapter.push(new Int16Array(1920))
  assert.equal(predictions, 1)
  assert.equal(delivered, 1)
  await adapter.flush()
  assert.equal(delivered, 1)
})
