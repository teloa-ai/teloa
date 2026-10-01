import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessObjectTypeDefinitionV2,BusinessObjectSnapshot} from '@teloa/contract'
import {BusinessRecordFlow,businessRichRecordDisplay} from '../src/client/business-record-flow.ts'
const field={format:'teloa.business-rich-field/v2' as const,name:'customers',label:'客户',from:'客户关联',type:'multi-reference' as const,referenceType:'customer',required:true}
const definition:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',domain:'sales',id:'order',version:'1.0.0',sourceId:'records',title:'订单',unit:'条',lead:'订单',fields:[field],constraints:{uniqueFields:['customers']}}
const rights={create:true,edit:true,archive:true},original='["customer-a","customer-b"]',stamp='2026-09-30T00:00:00.000Z'
const base:BusinessObjectSnapshot={scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64),title:'订单一',summary:'',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[{label:'客户关联',value:original}]}
function fixture(){let raw:string|null=null,mode='conflict';const writes:unknown[]=[],receipts=new Map<string,BusinessObjectSnapshot>();const api={async create(input:{requestId:string;title:string;summary?:string;fields:{name:string;value:string}[]}){writes.push(input);if(mode==='unique')throw Object.assign(Error('occupied'),{code:'teloa/conflict',details:{field:'customers',reason:'unique-field'}});const result={...base,title:input.title,summary:input.summary??'',fields:[{label:'客户关联',value:input.fields[0]!.value}]};if(mode==='before')throw Error('offline');receipts.set(input.requestId,result);if(mode==='lost')throw Error('lost');return result},async edit(){throw Object.assign(Error('changed'),{code:'teloa/version-conflict'})},async archive(){throw Error('unused')},async receipt(input:{requestId:string}){return receipts.get(input.requestId)??null},async get(){return base},async list(){return {schema:'teloa.business-data-page/v1' as const,sourceId:'records',capturedAt:stamp,items:[]}}};const journal=()=>({read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}),make=()=>new BusinessRecordFlow(api,()=>'11111111-1111-4111-8111-111111111111',journal).forTarget('sales','order'),session=make();session.configure(definition,rights);return {session,make,writes,setMode:(value:string)=>{mode=value}}}

test('多关联目标声明改变冻结完整原数组；唯一声明改变同样禁止旧表单提交',()=>{
 const {constraints:_,...withoutConstraints}=definition
 for(const next of [{...definition,fields:[{...field,referenceType:'project'}]},withoutConstraints]){
  const f=fixture();f.session.edit(base);f.session.configure(next,rights)
  assert.equal(f.session.getSnapshot().phase,'schema-changed');assert.throws(()=>f.session.changeField('customers','["customer-c"]'));assert.equal(f.session.getSnapshot().form!.values.customers,original)
 }
})
test('版本冲突冻结整个多关联数组直到明确采用比较版本',async()=>{
 const f=fixture();f.session.edit(base);await f.session.save();assert.equal(f.session.getSnapshot().phase,'conflict');assert.throws(()=>f.session.changeField('customers','["customer-c"]'));assert.equal(f.session.getSnapshot().form!.values.customers,original);await f.session.compare();f.session.useComparedVersion();f.session.changeField('customers','["customer-c"]');assert.equal(f.session.getSnapshot().form!.values.customers,'["customer-c"]')
})
test('失回包恢复保留完整多关联原稿，成功回执优先于后续目标与唯一声明变化',async()=>{
 const f=fixture();f.session.create();f.session.change('title','订单二');f.session.changeField('customers',original);f.setMode('lost');await f.session.save();const restored=f.make();restored.configure({...definition,fields:[{...field,referenceType:'project'}]},rights);assert.equal(restored.getSnapshot().form!.values.customers,original);assert.throws(()=>restored.changeField('customers',''));await restored.recover();assert.equal(restored.getSnapshot().phase,'saved');assert.equal(f.writes.length,1);assert.equal(restored.getSnapshot().result!.fields[0]!.value,original)
})
test('非法多关联历史值不能降级显示原ID或JSON',()=>{
 assert.equal(businessRichRecordDisplay(field,'["private-id",broken]'),'—');assert.equal(businessRichRecordDisplay(field,original),'—')
})

test('多关联增删统一编码，拒绝必填清空、33项和超2000字符；非法原稿不能静默替换',async()=>{
 const helpers=await import('../src/client/business-record-reference.ts')
 assert.equal(typeof helpers.businessMultiReferenceChange,'function')
 assert.deepEqual(helpers.businessReferenceSelection(field,original),['customer-a','customer-b']);assert.equal(helpers.businessMultiReferenceChange(field,original,'customer-c','add'),'["customer-a","customer-b","customer-c"]');assert.equal(helpers.businessMultiReferenceChange(field,original,'customer-a','remove'),'["customer-b"]');assert.throws(()=>helpers.businessMultiReferenceChange(field,'["customer-a"]','customer-a','remove'));assert.throws(()=>helpers.businessMultiReferenceChange(field,original,'','clear'));assert.equal(helpers.businessMultiReferenceChange({...field,required:false},original,'','clear'),'')
 assert.throws(()=>helpers.businessMultiReferenceChange(field,JSON.stringify(Array.from({length:32},(_,i)=>'c-'+String(i).padStart(2,'0'))),'c-extra','add'));const long=JSON.stringify(Array.from({length:10},(_,i)=>'x'.repeat(190)+i));assert.ok(long.length<2000);assert.throws(()=>helpers.businessMultiReferenceChange(field,long,'y'.repeat(100),'add'));assert.equal(helpers.businessReferenceSelection(field,'["private-id",broken]'),undefined);assert.throws(()=>helpers.businessMultiReferenceChange(field,'["private-id",broken]','customer-c','add'))
})

test('服务明确唯一冲突保留全部选择并定位不可重复字段，不进入未知重送路径',async()=>{
 const f=fixture();f.session.create();f.session.change('title','订单二');f.session.changeField('customers',original);f.setMode('unique');await f.session.save();assert.equal(f.session.getSnapshot().phase,'error');assert.equal(f.session.getSnapshot().errors.customers,'unique');assert.equal(f.session.getSnapshot().form!.values.customers,original);assert.equal(f.session.getSnapshot().pending,undefined)
})
