import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessRecordFlow,businessRecordErrors} from '../src/client/business-record-flow.ts'
import type {BusinessObjectTypeDefinition,BusinessObjectSnapshot} from '@teloa/contract'
import {BusinessReferenceReader,readBusinessReference,readBusinessReferencePage} from '../src/client/business-record-reference.ts'
const definition:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',domain:'sales',id:'order',version:'1.0.0',sourceId:'records',title:'订单',unit:'条',lead:'订单',fields:[{name:'customer',label:'客户',from:'客户关联',type:'reference',referenceType:'customer',required:true}]}
const rights={create:true,edit:true,archive:true},stamp='2026-09-30T00:00:00.000Z'
const snapshot=(id='customer-one',type='customer'):BusinessObjectSnapshot=>({scope:'sales',type,id,version:1,snapshotHash:'a'.repeat(64),title:'客户甲',summary:'',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]})
function fixture(){let stored:string|null=null,mode='before';const calls:any[]=[],api:any={create:async(input:any)=>{calls.push(input);if(mode==='before')throw Error('offline');if(mode==='reject')throw Object.assign(Error('forbidden'),{code:'teloa/forbidden'});return {...snapshot('order-one','order'),title:input.title,summary:input.summary,fields:[{label:'客户关联',value:input.fields[0].value}]}},receipt:async()=>null,list:async()=>{},get:async()=>{},edit:async()=>{},archive:async()=>{}};const journal=()=>({read:()=>stored,write:(raw:string)=>{stored=raw},clear:()=>{stored=null}});const flow=new BusinessRecordFlow(api,()=> '11111111-1111-4111-8111-111111111111',journal),session=flow.forTarget('sales','order');session.configure(definition,rights);return {flow,session,calls,api,journal,setMode:(value:string)=>{mode=value},stored:()=>stored}}
test('合法单选关联允许新建编辑，只保存原ID；未知重建与重试保留旧定义及原正文',async()=>{const f=fixture();assert.doesNotThrow(()=>f.session.create());f.session.change('title','订单一');f.session.changeField('customer','customer-one');await f.session.save();assert.equal(f.session.getSnapshot().phase,'unknown');assert.equal(f.calls[0].fields[0].value,'customer-one');assert.throws(()=>f.session.changeField('customer','customer-two'));const restored=new BusinessRecordFlow(f.api,undefined,f.journal).forTarget('sales','order');restored.configure({...definition,fields:[{...definition.fields[0]!,referenceType:'project'}]},rights);const restoredField=restored.getSnapshot().form?.definition.fields[0];assert.ok(restoredField?.type==='reference');assert.equal(restoredField.referenceType,'customer');assert.equal(restored.getSnapshot().form?.values.customer,'customer-one');await restored.recover();await restored.retry();assert.equal(f.calls.length,1);assert.equal(restored.getSnapshot().errorCode,'teloa/schema-changed');restored.configure(definition,rights);f.setMode('ok');await restored.retry();assert.equal(restored.getSnapshot().phase,'saved');assert.deepEqual(f.calls[0],f.calls[1]);restored.edit({...snapshot('order-one','order'),fields:[{label:'客户关联',value:'customer-one'}]});assert.equal(restored.getSnapshot().form?.values.customer,'customer-one')})
test('明确拒绝仍保留ID草稿，必填和非法关联值定位字段',async()=>{const f=fixture();f.session.create();f.session.change('title','订单二');await f.session.save();assert.equal(f.session.getSnapshot().errors.customer,'required');f.session.changeField('customer','bad\nvalue');assert.equal(businessRecordErrors(definition,f.session.getSnapshot().form!).customer,'invalid');f.session.changeField('customer','customer-one');f.setMode('reject');await f.session.save();assert.equal(f.session.getSnapshot().phase,'error');assert.equal(f.session.getSnapshot().form?.values.customer,'customer-one')})
test('关联只读边界核对固定范围类型身份；非法ID不请求且错误正文不进入展示',async()=>{
 const target={scope:'sales',type:'customer',id:'customer-one'},signal=new AbortController().signal
 let count=0
 const invalid=await readBusinessReference({get:async()=>{count++;return snapshot()}},{...target,id:'bad\nvalue'},signal)
 assert.deepEqual(invalid,{status:'unavailable'});assert.equal(count,0)
 for(const result of [{...snapshot(),scope:'SOC'},snapshot('customer-two'),snapshot('customer-one','project'),{...snapshot(),title:''}])assert.deepEqual(await readBusinessReference({get:async()=>result},target,signal),{status:'unavailable'})
 for(const [code,status] of [['teloa/forbidden','forbidden'],['teloa/not-found','unavailable'],['teloa/invalid-host-response','unavailable'],['network','failed']])assert.deepEqual(await readBusinessReference({get:async()=>{throw Object.assign(Error('private ID'),{code})}},target,signal),{status})
 assert.deepEqual(await readBusinessReference({get:async()=>({...snapshot(),deletedAt:stamp})},target,signal),{status:'archived'})
 const ready=await readBusinessReference({get:async()=>snapshot()},target,signal);assert.equal(ready.status,'ready');assert.ok(!('fields'in ('record'in ready?ready.record:{})))
})
test('关联读取重试清除旧标题，迟到与已卸载读取不能恢复已撤权限标题',async()=>{
 let release!:(result:BusinessObjectSnapshot)=>void,count=0
 const api={get:async()=>++count===1?new Promise<BusinessObjectSnapshot>(resolve=>release=resolve):Promise.reject(Object.assign(Error('private'),{code:'teloa/forbidden'}))}
 const reader=new BusinessReferenceReader(api,{scope:'sales',type:'customer',id:'customer-one'})
 const first=reader.read();await reader.read();assert.deepEqual(reader.getSnapshot(),{status:'forbidden'});release(snapshot());await first;assert.deepEqual(reader.getSnapshot(),{status:'forbidden'})
 const dead=new BusinessReferenceReader({get:async()=>new Promise<BusinessObjectSnapshot>(resolve=>release=resolve)},{scope:'sales',type:'customer',id:'customer-one'});const pending=dead.read();dead.dispose();release(snapshot());assert.equal(await pending,undefined);assert.deepEqual(dead.getSnapshot(),{status:'loading'})
})
test('分页只读固定scope/type、去掉目标正文，拒绝重复游标和超请求条数',async()=>{
 const inputs:any[]=[],signal=new AbortController().signal,page={schema:'teloa.business-data-page/v1' as const,sourceId:'target-source',capturedAt:stamp,items:[snapshot()],nextCursor:'second'}
 const api={list:async(input:any)=>{inputs.push(input);return page}}
 const result=await readBusinessReferencePage(api,'sales','customer',signal);assert.deepEqual(inputs[0],{scope:'sales',type:'customer',limit:20});assert.ok(!('fields'in result.items[0]!));assert.equal(result.nextCursor,'second')
 await assert.rejects(readBusinessReferencePage(api,'sales','customer',signal,'second'))
 await assert.rejects(readBusinessReferencePage({list:async()=>({...page,items:[snapshot('one','project')]})},'sales','customer',signal))
 await assert.rejects(readBusinessReferencePage({list:async()=>({...page,items:Array.from({length:21},(_,index)=>snapshot('target-'+index))})},'sales','customer',signal))
})
