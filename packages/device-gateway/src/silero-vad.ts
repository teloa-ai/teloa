import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

/** 一个实例对应一个音频流；新捕获、打断或断线后必须reset或close。 */
export async function createSileroVad(modelPath: string) {
  const model = await readFile(modelPath)
  const digest = createHash('sha256').update(model).digest('hex')
  const legacy = digest === 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28'
  if (!legacy && digest !== '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3') throw new Error('Silero model SHA-256 mismatch')
  // 仅媒体路径显式创建实例时加载；复用 DSH SenseVoice 已准备的旧版模型，不下载。
  const {InferenceSession, Tensor} = await import('onnxruntime-node')
  const session = await InferenceSession.create(model, {executionProviders: ['cpu'], executionMode: 'sequential', intraOpNumThreads: 1, interOpNumThreads: 1})
  let state = new Float32Array(256)
  let context = new Float32Array(64)
  let legacyH = new Float32Array(128), legacyC = new Float32Array(128)
  let generation = 0
  let closed = false
  let pending: Promise<number> | undefined
  let closing: Promise<void> | undefined

  async function predict(pcm: Int16Array): Promise<number> {
    if (closed) throw new Error('Silero VAD is closed')
    if (pending) throw new Error('Silero VAD is busy; await the previous window')
    if (!(pcm instanceof Int16Array) || pcm.length !== 512) throw new Error('Silero VAD requires exactly 512 Int16 samples')
    const currentGeneration = generation
    const input = new Float32Array(legacy ? 512 : 576)
    if (!legacy) input.set(context)
    for (let index = 0; index < 512; index++) input[(legacy ? 0 : 64) + index] = pcm[index]! / 32768
    const inference = session.run(legacy ? {
      input: new Tensor('float32', input, [1, 512]),
      h: new Tensor('float32', legacyH, [2, 1, 64]),
      c: new Tensor('float32', legacyC, [2, 1, 64]),
      sr: new Tensor('int64', BigInt64Array.from([16000n]), []),
    } : {
      input: new Tensor('float32', input, [1, 576]),
      state: new Tensor('float32', state, [2, 1, 128]),
      sr: new Tensor('int64', BigInt64Array.from([16000n]), []),
    }).then(outputs => {
      if (closed || generation !== currentGeneration) throw new Error('Silero VAD was reset before prediction completed')
      const probability = outputs.output
      if (probability?.type !== 'float32' || probability.data.length !== 1) throw new Error('Invalid Silero model output')
      const value = Number(probability.data[0])
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid Silero VAD probability')
      if (legacy) {
        if (outputs.hn?.type !== 'float32' || outputs.hn.data.length !== 128 || outputs.cn?.type !== 'float32' || outputs.cn.data.length !== 128) throw new Error('Invalid Silero recurrent state')
        legacyH = Float32Array.from(outputs.hn.data as Float32Array); legacyC = Float32Array.from(outputs.cn.data as Float32Array)
      } else {
        const nextState = outputs.stateN
        if (nextState?.type !== 'float32' || nextState.data.length !== 256) throw new Error('Invalid Silero recurrent state')
        state = Float32Array.from(nextState.data as Float32Array)
        context = input.slice(-64)
      }
      return value
    })
    pending = inference
    try {return await inference} finally {if (pending === inference) pending = undefined}
  }
  function reset() {
    generation++
    state = new Float32Array(256)
    context = new Float32Array(64)
    legacyH = new Float32Array(128); legacyC = new Float32Array(128)
  }
  function close() {
    if (closing) return closing
    closed = true
    reset()
    closing = (async () => {
      try {await pending} catch { /* 关闭期间的迟到概率不能重新写入状态。 */ }
      await session.release()
    })()
    return closing
  }
  return {predict, reset, close}
}
