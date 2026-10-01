import test from 'node:test'
import assert from 'node:assert/strict'
import * as values from '../src/work/business-record-values.ts'
import type {BusinessRecordConstraintState} from '../src/work/business-record-values.ts'
import type {BusinessObjectTypeDefinitionV2} from '@teloa/contract'

const scope='business_0123456789abcdef0123456789abcdef'
const definition={format:'teloa.business-object-type/v2',id:'project',version:'1.0.0',domain:scope,title:'项目',unit:'个',lead:'项目记录',sourceId:'records',fields:[
 {name:'code',label:'编号',type:'text',from:'原编号',required:false},
 {format:'teloa.business-rich-field/v2',name:'customers',label:'客户',type:'multi-reference',referenceType:'customer',from:'原客户',required:false},
],constraints:{uniqueFields:['code','customers']}} as BusinessObjectTypeDefinitionV2
const row=(id:string,code:string|undefined,ids:string[]=[])=>( {id,fields:[...(code===undefined?[]:[{label:'原编号',value:code}]),...(ids.length?[{label:'原客户',value:JSON.stringify(ids)}]:[])]} )
function check(records:BusinessRecordConstraintState[]){
 const assertState=values.assertBusinessRecordUniqueState
 assert.equal(typeof assertState,'function','后端须提供共享的真实记录唯一性检查')
 assertState!(definition,records)
}
test('逐字段独立唯一：不同关联不能掩盖相同客户编号',()=>{
 assert.throws(()=>check([row('p1','C1',['c1']),row('p2','C1',['c2'])]),{code:'teloa/conflict',details:{reason:'unique-field',field:'code'}})
})
test('多关联的任一成员不可被另一记录占用，空值和归档释放占用',()=>{
 assert.throws(()=>check([row('p1','P1',['c1','c2']),row('p2','P2',['c2','c3'])]),{code:'teloa/conflict'})
 assert.doesNotThrow(()=>check([row('p1',undefined),row('p2',''),row('p3','P3',['c1']),{...row('old','P3',['c1']),deletedAt:'2026-09-30T00:00:00.000Z'}]))
})
test('全部批次后态可交换或归档释放，检查不改写字段',()=>{
 const records=[row('p1','P2',['c2']),row('p2','P1',['c1'])],before=structuredClone(records)
 assert.doesNotThrow(()=>check(records));assert.deepEqual(records,before)
})
test('损坏的唯一字段不是空值，非法多关联明确停止',()=>{
 assert.throws(()=>check([{id:'p1',fields:[{label:'原客户',value:'["c1","c1"]'}]}]),{code:'teloa/storage-corrupt'})
})
test('必填唯一字段缺失不能作为可选空值释放占用',()=>{
 const required={...definition,fields:definition.fields.map(field=>field.name==='code'?{...field,required:true}:field)}
 assert.throws(()=>values.assertBusinessRecordUniqueState(required,[row('p1',undefined)]),{code:'teloa/storage-corrupt'})
})
