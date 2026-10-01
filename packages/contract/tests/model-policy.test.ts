import test from 'node:test'
import assert from 'node:assert/strict'
import {readModelReference,readRoleRuntimeConfig,readTaskRunModelPolicy} from '../src/index.ts'
const local={provider:'ollama',model:'qwen3:8b'},remote={provider:'deepseek',model:'deepseek-v4-pro',reasoningEffort:'high'}
test('岗位可分别固定运行配置、模型或备用；旧预设仍可读',()=>{
 for(const value of [{agentPresetId:'teloa-standard'},{model:local},{fallbackModel:remote},{agentPresetId:'teloa-standard',model:local,fallbackModel:remote}])assert.deepEqual(readRoleRuntimeConfig(value),value)
})
test('模型身份接受官方冒号/路径标识，不接受密钥、地址或任意提供方配置',()=>{
 assert.deepEqual(readModelReference({provider:'gateway',model:'org/qwen3:8b'}),{provider:'gateway',model:'org/qwen3:8b'})
 for(const value of [{...local,apiKey:'secret'},{...local,baseURL:'https://example.test'}, {...local,model:' model '},{...local,provider:'bad\nprovider'},null])assert.throws(()=>readModelReference(value),{code:'teloa/invalid-input'})
})
test('远程备用不能指向同一个模型的另一推理档位',()=>{
 assert.throws(()=>readTaskRunModelPolicy({primary:local,fallback:{...local,reasoningEffort:'low'}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readRoleRuntimeConfig({model:remote,fallbackModel:{...remote,reasoningEffort:'low'}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readRoleRuntimeConfig({}),{code:'teloa/invalid-input'})
})

test('请求模型投影与固定策略一致，允许适配器补默认思考档位，拒绝伪造切换或敏感字段',async()=>{
 const {readTaskRunModelStatus}=await import('../src/index.ts'),policy={primary:local,fallback:remote}
 assert.deepEqual(readTaskRunModelStatus({state:'unavailable'},policy),{state:'unavailable'})
 assert.deepEqual(readTaskRunModelStatus({state:'unobserved'},policy),{state:'unobserved'})
 const primary={state:'observed',model:{...local,reasoningEffort:'medium'},requestSeq:4}
 assert.deepEqual(readTaskRunModelStatus(primary,policy),primary)
 const recovery={from:local,to:remote,reason:'TIMEOUT'},switched={state:'observed',model:remote,requestSeq:8,recovery}
 assert.deepEqual(readTaskRunModelStatus(switched,policy),switched)
 for(const value of [{state:'unobserved',model:local},{...primary,requestSeq:-1},{...primary,requestSeq:1.5},{...primary,model:remote},{...switched,recovery:{...recovery,reason:'AUTH'}},{...switched,recovery:{...recovery,to:local}},{...primary,apiKey:'secret'},{...primary,model:{...local,baseURL:'private'}}])assert.throws(()=>readTaskRunModelStatus(value,policy))
})
