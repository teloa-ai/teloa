import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessObjectTypeDefinition} from '../src/business-definitions.ts'
import {readBusinessObjectTypeDefinitionV2,readBusinessObjectTypeDefinitionVersioned} from '../src/index.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const scope='business_0123456789abcdef0123456789abcdef'
const state={name:'state',label:'阶段',type:'enum',required:true,from:'原阶段',values:['新建','完成']}
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY','SGD']}
const tags={format:'teloa.business-rich-field/v2',name:'tags',label:'标签',type:'multi-enum',required:false,from:'原标签',values:['vip','priority']}
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[state,money,tags],progress:{stageField:'state',unfinished:['新建'],waitingForYou:[]}}

test('v2 对象类型混用旧七类与金额/多选，按 format 显式分派',()=>{
 assert.deepEqual(readBusinessObjectTypeDefinitionV2(object),object)
 assert.deepEqual(readBusinessObjectTypeDefinitionVersioned(object),object)
 const legacy={...object,format:'teloa.business-object-type/v1',fields:[state]}
 assert.deepEqual(readBusinessObjectTypeDefinitionVersioned(legacy),readBusinessObjectTypeDefinition(legacy))
 assert.throws(()=>readBusinessObjectTypeDefinition(object),invalid)
})

test('v2 字段仍以稳定 name/from 去重，旧枚举才能作为阶段',()=>{
 for(const value of [
  {...object,fields:[state,{...money,name:'state'}]},
  {...object,fields:[state,{...tags,from:'原阶段'}]},
  {...object,fields:[state,{...money,currencies:['CNY','CNY']}]},
  {...object,fields:[state,{...money,format:undefined}]},
  {...object,fields:[state,{...money,type:'quantity'}]},
  {...object,fields:[state,{...money,unknown:true}]},
  {...object,progress:{stageField:'tags',unfinished:['vip'],waitingForYou:[]}},
  {...object,unexpected:true},
 ])assert.throws(()=>readBusinessObjectTypeDefinitionV2(value),invalid)
})

test('v2 仅收七类旧字段及两类富字段，未知格式不得回退 v1',()=>{
 const legacy={...object,format:'teloa.business-object-type/v1',fields:[state]}
 for(const value of [
  {...object,fields:[state,{name:'bad',label:'未知',from:'未知',required:false,type:'date'}]},
  {...object,fields:[state,{...money,type:'text'}]},
  {...object,format:'teloa.business-object-type/v3'},
  {...legacy,fields:[state,money]},
 ])assert.throws(()=>readBusinessObjectTypeDefinitionVersioned(value),invalid)
})
