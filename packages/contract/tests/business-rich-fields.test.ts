import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {businessDefinitionCanonicalBody,readBusinessObjectTypeDefinition} from '../src/business-definitions.ts'
import {readBusinessConfigurationCandidate} from '../src/business-configuration.ts'
import {readBusinessRichFieldDefinition,readBusinessRichFieldValue,encodeBusinessRichFieldValue,type BusinessRichMoneyFieldDefinition,type BusinessRichMultiEnumFieldDefinition} from '../src/index.ts'

const rich={readBusinessRichFieldDefinition,readBusinessRichFieldValue,encodeBusinessRichFieldValue}
const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const money:BusinessRichMoneyFieldDefinition={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'金额',required:true,type:'money',currencies:['CNY','SGD']}
const tags:BusinessRichMultiEnumFieldDefinition={format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'标签',required:false,type:'multi-enum',values:['vip','priority','renewal']}

test('v2 富字段契约公开严格声明和值编解码入口',()=>{
 assert.deepEqual(rich.readBusinessRichFieldDefinition(money),money)
 assert.deepEqual(rich.readBusinessRichFieldDefinition(tags),tags)
})

test('v2 声明拒绝未知键、混用约束、重复取值及无效稳定键',()=>{
 const cases=[
  {...money,format:'teloa.business-rich-field/v1'},
  {...money,unexpected:true},
  {...money,name:'Amount'},
  {...money,from:'金额\n来源'},
  {...money,required:'yes'},
  {...money,currencies:[]},
  {...money,currencies:['CNY','CNY']},
  {...money,currencies:['cny']},
  {...money,currencies:Array.from({length:17},(_,i)=>`A${String(i).padStart(2,'0')}`)},
  {...money,values:['vip','priority']},
  {...tags,values:['vip']},
  {...tags,values:['vip','vip']},
  {...tags,currencies:['CNY']},
  {...tags,type:'unknown'},
 ]
 for(const [index,value] of cases.entries())assert.throws(()=>rich.readBusinessRichFieldDefinition(value),invalid,'第 '+index+' 项须拒绝')
})

test('金额用 bigint 保留超过安全整数的精度，编码与解析得到同一规范串',()=>{
 const value=rich.encodeBusinessRichFieldValue(money,{currency:'CNY',decimal:'9007199254740993.01'})
 assert.equal(value,'{"currency":"CNY","decimal":"9007199254740993.01"}')
 assert.deepEqual(rich.readBusinessRichFieldValue(money,value),{type:'money',currency:'CNY',decimal:'9007199254740993.01',scaled:90071992547409930100n,canonical:value})
 const negative='{"currency":"SGD","decimal":"-0.0001"}'
 assert.deepEqual(rich.readBusinessRichFieldValue(money,negative),{type:'money',currency:'SGD',decimal:'-0.0001',scaled:-1n,canonical:negative})
})

test('金额拒绝浮点近似、非规范十进制、币种不匹配和 JSON 变体',()=>{
 const decimals=['1e3','01','1.2300','1.0000','1.00001','-0','-0.0','+1','.5','1234567890123456789','NaN']
 for(const decimal of decimals)assert.throws(()=>rich.encodeBusinessRichFieldValue(money,{currency:'CNY',decimal}),invalid,decimal)
 for(const value of [
  '{"decimal":"1","currency":"CNY"}',
  '{ "currency":"CNY","decimal":"1"}',
  '{"currency":"USD","decimal":"1"}',
  '{"currency":"CNY","decimal":1}',
  '{"currency":"CNY","decimal":"1","extra":true}',
  '{"currency":"CNY","currency":"SGD","decimal":"1"}',
  '1',
 ])assert.throws(()=>rich.readBusinessRichFieldValue(money,value),invalid,value)
})

test('缺失与零不同：可选字段可缺省，必填字段不能缺省',()=>{
 assert.equal(rich.readBusinessRichFieldValue({...money,required:false},undefined),undefined)
 assert.equal(rich.readBusinessRichFieldValue(tags,''),undefined)
 assert.throws(()=>rich.readBusinessRichFieldValue(money,undefined),invalid)
 assert.throws(()=>rich.readBusinessRichFieldValue(money,''),invalid)
 const zero='{"currency":"CNY","decimal":"0"}'
 assert.deepEqual(rich.readBusinessRichFieldValue(money,zero),{type:'money',currency:'CNY',decimal:'0',scaled:0n,canonical:zero})
})

test('多选编码按声明顺序固定，解析拒绝乱序、重复、未知及空集合',()=>{
 const value=rich.encodeBusinessRichFieldValue(tags,['priority','vip'])
 assert.equal(value,'["vip","priority"]')
 assert.deepEqual(rich.readBusinessRichFieldValue(tags,value),{type:'multi-enum',values:['vip','priority'],canonical:value})
 for(const candidate of ['["priority","vip"]','["vip","vip"]','["unknown"]','[]','["vip",1]',' ["vip"]','["vip","priority","renewal","vip"]'])assert.throws(()=>rich.readBusinessRichFieldValue(tags,candidate),invalid,candidate)
 assert.throws(()=>rich.encodeBusinessRichFieldValue(tags,['vip','vip']),invalid)
 assert.throws(()=>rich.encodeBusinessRichFieldValue(tags,['unknown']),invalid)
})

test('旧 v1 对象定义拒绝富字段，旧声明规范哈希保持固定',()=>{
 const scope='business_0123456789abcdef0123456789abcdef'
 const old={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:'records',fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const hash=createHash('sha256').update(businessDefinitionCanonicalBody(readBusinessObjectTypeDefinition(old))).digest('hex')
 assert.equal(hash,'cc71f08bea4221bc1db6b9c29e4b3af9b9be5a5d10c19f003f534cb70200059a')
 const malformed={...old,fields:[{name:money.name,label:money.label,type:money.type,required:money.required,from:money.from,currencies:money.currencies}]}
 assert.throws(()=>readBusinessObjectTypeDefinition(malformed),invalid)
 assert.throws(()=>readBusinessConfigurationCandidate({format:'teloa.business-configuration/v1',scope,title:'我的业务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:malformed}],pages:[]}),invalid)
})
