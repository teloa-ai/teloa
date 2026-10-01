import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessObjectSnapshot,BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import {BusinessRecordFlow,businessRecordErrors,businessMoneyInput,businessMoneyValue,businessRichRecordDisplay} from '../src/client/business-record-flow.ts'

const scope='business_0123456789abcdef0123456789abcdef'
const money:Extract<BusinessObjectTypeDefinitionV2['fields'][number],{type:'money'}>={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'原金额',type:'money',required:false,currencies:['CNY','USD']}
const tags:Extract<BusinessObjectTypeDefinitionV2['fields'][number],{type:'multi-enum'}>={format:'teloa.business-rich-field/v2',name:'tags',label:'业务方向',from:'原方向',type:'multi-enum',required:true,values:['云安全','应用安全','合规']}
const definition:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',domain:scope,id:'customer',version:'1.0.0',sourceId:'records',title:'客户',unit:'位',lead:'客户跟进',fields:[money,tags]}
const amount='{"currency":"CNY","decimal":"9007199254740993.01"}',selected='["云安全","合规"]'
const rights={create:true,edit:true,archive:true},id='11111111-1111-4111-8111-111111111111'
function fixture(){
 const writes:any[]=[],receipts=new Map<string,BusinessObjectSnapshot>();let offline=false,lost=false,raw:string|null=null
 const api={async create(input:any){writes.push(input);if(offline)throw Error('offline');const result:BusinessObjectSnapshot={scope,type:'customer',id:'customer-one',version:1,snapshotHash:'a'.repeat(64),title:input.title,summary:input.summary,source:'本地记录',observedAt:'2026-09-30T00:00:00.000Z',receivedAt:'2026-09-30T00:00:00.000Z',quality:'complete',fields:input.fields.filter((field:any)=>field.value!=='').map((field:any)=>({label:definition.fields.find(f=>f.name===field.name)!.from,value:field.value}))};receipts.set(input.requestId,result);if(lost)throw Error('lost');return result},async edit(){throw Error('not used')},async archive(){throw Error('not used')},async receipt(input:any){return receipts.get(input.requestId)??null},async get(){throw Error('not used')},async list(){return {schema:'teloa.business-data-page/v1' as const,sourceId:'records',capturedAt:'2026-09-30T00:00:00.000Z',items:[]}}}
 const journal=()=>({read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}})
 const create=()=>new BusinessRecordFlow(api,()=>id,journal).forTarget(scope,'customer'),session=create();session.configure(definition,rights)
 return {session,create,writes,journal:()=>raw,setOffline:(value:boolean)=>{offline=value},setLost:(value:boolean)=>{lost=value}}
}

test('金额输入和展示不经浮点数；规范化只在用户编辑时发生，非法历史原文保留',()=>{
 assert.equal(businessMoneyValue(money,'CNY','9007199254740993.0100'),amount)
 assert.equal(businessMoneyValue(money,'CNY','-0.0000'),'{"currency":"CNY","decimal":"0"}')
 assert.deepEqual(businessMoneyInput(money,amount),{currency:'CNY',amount:'9007199254740993.01'})
 assert.equal(businessRichRecordDisplay(money,amount),'CNY 9007199254740993.01')
 assert.equal(businessRichRecordDisplay(tags,selected),'云安全、合规')
 const noncanonical='{"decimal":"1.00","currency":"CNY"}'
 assert.deepEqual(businessMoneyInput(money,noncanonical),{currency:'CNY',amount:'',raw:noncanonical})
 assert.equal(businessRichRecordDisplay(money,noncanonical),noncanonical)
})

test('富字段表单复用契约拒绝错币种、非规范正文、乱序多选和空必填；不影响精确合法数',()=>{
 const f=fixture();f.session.create();f.session.change('title','客户甲')
 for(const [value,invalidField] of [[amount,'tags'],[' {"currency":"CNY","decimal":"1"}','amount'],['{"currency":"EUR","decimal":"1"}','amount']] as const){f.session.changeField('amount',value);if(invalidField==='amount')f.session.changeField('tags',selected);assert.ok(businessRecordErrors(definition,f.session.getSnapshot().form!)[invalidField])}
 f.session.changeField('amount',amount);f.session.changeField('tags','["合规","云安全"]');assert.equal(businessRecordErrors(definition,f.session.getSnapshot().form!).tags,'invalid')
 f.session.changeField('tags',selected);assert.deepEqual(businessRecordErrors(definition,f.session.getSnapshot().form!),{})
})

test('v2 保存和失回包恢复保留金额及多选精确字节；不再新建请求',async()=>{
 const f=fixture();f.session.create();f.session.change('title','客户甲');f.session.changeField('amount',amount);f.session.changeField('tags',selected);f.setLost(true)
 await f.session.save();assert.equal(f.session.getSnapshot().phase,'unknown');assert.equal(JSON.parse(f.journal()!).format,'teloa.business-record-request/v2')
 const restored=f.create();restored.configure(definition,rights);assert.equal(restored.getSnapshot().phase,'unknown');assert.equal(restored.getSnapshot().form!.values.amount,amount)
 await restored.recover();assert.equal(restored.getSnapshot().phase,'saved');assert.equal(f.writes.length,1);assert.equal(f.journal(),null)
 assert.deepEqual(restored.getSnapshot().result!.fields,[{label:'原金额',value:amount},{label:'原方向',value:selected}])
})

test('未受理重试使用同请求原正文；币种或多选声明改变必须先核对，不能重送旧定义',async()=>{
 const f=fixture();f.session.create();f.session.change('title','客户甲');f.session.changeField('amount',amount);f.session.changeField('tags',selected);f.setOffline(true);await f.session.save()
 const restored=f.create();restored.configure({...definition,fields:[{...money,currencies:['USD']},tags]},rights);await restored.recover();f.setOffline(false);await restored.retry()
 assert.equal(f.writes.length,1);assert.equal(restored.getSnapshot().errorCode,'teloa/schema-changed')
 restored.configure(definition,rights);await restored.retry();assert.equal(f.writes.length,2);assert.deepEqual(f.writes[1],f.writes[0]);assert.equal(restored.getSnapshot().phase,'saved')
})

test('字段更名保持 name/from，不影响 v2 原请求；可选金额空值不写入快照',async()=>{
 const f=fixture();f.session.create();f.session.change('title','客户甲');f.session.changeField('tags',selected)
 f.session.configure({...definition,fields:[{...money,label:'合同价值'},tags]},rights);await f.session.save()
 assert.equal(f.session.getSnapshot().phase,'saved');assert.deepEqual(f.session.getSnapshot().result!.fields,[{label:'原方向',value:selected}])
})
