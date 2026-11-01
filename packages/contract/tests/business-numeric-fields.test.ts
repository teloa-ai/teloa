import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessObjectTypeDefinitionVersioned,readBusinessConfigurationCandidateV2,parseBusinessNumberValue} from '../src/index.ts'
const quantity={name:'quantity',label:'数量',from:'数量',type:'number',required:true,integer:true as const,minimum:0}
const definition=(format='teloa.business-object-type/v1',field:unknown=quantity)=>({format,id:'inventory',version:'1.0.0',domain:'inventory',title:'合成库存',unit:'条',lead:'本地库存',sourceId:'records',fields:[{name:'sku',label:'SKU',from:'SKU',type:'text',required:true},field,{name:'warehouse',label:'仓库',from:'仓库',type:'text',required:true}]})
test('共用数字解析只接受完整原文，整数与下限不能由空白或下溢绕过',()=>{
 for(const value of [' 4','4 ','4\n','4\r\n','0x4','NaN','Infinity',''])assert.equal(parseBusinessNumberValue(value,quantity),undefined,value)
 assert.equal(parseBusinessNumberValue('40e-1',quantity),4);assert.equal(parseBusinessNumberValue('0e-400',quantity),0)
 assert.equal(parseBusinessNumberValue('-1e-400',{minimum:0}),undefined)
})
test('minimum按十进制原文比较，下限附近小数不能经Number舍入跨界',()=>{
 for(const [raw,minimum] of [['0.99999999999999999999',1],['-1.00000000000000001',-1],['9.999999999999999999e-20',1e-19],['-1e-400',0]] as const)assert.equal(parseBusinessNumberValue(raw,{minimum}),undefined,raw)
 for(const [raw,minimum,want] of [['1.00000000000000001',1,1],['-0.99999999999999999999',-1,-1],['1e-400',0,0],['-0',0,-0],['100e-2',1,1]] as const)assert.equal(parseBusinessNumberValue(raw,{minimum}),want,raw)
})
test('v1/v2库存定义和完整草案往返保留非负整数声明',()=>{
 for(const format of ['teloa.business-object-type/v1','teloa.business-object-type/v2'])assert.deepEqual(readBusinessObjectTypeDefinitionVersioned(definition(format)),definition(format))
 const candidate={format:'teloa.business-configuration/v2',scope:'inventory',title:'合成库存',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:definition('teloa.business-object-type/v2')}],pages:[{kind:'records',id:'inventory',title:'库存',objectType:'inventory',fields:['sku','quantity','warehouse'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'inventory'}
 assert.deepEqual(readBusinessConfigurationCandidateV2(candidate),candidate)
})
test('数值声明仅作用于number，拒绝错误标志、非有限下限及未知别名',()=>{
 for(const patch of [{integer:false},{integer:1},{minimum:'0'},{minimum:Infinity},{minimum:NaN},{type:'text'},{type:'duration'},{min:0}])assert.throws(()=>readBusinessObjectTypeDefinitionVersioned(definition(undefined,{...quantity,...patch})),{code:'teloa/invalid-input'})
})
