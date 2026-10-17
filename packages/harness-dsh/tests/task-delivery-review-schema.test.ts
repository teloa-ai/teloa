import test from 'node:test'
import assert from 'node:assert/strict'
import {parameterSchemaSpecToJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {createDeliveryReviewToolParameters,deliveryReviewToolShapeExample} from '../src/task-delivery-review-schema.ts'

const revision=()=>({phase:'revise',issues:[{problem:'第1块与原资料不符。',basis:[{sourceId:'goal',passageId:'p1'}],affectedScope:'coverage',coverage:{change:[1],retain:[],unrelated:[],unknown:[]},edits:[{blockId:1,after:'原资料确认的内容。'}]}]})
const verify=()=>({phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]})
const schema=(phase:'revise'|'verify')=>parameterSchemaSpecToJsonSchema(createDeliveryReviewToolParameters(phase))

test('修订投影只展示当前阶段的单一问题结构，空修订和合法数组通过 SDK 校验',()=>{
 const compiled=schema('revise'),properties=compiled.properties!
 assert.deepEqual(Object.keys(properties),['phase','issues'])
 assert.equal(properties.phase!.const,'revise')
 assert.equal(properties.issues!.items!.type,'object')
 assert.equal(properties.issues!.items!.oneOf,undefined)
 assert.equal(properties.issues!.items!.additionalProperties,false)
 assert.equal(properties.issues!.items!.properties!.affectedBlockIds,undefined)
 assert.deepEqual(validateJsonSchemaValue(compiled,{phase:'revise',issues:[]},''),[])
 assert.deepEqual(validateJsonSchemaValue(compiled,revision(),''),[])
 assert.ok(validateJsonSchemaValue(compiled,{phase:'verify',issues:[]},'').some(error=>error.includes('phase')))
})

test('实际错误形状直接落到 unknown 数组与问题内 edits 的叶错误，绝不自动修正输入',()=>{
 const compiled=schema('revise'),bad=revision() as Record<string,any>
 bad.issues[0].coverage.unknown=''
 bad.edits=bad.issues[0].edits;delete bad.issues[0].edits
 const errors=validateJsonSchemaValue(compiled,bad,'')
 assert.ok(errors.some(error=>error.includes('issues[0].coverage.unknown')&&error.includes('array')))
 assert.ok(errors.some(error=>error.includes('issues[0].edits')))
 assert.equal(bad.issues[0].coverage.unknown,'')
 assert.equal(Object.hasOwn(bad.issues[0],'edits'),false)
 assert.ok(!errors.some(error=>error.includes('oneOf')))
})

test('四类覆盖都必须是整数数组，缺失、null、空字符串与未知字段均拒绝',()=>{
 const compiled=schema('revise')
 for(const key of ['change','retain','unrelated','unknown']){
  for(const value of ['',null,[1.5],['1']]){
   const bad=revision() as Record<string,any>;bad.issues[0].coverage[key]=value
   assert.ok(validateJsonSchemaValue(compiled,bad,'').length>0,key+':'+JSON.stringify(value))
  }
  const missing=revision() as Record<string,any>;delete missing.issues[0].coverage[key]
  assert.ok(validateJsonSchemaValue(compiled,missing,'').some(error=>error.includes(key)))
 }
 const extra=revision() as Record<string,any>;extra.issues[0].affectedBlockIds=[1]
 assert.ok(validateJsonSchemaValue(compiled,extra,'').some(error=>error.includes('affectedBlockIds')))
 const implicit=revision() as Record<string,any>;implicit.issues[0].coverage.unlisted='unknown'
 assert.ok(validateJsonSchemaValue(compiled,implicit,'').length>0)
 const explicit=revision() as Record<string,any>;explicit.issues[0].coverage.unlisted='retain'
 assert.deepEqual(validateJsonSchemaValue(compiled,explicit,''),[])
})

test('验收投影不暴露修订字段，缺项或错误状态拒绝；模型形状示例均符合对应 SDK schema',()=>{
 const compiled=schema('verify')
 assert.deepEqual(Object.keys(compiled.properties!),['phase','verdict','checks','changeChecks','findings'])
 assert.deepEqual(validateJsonSchemaValue(compiled,verify(),''),[])
 for(const key of ['verdict','checks','changeChecks','findings']){
  const bad=verify() as Record<string,any>;delete bad[key]
  assert.ok(validateJsonSchemaValue(compiled,bad,'').some(error=>error.includes(key)))
 }
 const wrong=verify();wrong.checks[0]!.status='verified'
 assert.ok(validateJsonSchemaValue(compiled,wrong,'').length>0)
 for(const phase of ['revise','verify'] as const){
  const example=deliveryReviewToolShapeExample(phase),start=example.indexOf('{'),end=example.lastIndexOf('}')
  assert.deepEqual(validateJsonSchemaValue(schema(phase),JSON.parse(example.slice(start,end+1)),''),[])
 }
})
