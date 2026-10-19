import test from 'node:test'
import assert from 'node:assert/strict'
import {parameterSchemaSpecToJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {createDeliveryReviewToolParameters,deliveryReviewToolShapeExample} from '../src/task-delivery-review-schema.ts'
import {createReviewSourceCatalog,readRevisionSubmission} from '../src/task-delivery-review-protocol.ts'

const revision=()=>({phase:'revise',issues:[{problem:'第1块与原资料不符。',basis:[{sourceId:'goal',passageId:'p1'}],affectedScope:'coverage',coverage:{change:[1],retain:[],unrelated:[],unknown:[],unlisted:'retain'},edits:[{blockId:1,after:'原资料确认的内容。'}]}]})
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

test('本轮来源投影绑定真实片段组合，拒绝不存在或串错来源的片段',()=>{
 const catalog=[{id:'goal',passages:[{id:'p1'}]},{id:'context:/message',passages:[{id:'p1'},{id:'p2'}]}]
 const compiled=parameterSchemaSpecToJsonSchema(createDeliveryReviewToolParameters('revise',catalog))
 const value=revision();value.issues[0]!.basis=[{sourceId:'context:/message',passageId:'p2'}]
 assert.deepEqual(validateJsonSchemaValue(compiled,value,''),[])
 for(const ref of [{sourceId:'context:/message',passageId:'p3'},{sourceId:'goal',passageId:'p2'},{sourceId:'missing',passageId:'p1'}]){
  value.issues[0]!.basis=[ref];assert.ok(validateJsonSchemaValue(compiled,value,'').length>0)
 }
 const verification=verify() as Record<string,any>;verification.verdict='reject';verification.findings=[{problem:'待补证',basis:[{sourceId:'goal',passageId:'p2'}],blockIds:[1]}]
 assert.ok(validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(createDeliveryReviewToolParameters('verify',catalog)),verification,'').length>0)
})

test('单来源直接呈现对象，不能生成官方SDK拒绝的单分支oneOf',()=>{
 const compiled=parameterSchemaSpecToJsonSchema(createDeliveryReviewToolParameters('revise',[{id:'goal',passages:[{id:'p1'}]}]))
 assert.equal(compiled.properties!.issues!.items!.properties!.basis!.items!.oneOf,undefined)
 assert.deepEqual(validateJsonSchemaValue(compiled,revision(),''),[])
 const invalid=revision();invalid.issues[0]!.basis=[{sourceId:'missing',passageId:'p1'}]
 assert.ok(validateJsonSchemaValue(compiled,invalid,'').length>0)
})

test('当前简写投影必须显式声明未列块归属，不能因手抄整稿编号漏号才在工具体失败',()=>{
 const value=revision() as Record<string,any>
 delete value.issues[0].coverage.unlisted
 assert.ok(validateJsonSchemaValue(schema('revise'),value,'').some(error=>error.includes('coverage.unlisted')))
})

test('大型来源不膨胀工具参数，完整来源与片段仍由宿主严格核验',()=>{
 const catalog=createReviewSourceCatalog(Array.from({length:1400},(_,i)=>({id:'context:/groupContext/fixed/'+i,kind:'context' as const,title:'冻结来源'+i,text:'原始事实'+i,origin:{field:'inputText' as const,pointer:'/groupContext/fixed/'+i}})))
 const sources=catalog.sources.map(source=>({id:source.id,passages:catalog.passages.filter(p=>p.sourceId===source.id)}))
 const compiled=parameterSchemaSpecToJsonSchema(createDeliveryReviewToolParameters('revise',sources))
 assert.ok(Buffer.byteLength(JSON.stringify(compiled))<12000)
 assert.equal(catalog.sources.length,1400)
 const context={catalog,blockCount:1,unit:{first:0,last:0},unitIndex:0}
 const value=revision();value.issues[0]!.basis=[{sourceId:sources[1399]!.id,passageId:'p1'}]
 assert.ok(!('reason' in readRevisionSubmission(value,context)))
 for(const ref of [{sourceId:'missing',passageId:'p1'},{sourceId:sources[1399]!.id,passageId:'p2'}]){
  value.issues[0]!.basis=[ref]
  assert.ok('reason' in readRevisionSubmission(value,context),'模型投影简化不能绕过来源核验')
 }
})
