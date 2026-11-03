import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessRecordCreate,readBusinessObjectTypeDefinition,parseBusinessNumberValue} from '../src/index.ts'

test('正式记录请求保留数值、零和 false 原始类型，不猜测旧字符串',()=>{
 const input={scope:'crm',type:'purchase',requestId:'11111111-1111-4111-8111-111111111111',title:'P-17',summary:'',fields:[{name:'accepted',value:false},{name:'quantity',value:0},{name:'unitPrice',value:12.5}]}
 assert.deepEqual(readBusinessRecordCreate(input),input)
 const legacy={...input,fields:[{name:'accepted',value:'false'},{name:'quantity',value:'3'}]}
 assert.deepEqual(readBusinessRecordCreate(legacy),legacy)
 for(const value of [NaN,Infinity,null,[],{}])assert.throws(()=>readBusinessRecordCreate({...input,fields:[{name:'quantity',value}]}),{code:'teloa/invalid-input'})
})

test('数字字段显式声明小数位上限；缺省保持旧 number 语义',()=>{
 const field={name:'price',label:'单价',from:'单价',type:'number',required:true,decimalScale:2}
 const definition={format:'teloa.business-object-type/v1',id:'purchase',version:'1.0.0',domain:'crm',title:'采购',unit:'条',lead:'采购',sourceId:'purchase-source',fields:[field]}
 assert.deepEqual(readBusinessObjectTypeDefinition(definition).fields,[field])
 for(const decimalScale of [-1,1.5,16])assert.throws(()=>readBusinessObjectTypeDefinition({...definition,fields:[{...field,decimalScale}]}))
 assert.equal(parseBusinessNumberValue('12.50',{decimalScale:2}),12.5)
 assert.equal(parseBusinessNumberValue('1.234',{decimalScale:2}),undefined)
 assert.equal(parseBusinessNumberValue('0.0000000000000001',{decimalScale:2}),undefined)
 assert.equal(parseBusinessNumberValue('1.234'),1.234)
})
