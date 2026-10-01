import test from 'node:test'
import assert from 'node:assert/strict'
import {readIndustryModelDependencies,industryResourceModelDependencies,assertIndustryModelsReady,industryModelPhases,readIndustryModelObservations} from '../src/industry-model-dependencies.ts'

const dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text' as const,required:true}
test('模型声明只接受固定目录引用；拒绝执行代码、地址、动态版本和冲突用途',()=>{
 assert.deepEqual(readIndustryModelDependencies([dependency]),[dependency])
 for(const value of [[],null,[{...dependency,version:'latest'}],[{...dependency,url:'https://example.com/model'}],[{...dependency,command:'run'}],[{...dependency,required:'true'}],[{...dependency,usage:'unknown'}],[dependency,{...dependency,version:'2.0.0'}]])assert.throws(()=>readIndustryModelDependencies(value))
 assert.throws(()=>industryResourceModelDependencies('knowledge',[dependency]))
 assert.deepEqual(industryResourceModelDependencies('skill',undefined),{})
})
test('只有 ready/standby 可执行；可选依赖和无依赖不探测，未接入探针不能放行',async()=>{
 for(const phase of industryModelPhases){
  const attempt=assertIndustryModelsReady([dependency],async()=>phase)
  if(phase==='ready'||phase==='standby')await attempt
  else await assert.rejects(attempt,{code:'teloa/dependency-unavailable'})
 }
 await assert.rejects(assertIndustryModelsReady([dependency]),{code:'teloa/dependency-unavailable'})
 const unexpected=async():Promise<never>=>{throw Error('不应探测')}
 await assertIndustryModelsReady(undefined,unexpected)
 await assertIndustryModelsReady([{...dependency,required:false}],unexpected)
})
test('状态回包不能携带地址或把陌生状态显示为就绪',()=>{
 const observation={...dependency,title:'本地语音',phase:'ready'}
 assert.deepEqual(readIndustryModelObservations([observation]),[observation])
 assert.throws(()=>readIndustryModelObservations([{...observation,phase:'ok'}]))
 assert.throws(()=>readIndustryModelObservations([{...observation,url:'https://example.com'}]))
})
