import test from 'node:test'
import assert from 'node:assert/strict'
import {OllamaClient,type OllamaThinking} from '../src/ollama-client.ts'
import {readOllamaAddress} from '../src/ollama-address.ts'
import {ollamaReasoning} from '../src/ollama-reasoning.ts'

const base={family:'qwen3',contextLength:40960,capabilities:['completion','tools','thinking']}
const shown=(thinking:unknown)=>new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({capabilities:base.capabilities,thinking}))}).show('qwen3:4b')
test('真实 Qwen3 4B 元数据只允许思考开启；不能虚构关闭或多个档位',async()=>{
 const metadata={values:[true],default:true}
 const model=await shown(metadata)
 assert.deepEqual(model.thinking,metadata)
 assert.deepEqual(ollamaReasoning(model),{reasoningEfforts:{high:'high'}})
})
test('布尔开关与具名档位按官方元数据进入原生选择器',()=>{
 for(const [thinking,expected] of [
  [{values:[true,false],default:true},{high:'high',off:'none'}],
  [{values:['low','medium','high',false],default:'medium'},{low:'low',medium:'medium',high:'high',off:'none'}],
  [{values:['high','xhigh','max'],default:'high'},{high:'high',xhigh:'xhigh',max:'max'}],
  [{values:[false],default:false},false],
 ] as [OllamaThinking,unknown][]){assert.deepEqual(ollamaReasoning({...base,thinking}),{reasoningEfforts:expected})}
 assert.deepEqual(ollamaReasoning({...base,capabilities:['completion']}),{})
 assert.deepEqual(ollamaReasoning({...base,capabilities:null}),{})
})
test('旧版声称 thinking 却无可核验元数据：明确要求升级，不能静默写成不思考模型',()=>{
 assert.throws(()=>ollamaReasoning(base),error=>(error as Error).message.includes('更新 Ollama'))
 assert.throws(()=>ollamaReasoning({...base,thinking:{values:['unrecognized'],default:'unrecognized'}}),{code:'teloa/source-invalid'})
})
test('思考元数据畸形、重复或默认值不在候选中拒绝',async()=>{
 for(const thinking of [null,{},true,{values:[],default:true},{values:[true,true],default:true},{values:[''],default:''},{values:[1],default:1},{values:[true],default:false},{values:[true]}, {values:['x'.repeat(65)],default:'x'.repeat(65)}]){
  await assert.rejects(shown(thinking),{code:'teloa/invalid-host-response'})
 }
})
