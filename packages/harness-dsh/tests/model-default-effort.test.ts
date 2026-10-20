import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import {withDefaultModelEffort} from '../src/model-default-effort.ts'

test('推理模型默认 high；显式 off、提供商和采样参数均保留，普通模型不加档位',async()=>{
 const llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off'},{id:'high'}]}})} as unknown as Context['llm']
 const config={provider:'minimax',model:'MiniMax-M2.7',maxOutputTokens:1024}
 assert.deepEqual(await withDefaultModelEffort(llm,config,AbortSignal.timeout(1000)),{...config,reasoningEffort:'high'})
 assert.deepEqual(await withDefaultModelEffort(llm,{...config,reasoningEffort:ReasoningEffortId('off')},AbortSignal.timeout(1000)),{...config,reasoningEffort:'off'})
 assert.deepEqual(await withDefaultModelEffort({resolveModelInfo:async()=>({})} as unknown as Context['llm'],config,AbortSignal.timeout(1000)),config)
})
