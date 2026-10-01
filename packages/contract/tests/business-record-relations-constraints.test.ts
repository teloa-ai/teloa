import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessObjectTypeDefinition,readBusinessObjectTypeDefinitionV2,readBusinessRichFieldDefinition,readBusinessRichFieldValue,encodeBusinessRichFieldValue,readBusinessConfigurationCandidateV2,assertBusinessViewV2References} from '../src/index.ts'
import {businessObjectTypeV2LegacyShape} from '../src/business-definitions-v2.ts'
import * as contract from '../src/index.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const scope='business_0123456789abcdef0123456789abcdef'
const relation={format:'teloa.business-rich-field/v2' as const,name:'customers',label:'关联客户',from:'原客户',required:false,type:'multi-reference' as const,referenceType:'customer'}
const text={name:'code',label:'编号',from:'原编号',required:false,type:'text' as const}
const object={format:'teloa.business-object-type/v2' as const,id:'project',version:'1.0.0',domain:scope,title:'项目',unit:'项',lead:'客户交付',sourceId:'records',fields:[text,relation],constraints:{uniqueFields:['code','customers']}}
const uniqueKeys=(definition:unknown,fields:readonly {label:string;value:string}[])=>{
 const fn=(contract as unknown as {businessRecordUniqueKeys?:(definition:unknown,fields:readonly {label:string;value:string}[])=>{field:string;key:string}[]}).businessRecordUniqueKeys
 assert.equal(typeof fn,'function','必须公开唯一值纯语义而非由各消费端重复实现')
 return fn!(definition,fields)
}

test('多关联严格声明和规范ID集合，不在旧单ID里编码数组',()=>{
 assert.deepEqual(readBusinessRichFieldDefinition(relation),relation)
 const raw=encodeBusinessRichFieldValue(relation,['客户-乙','client-a'])
 assert.equal(raw,'["client-a","客户-乙"]')
 assert.deepEqual(readBusinessRichFieldValue(relation,raw),{type:'multi-reference',ids:['client-a','客户-乙'],canonical:raw})
 assert.equal(readBusinessRichFieldValue(relation,''),undefined)
 assert.throws(()=>readBusinessRichFieldValue({...relation,required:true},''),invalid)
 assert.throws(()=>readBusinessObjectTypeDefinition({...object,format:'teloa.business-object-type/v1'}),invalid)
})

test('多关联拒绝重复/危险ID/乱序/空集合/JSON变体/数量和编码长度越界',()=>{
 for(const raw of ['["b","a"]','["a","a"]','["a",1]','[]','["<script>"]','[" a"]',' ["a"]','["a", "b"]','{"ids":["a"]}'])assert.throws(()=>readBusinessRichFieldValue(relation,raw),invalid,raw)
 for(const input of [['a','a'],[],Array.from({length:33},(_,i)=>'client-'+i),Array.from({length:11},(_,i)=>String(i).padStart(2,'0')+'a'.repeat(198))])assert.throws(()=>encodeBusinessRichFieldValue(relation,input),invalid)
 for(const declaration of [{...relation,values:['a','b']},{...relation,referenceType:''},{...relation,referenceType:'unknown type'},{...relation,referenceScope:scope},{...relation,maxItems:64}])assert.throws(()=>readBusinessRichFieldDefinition(declaration),invalid)
})

test('v2独立唯一字段严格指向稳定name，旧形状和legacy影子无额外constraints',()=>{
 const parsed=readBusinessObjectTypeDefinitionV2(object)
 assert.deepEqual(parsed,object)
 const {constraints:_,...unconstrained}=object
 assert.deepEqual(readBusinessObjectTypeDefinitionV2(unconstrained),unconstrained)
 assert.equal(Object.hasOwn(businessObjectTypeV2LegacyShape(parsed),'constraints'),false)
 const tags={format:'teloa.business-rich-field/v2' as const,name:'tags',label:'标签',from:'标签',required:false,type:'multi-enum' as const,values:['a','b']}
 for(const candidate of [{...object,constraints:undefined},{...object,constraints:{uniqueFields:[]}},{...object,constraints:{uniqueFields:['code','code']}},{...object,constraints:{uniqueFields:['unknown']}},{...object,constraints:{uniqueFields:['code'],extra:true}},{...object,fields:[text,tags],constraints:{uniqueFields:['tags']}}])assert.throws(()=>readBusinessObjectTypeDefinitionV2(candidate),invalid)
})

test('唯一值用稳定name分组，多关联每目标各占一份，可选空值不占用',()=>{
 const raw=encodeBusinessRichFieldValue(relation,['client-b','client-a'])
 const values=uniqueKeys(object,[{label:'原编号',value:'P-1'},{label:'原客户',value:raw}])
 assert.deepEqual(values.map(item=>item.field),['code','customers','customers'])
 assert.equal(new Set(values.filter(item=>item.field==='customers').map(item=>item.key)).size,2)
 assert.deepEqual(uniqueKeys(object,[]),[])
 assert.deepEqual(uniqueKeys({...object,fields:[{...text,label:'客户项目编号'},{...relation,label:'客户名称'}]},[{label:'原编号',value:'P-1'},{label:'原客户',value:raw}]),values)
 const {constraints:_,...withoutConstraints}=object
 assert.deepEqual(uniqueKeys(withoutConstraints,[]),[])
})

test('数字布尔时长唯一键按真实语义匹配，money不以浮点或跨币种合并',()=>{
 const field=(type:'number'|'boolean'|'duration')=>({...text,type})
 const def=(type:'number'|'boolean'|'duration')=>({...object,fields:[field(type)],constraints:{uniqueFields:['code']}})
 const keys=(type:'number'|'boolean'|'duration',value:string)=>uniqueKeys(def(type),[{label:'原编号',value}])
 assert.deepEqual(keys('number','1'),keys('number','1.0'))
 assert.deepEqual(keys('number','-0'),keys('number','+0'))
 assert.deepEqual(keys('boolean','true'),keys('boolean','TRUE'))
 assert.deepEqual(keys('duration','PT1M'),keys('duration','60'))
 const money={format:'teloa.business-rich-field/v2' as const,name:'amount',label:'金额',from:'原金额',required:false,type:'money' as const,currencies:['CNY','SGD']}
 const moneyDef={...object,fields:[money],constraints:{uniqueFields:['amount']}}
 const amount=(currency:string,decimal:string)=>uniqueKeys(moneyDef,[{label:'原金额',value:encodeBusinessRichFieldValue(money,{currency,decimal})}])
 assert.notDeepEqual(amount('CNY','9007199254740993.01'),amount('CNY','9007199254740993.02'))
 assert.notDeepEqual(amount('CNY','1'),amount('SGD','1'))
})

test('无约束的旧v1/v2返回空占用，不给既有数据增写语义',()=>{
 const v1={...object,format:'teloa.business-object-type/v1',fields:[text]}
 delete (v1 as {constraints?:unknown}).constraints
 assert.deepEqual(uniqueKeys(v1,[{label:'原编号',value:'P-1'}]),[])
 const v2={...object,fields:[text]}
 delete (v2 as {constraints?:unknown}).constraints
 assert.deepEqual(uniqueKeys(v2,[{label:'原编号',value:'P-1'}]),[])
})

test('配置版本化读取完整保留新关系/约束，统计只支持真实目标身份的条件筛选',()=>{
 const candidate={format:'teloa.business-configuration/v2',scope,title:'客户项目',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:object}],pages:[{id:'projects',title:'项目',kind:'records',objectType:'project',fields:['code','customers'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'projects'}
 assert.deepEqual(readBusinessConfigurationCandidateV2(candidate),candidate)
 const view={format:'teloa.business-view/v2' as const,id:'count',version:'1.0.0',domain:scope,title:'客户项目数',kind:'board-card' as const,chart:'number' as const,objectType:'project',measures:[{id:'total',label:'项目',aggregation:'count' as const}],filters:[{field:'customers',op:'contains' as const,values:['client-a']}],limit:1}
 assert.doesNotThrow(()=>assertBusinessViewV2References(view,object))
 assert.doesNotThrow(()=>assertBusinessViewV2References({...view,filters:[{...view.filters[0]!,op:'overlaps',values:['client-a','客户-乙']}]},object))
 for(const candidate of [{...view,filters:[{...view.filters[0]!,values:['<unsafe>']}]},{...view,filters:[{...view.filters[0]!,op:'eq'}]},{...view,kind:'distribution',chart:'bar',dimension:{field:'customers',limit:2}},{...view,measures:[{id:'sum',label:'不能把客户ID当数字',aggregation:'sum',field:'customers'}]}])assert.throws(()=>assertBusinessViewV2References(candidate as typeof view,object),invalid)
})
