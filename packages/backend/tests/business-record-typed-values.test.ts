import test from 'node:test'
import assert from 'node:assert/strict'
import {assertBusinessRecordFieldValue} from '../src/work/business-record-values.ts'
import {parseBusinessBasicField} from '../src/work/business-view-compute.ts'

test('字段校验保留真实 number/boolean，只允许匹配声明的类型',()=>{
 const field={name:'value',label:'值',from:'值',type:'number' as const,required:true,integer:true as const,minimum:0}
 for(const value of [0,3])assert.doesNotThrow(()=>assertBusinessRecordFieldValue(field,value))
 for(const value of [false,3.1,-1,Infinity])assert.throws(()=>assertBusinessRecordFieldValue(field,value),{code:'teloa/invalid-input'})
 const boolean={name:'accepted',label:'验收',from:'验收',type:'boolean' as const,required:true}
 assert.doesNotThrow(()=>assertBusinessRecordFieldValue(boolean,false))
 assert.throws(()=>assertBusinessRecordFieldValue(boolean,0),{code:'teloa/invalid-input'})
 assert.throws(()=>assertBusinessRecordFieldValue(boolean,null as never),{code:'teloa/invalid-input'},'null 不推断为 false 或缺失')
 assert.doesNotThrow(()=>assertBusinessRecordFieldValue(boolean,'false'),'旧字符串仍可读写，不推断迁移')
 assert.throws(()=>assertBusinessRecordFieldValue({...field,type:'text' as const},3),{code:'teloa/invalid-input'})
 const {integer:_,...decimal}=field
 assert.doesNotThrow(()=>assertBusinessRecordFieldValue({...decimal,decimalScale:2},12.5))
 assert.throws(()=>assertBusinessRecordFieldValue({...decimal,decimalScale:2},12.501),{code:'teloa/invalid-input'})
})
test('比较与汇总读取真实 false/0，不通过 truthy 判断或把错类型转成字符串',()=>{
 const known=new Map<string,Set<string>>(),base={name:'value',label:'值',from:'值',required:true}
 assert.equal(parseBusinessBasicField({...base,type:'boolean'},false,known),false)
 assert.equal(parseBusinessBasicField({...base,type:'number'},0,known),0)
 assert.equal(parseBusinessBasicField({...base,type:'boolean'},0,known),undefined)
 assert.equal(parseBusinessBasicField({...base,type:'number'},false,known),undefined)
 assert.equal(parseBusinessBasicField({...base,type:'boolean'},'false',known),false)
 assert.equal(parseBusinessBasicField({...base,type:'number',decimalScale:2},'12.501',known),undefined)
})
