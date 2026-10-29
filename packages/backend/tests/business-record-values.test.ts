import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
import type {BusinessObjectFieldDefinition,BusinessRichMoneyFieldDefinition,BusinessRichMultiEnumFieldDefinition} from '@teloa/contract'
const field=(type:BusinessObjectFieldDefinition['type'],required=true):BusinessObjectFieldDefinition=>({name:'value',label:'值',from:'值',type,required,...(type==='enum'?{values:['甲','乙']}:{})})
const money:BusinessRichMoneyFieldDefinition={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'金额',required:true,type:'money',currencies:['CNY','SGD']}
const tags:BusinessRichMultiEnumFieldDefinition={format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'标签',required:true,type:'multi-enum',values:['vip','priority']}
test('严格原始字段值共用校验，完整数值和原生布尔/时长语义',()=>{
 assert.equal(typeof api.assertBusinessRecordFieldValue,'function')
 for(const [type,valid,invalid] of [
  ['number',['12','-1.2e3','1e15'],['12oops','Infinity','0x10','1e16']],
  ['boolean',['true','false','是','否','1','0'],['yesplease']],
  ['duration',['30','PT1H'],['-1','1e13','30oops']],
  ['datetime',['2026-09-29T00:00:00.000Z'],['2026-02-30','tomorrow']],
  ['enum',['甲'],['丙']],
  ['text',['正文'],[' trailing','x'.repeat(2001)]],
 ] as const){for(const v of valid)api.assertBusinessRecordFieldValue(field(type),v);for(const v of invalid)assert.throws(()=>api.assertBusinessRecordFieldValue(field(type),v),{code:'teloa/invalid-input'})}
 for(const type of ['text','number','enum','datetime','reference','duration','boolean'] as const){assert.throws(()=>api.assertBusinessRecordFieldValue(field(type),undefined));api.assertBusinessRecordFieldValue(field(type,false),undefined);api.assertBusinessRecordFieldValue(field(type,false),'')}
})

test('金额字段按规范原值校验，不把大整数或非规范小数转为 Number',()=>{
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue(money,'{"currency":"CNY","decimal":"9007199254740993.01"}'))
 for(const value of ['{"currency":"CNY","decimal":"1.2300"}','{"currency":"USD","decimal":"1"}','{"decimal":"1","currency":"CNY"}',undefined,''])
  assert.throws(()=>api.assertBusinessRecordFieldValue(money,value),{code:'teloa/invalid-input'})
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue({...money,required:false},undefined))
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue({...money,required:false},''))
})

test('多选字段只接受声明顺序且去重的规范串，必填不能为空',()=>{
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue(tags,'["vip","priority"]'))
 for(const value of ['["priority","vip"]','["vip","vip"]','["unknown"]','[]','["vip",1]',undefined,''])
  assert.throws(()=>api.assertBusinessRecordFieldValue(tags,value),{code:'teloa/invalid-input'})
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue({...tags,required:false},undefined))
})

test('日期错误明确规范UTC含毫秒格式，保持严格校验且不回显原始字段值',()=>{
 for(const value of ['2026-10-28T15:11:38Z','2026-10-28T23:11:38.000+08:00','2026-02-30T00:00:00.000Z','PRIVATE-DATE'])assert.throws(()=>api.assertBusinessRecordFieldValue(field('datetime'),value),(error:unknown)=>{
  assert.ok(error instanceof Error&&'details' in error)
  assert.deepEqual(error.details,{reason:'datetime-format',field:'value',format:'YYYY-MM-DDTHH:mm:ss.sssZ',example:'2026-10-28T15:11:38.000Z'})
  assert.match(error.message,/UTC.*3位毫秒.*Z/)
  assert.ok(!JSON.stringify({message:error.message,details:error.details}).includes(value))
  return true
 })
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue(field('datetime'),'2026-10-28T15:11:38.000Z'))
})

test('基础字段超长错误只包含字段和长度事实，2000边界仍按UTF16严格执行',()=>{
 const value='PRIVATE-TEXT-'+ '密'.repeat(2434)
 assert.equal(value.length,2447)
 assert.throws(()=>api.assertBusinessRecordFieldValue(field('text'),value),(error:unknown)=>{
  assert.ok(error instanceof Error&&'details' in error)
  assert.deepEqual(error.details,{reason:'field-value-too-long',field:'value',actualLength:2447,maxLength:2000,lengthUnit:'utf16-code-units'})
  assert.match(error.message,/2447.*2000/)
  assert.ok(!JSON.stringify({message:error.message,details:error.details}).includes('PRIVATE-TEXT-'))
  return true
 })
 assert.doesNotThrow(()=>api.assertBusinessRecordFieldValue(field('text'),'😀'.repeat(1000)))
 assert.throws(()=>api.assertBusinessRecordFieldValue(field('text'),'😀'.repeat(1000)+'字'),{code:'teloa/invalid-input'})
})
