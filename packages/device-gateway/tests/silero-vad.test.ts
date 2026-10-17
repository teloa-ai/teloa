import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createSileroVad} from '../src/silero-vad.ts'
import {createPcmTurn, type SealedPcmTurn} from '../src/audio-turn.ts'

const modelPath = process.env.TELOA_SILERO_MODEL
const audioPath = process.env.TELOA_SILERO_TEST_WAV
const realModel = {skip: !modelPath || !audioPath ? '设置固定模型和上游测试语音路径后运行真实ONNX验收' : false}

async function fixture() {
  const model = await readFile(modelPath!)
  const wav = await readFile(audioPath!)
  assert.equal(createHash('sha256').update(model).digest('hex'), '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3')
  assert.equal(createHash('sha256').update(wav).digest('hex'), '89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47')
  assert.equal(wav.readUInt32LE(24), 16000)
  const pcm = new Int16Array((wav.length - 44) / 2)
  for (let index = 0; index < pcm.length; index++) pcm[index] = wav.readInt16LE(44 + index * 2)
  return pcm
}

test('加载时拒绝与来源锁摘要不符的文件', realModel, async () => {
  await assert.rejects(createSileroVad(audioPath!), /SHA-256/)
})

test('真实v6.2模型识别上游MIT测试语音和静音，并能驱动真实轮次封口', realModel, async t => {
  const pcm = await fixture()
  const vad = await createSileroVad(modelPath!)
  t.after(() => vad.close())
  const sealed: SealedPcmTurn[] = []
  const turn = createPcmTurn({captureId: 'real-onnx', now: () => 0, onSealed: result => sealed.push(result), onDiscard: result => assert.fail(result.reason)})
  let speechWindows = 0
  let quietWindows = 0
  for (let offset = 0; offset + 512 <= pcm.length; offset += 512) {
    const window = pcm.slice(offset, offset + 512)
    const probability = await vad.predict(window)
    assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1)
    if (probability >= .6) speechWindows++
    if (probability < .35) quietWindows++
    turn.push(window, probability)
  }
  assert.ok(speechWindows > 100, `speechWindows=${speechWindows}`)
  assert.ok(quietWindows > 100, `quietWindows=${quietWindows}`)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0]?.captureId, 'real-onnx')
  assert.ok(sealed[0]!.speechDurationMs >= 256)
  assert.ok(sealed[0]!.wav.length <= 480044)
  vad.reset()
  for (let index = 0; index < 32; index++) assert.ok(await vad.predict(new Int16Array(512)) < .35)
  t.diagnostic(`真实60秒语音：${speechWindows}个语音窗口，${quietWindows}个静音窗口；首轮${sealed[0]!.reason}，${sealed[0]!.durationMs}ms`)
})

test('每路独立RNN和64样本上下文，reset重放得到相同概率', realModel, async t => {
  const pcm = await fixture()
  const first = await createSileroVad(modelPath!)
  const second = await createSileroVad(modelPath!)
  t.after(async () => {await first.close(); await second.close()})
  const probabilities: number[] = []
  for (let offset = 0; offset < 512 * 160; offset += 512) {
    const window = pcm.slice(offset, offset + 512)
    const a = await first.predict(window)
    const b = await second.predict(window)
    assert.ok(Math.abs(a - b) < 1e-7)
    probabilities.push(a)
  }
  first.reset()
  for (let index = 0; index < probabilities.length; index++) {
    const probability = await first.predict(pcm.slice(index * 512, (index + 1) * 512))
    assert.ok(Math.abs(probability - probabilities[index]!) < 1e-7)
  }
})

test('非法窗口、并发预测、reset迟到结果和close后的输入明确拒绝', realModel, async () => {
  const vad = await createSileroVad(modelPath!)
  try {
    for (const size of [0, 64, 511, 513, 960]) await assert.rejects(vad.predict(new Int16Array(size)), /512/)
    const pending = vad.predict(new Int16Array(512))
    await assert.rejects(vad.predict(new Int16Array(512)), /busy/)
    vad.reset()
    await assert.rejects(pending, /reset/)
  } finally {await vad.close()}
  await assert.rejects(vad.predict(new Int16Array(512)), /closed/)
  await vad.close()
})
