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
