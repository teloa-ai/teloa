import test from 'node:test'
import assert from 'node:assert/strict'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'
import {registerProjectRuntimeContext,type ProjectRuntimePrepared} from '../src/project-runtime-context.ts'
import {readComposerSuggestion,clearComposerSuggestionCache} from '../src/composer-suggestion.ts'
import {WorkError} from '@teloa/contract'

test('真实原生 Loop：cacheOnly 不 prepare 模型、不建辅助队列；缓存仍按 owner/来源撤回重验',async t=>{
 clearComposerSuggestionCache();t.after(clearComposerSuggestionCache)
 const f=await nativeHotCausalityFixture(t)
 t.mock.method(f.ctx.logger,'info',(...args:unknown[])=>{t.diagnostic(JSON.stringify(args))});t.mock.method(f.ctx.logger,'warn',(...args:unknown[])=>{t.diagnostic(JSON.stringify(args))})
 f.ctx.provide('teloaNativeInput',{input:f.work} as never)
 let generation=1,modelPrepares=0
 const runtime=registerProjectRuntimeContext(f.ctx,{
  owner:'cache-only-owner',
  prepare:async input=>({binding:{sessionId:input.sessionId,projectId:'synthetic-project',version:1,title:'只读缓存',memoryMode:'off',generation,contextVersion:generation,settingsVersion:1},manifestId:'synthetic-manifest',text:'合成规则：等本人确认。',sources:[{kind:'rule',id:'synthetic-rule',version:1,hash:'a'.repeat(64),title:'规则'}],reset:false,providerSessionId:input.sessionId+'-generation-'+generation}),
  assertCurrent:async input=>{if(input.generation!==generation)throw new WorkError('teloa/conflict','来源已撤回。')},
  assertPreparedCurrentSync:(prepared:ProjectRuntimePrepared)=>{if(prepared.binding.generation!==generation)throw new WorkError('teloa/conflict','来源已撤回。')},
  recordUsed:async()=>{},
 })
 t.after(()=>runtime.close())
 f.adapter.scripts.push(textAnswer);await f.send('合成当前问题');await f.agent.whenIdle()
 const ports={owner:'cache-only-owner',model:async()=>{modelPrepares++;return {provider:'hot-test',model:'hot-model'}}}
 const read=(cacheOnly:boolean|undefined,owner=ports.owner)=>readComposerSuggestion(f.ctx,{...ports,owner},{sessionId:f.agent.id,...cacheOnly===undefined?{}:{cacheOnly}})
 const count=f.adapter.requests.length
 assert.deepEqual(await read(true),{text:null});assert.equal(modelPrepares,0);assert.equal(f.adapter.requests.length,count)
 f.adapter.scripts.push(textAnswer);assert.deepEqual(await read(undefined),{text:'done'});assert.equal(modelPrepares,1)
 assert.deepEqual(await read(true),{text:'done'});assert.equal(modelPrepares,1)
 assert.deepEqual(await read(true,'another-owner'),{text:null});assert.equal(modelPrepares,1,'另一个 owner 的 cache key 不能借用候选或生成模型')
 generation=2
 assert.deepEqual(await read(true),{text:null});assert.equal(modelPrepares,1)
 assert.equal(f.adapter.requests.length,count+1,'缓存检查/撤回均不派发额外 SDK')
 await assert.rejects(readComposerSuggestion(f.ctx,ports,{sessionId:f.agent.id,cacheOnly:'true'}),error=>error instanceof WorkError&&error.code==='teloa/invalid-input')
})
