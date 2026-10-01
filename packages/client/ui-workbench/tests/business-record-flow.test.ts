import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import type {BusinessObjectSnapshot,BusinessObjectTypeDefinition} from '@teloa/contract'
const source=new URL('../src/client/business-record-flow.ts',import.meta.url)
const definition:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',domain:'SOC',id:'ticket',version:'1.0.0',sourceId:'records',title:'工单',unit:'条',lead:'跟进事项',fields:[{name:'state',label:'状态',from:'original state',type:'enum',required:true,values:['open','done']}]}
const snapshot=(version=1):BusinessObjectSnapshot=>({scope:'SOC',type:'ticket',id:'record-one',version,snapshotHash:'a'.repeat(64),title:'工单一',summary:'说明',source:'本地记录',observedAt:'2026-09-29T00:00:00.000Z',receivedAt:'2026-09-29T00:00:00.000Z',quality:'complete',fields:[{label:'original state',value:'open'}]})
const rights={create:true,edit:true,archive:true}
async function fixture(){
 assert.ok(existsSync(source),'缺少固定请求和编辑恢复实现')
 const {BusinessRecordFlow}=await import('../src/client/business-record-flow.ts')
 const calls:Array<{op:string;input:any}>=[],receipts=new Map<string,BusinessObjectSnapshot>()
 let fail:'lost'|'before'|'conflict'|undefined,receiptFails=false,counter=0
 const resultFor=(input:any,version=1)=>({...snapshot(version),title:input.title??snapshot().title,summary:input.summary??snapshot().summary,fields:input.fields.filter((field:any)=>field.value!=='').map((field:any)=>({label:({state:'original state',title:'customer',num:'number',bool:'boolean'} as Record<string,string>)[field.name]??field.name,value:field.value}))})
 const api={
  async create(input:any){calls.push({op:'create',input});if(fail==='before')throw Error('网络断开');const result=resultFor(input);receipts.set(input.requestId,result);if(fail==='lost')throw Error('回包丢失');return result},
  async edit(input:any){calls.push({op:'edit',input});if(fail==='conflict')throw Object.assign(Error('已变更'),{code:'teloa/version-conflict'});return resultFor(input,input.expectedVersion+1)},
  async archive(input:any){calls.push({op:'archive',input});return {...snapshot(input.expectedVersion+1),deletedAt:'2026-09-29T01:00:00.000Z'}},
  async receipt(input:any){calls.push({op:'receipt',input});if(receiptFails)throw Error('仍离线');return receipts.get(input.requestId)??null},
  async get(input:any){calls.push({op:'get',input});return snapshot(input.version??3)},
  async list(){return {schema:'teloa.business-data-page/v1' as const,sourceId:'records',capturedAt:'2026-09-29T00:00:00.000Z',items:[]}},
 }
 const flow=new BusinessRecordFlow(api,()=> '12345678-1234-4234-8234-'+String(++counter).padStart(12,'0')),session=flow.forTarget('SOC','ticket')
 session.configure(definition,rights)
 return {flow,session,calls,api,setFail:(value:typeof fail)=>{fail=value},setReceiptFail:(value:boolean)=>{receiptFails=value}}
}
test('新增失回包只查原回执；双击与切换业务不重复创建',async()=>{
 const f=await fixture();f.session.create();f.session.change('title','第一条');f.session.change('state','open');f.setFail('lost')
 await Promise.all([f.session.save(),f.session.save()])
 assert.equal(f.calls.filter(x=>x.op==='create').length,1)
 assert.equal(f.session.getSnapshot().phase,'unknown')
 assert.throws(()=>f.session.change('title','改投'),/在途|未知/)
 const other=f.flow.forTarget('Other','ticket');assert.equal(other.getSnapshot().form,undefined)
 await f.session.recover()
 assert.equal(f.session.getSnapshot().result?.id,'record-one')
 assert.equal(f.calls.filter(x=>x.op==='create').length,1)
 assert.equal(f.calls.at(-1)?.input.requestId,f.calls[0]?.input.requestId)
})
test('未受理先查回执再按同请求原正文重递送；回执失败保持未知',async()=>{
 const f=await fixture();f.session.create();f.session.change('title','第一条');f.session.change('state','open');f.setFail('before');await f.session.save()
 f.setReceiptFail(true);await f.session.recover();assert.equal(f.session.getSnapshot().phase,'unknown')
 f.setReceiptFail(false);await f.session.recover();assert.equal(f.session.getSnapshot().phase,'retryable')
 f.setFail(undefined);await f.session.retry()
 const writes=f.calls.filter(x=>x.op==='create');assert.equal(writes.length,2);assert.deepEqual(writes[0]?.input,writes[1]?.input)
 assert.equal(f.calls.at(-2)?.op,'receipt')
})
test('CAS冲突保留原编辑与版本，重读比较不自动覆盖',async()=>{
 const f=await fixture();f.session.edit(snapshot());f.session.change('state','done');f.setFail('conflict');await f.session.save()
 assert.equal(f.session.getSnapshot().phase,'conflict');assert.equal(f.session.getSnapshot().form?.base?.version,1)
 await f.session.compare()
 assert.equal(f.session.getSnapshot().comparison?.version,3);assert.equal(f.session.getSnapshot().form?.values.state,'done');assert.equal(f.session.getSnapshot().form?.base?.version,1)
 f.session.useComparedVersion();f.setFail(undefined);await f.session.save()
 assert.equal(f.calls.filter(x=>x.op==='edit').at(-1)?.input.expectedVersion,3)
 assert.equal(f.calls.filter(x=>x.op==='edit').at(-1)?.input.fields[0].value,'done')
})
test('稳定name/from读取更名字段；schema变化拒绝旧编辑，reference允许原ID编辑',async()=>{
 const f=await fixture();f.session.edit(snapshot())
 f.session.configure({...definition,fields:[{...definition.fields[0]!,label:'新状态'}]},rights)
 assert.equal(f.session.getSnapshot().form?.values.state,'open');f.session.change('state','done');await f.session.save();assert.equal(f.calls[0]?.input.fields[0].name,'state')
 f.session.edit(snapshot());f.session.configure({...definition,fields:[{...definition.fields[0]!,type:'text'}]},rights);await f.session.save()
 assert.equal(f.session.getSnapshot().phase,'schema-changed');assert.equal(f.calls.filter(c=>c.op==='edit').length,1)
 f.session.cancel();f.session.configure({...definition,fields:[{name:'state',label:'状态',from:'original state',required:true,type:'reference',referenceType:'user'}]},rights)
 assert.doesNotThrow(()=>f.session.create());f.session.cancel()
 f.session.archive(snapshot());await f.session.save();assert.ok(f.session.getSnapshot().result?.deletedAt)
})
test('字段定位、实际能力、归档与历史读取保持原版本',async()=>{
 const f=await fixture();f.session.create();f.session.change('title','第一条');await f.session.save()
 assert.equal(f.session.getSnapshot().errors.state,'required');assert.equal(f.calls.length,0)
 f.session.cancel();f.session.configure(definition,{...rights,create:false});assert.throws(()=>f.session.create(),/只读|权限/)
 f.session.archive(snapshot());assert.equal(f.calls.length,0);await f.session.save()
 assert.equal(f.calls[0]?.input.expectedVersion,1);assert.ok(f.session.getSnapshot().result?.deletedAt)
 assert.equal((await f.api.get({scope:'SOC',type:'ticket',id:'record-one',version:1})).version,1)
})
test('journal重建保留原请求与正文；损坏或写入失败不发新请求',async()=>{
 const f=await fixture(),{BusinessRecordFlow}=await import('../src/client/business-record-flow.ts')
 const data=new Map<string,string>(),journal=(scope:string,type:string)=>({read:()=>data.get(scope+type)??null,write:(value:string)=>{data.set(scope+type,value)},clear:()=>{data.delete(scope+type)}})
 const first=new BusinessRecordFlow(f.api,()=> '22345678-1234-4234-8234-123456789012',journal).forTarget('SOC','ticket')
 first.configure(definition,rights);first.create();first.change('title','原稿');first.change('state','open');f.setFail('before');await first.save()
 const restored=new BusinessRecordFlow(f.api,()=> '32345678-1234-4234-8234-123456789012',journal).forTarget('SOC','ticket');restored.configure(definition,rights)
 assert.equal(restored.getSnapshot().phase,'unknown');assert.equal(restored.getSnapshot().form?.title,'原稿')
 await restored.recover();f.setFail(undefined);await restored.retry()
 const writes=f.calls.filter(c=>c.op==='create');assert.deepEqual(writes[0]?.input,writes[1]?.input);assert.equal(data.size,0)
 data.set('SOCticket','broken')
 const broken=new BusinessRecordFlow(f.api,undefined,journal).forTarget('SOC','ticket');broken.configure(definition,rights);assert.throws(()=>broken.create(),/恢复|存储/);assert.throws(()=>broken.cancel(),/恢复|存储|未知/)
 const count=f.calls.length
 const unavailable=new BusinessRecordFlow(f.api,undefined,()=>({read:()=>null,write:()=>{throw Error('quota')},clear:()=>{}})).forTarget('SOC','ticket')
 unavailable.configure(definition,rights);unavailable.create();unavailable.change('title','新稿');unavailable.change('state','open');await unavailable.save()
 assert.equal(f.calls.length,count);assert.equal(unavailable.getSnapshot().phase,'recovery-error')
})
test('稳定字段title与记录标题分别编辑，不能互相覆盖',async()=>{
 const f=await fixture();f.session.configure({...definition,fields:[{name:'title',label:'客户称呼',from:'customer',type:'text',required:true}]},rights)
 f.session.create();f.session.change('title','记录标题');f.session.changeField('title','客户甲');await f.session.save()
 assert.equal(f.calls[0]?.input.title,'记录标题');assert.deepEqual(f.calls[0]?.input.fields,[{name:'title',value:'客户甲'}])
})
test('七类字段的非法值定位到控件；未知期间撤权与schema变化不能重送',async()=>{
 const f=await fixture(),fields:BusinessObjectTypeDefinition['fields']=[
  {name:'num',label:'数量',type:'number',required:true,from:'number'},
  {name:'when',label:'时间',type:'datetime',required:true,from:'when'},
  {name:'duration',label:'时长',type:'duration',required:true,from:'duration'},
  {name:'bool',label:'确认',type:'boolean',required:true,from:'boolean'},
 ]
 f.session.configure({...definition,fields},rights);f.session.create();f.session.change('title','严格值')
 for(const [name,value] of Object.entries({num:'NaN',when:'2026-02-30',duration:'P1M',bool:'maybe'}))f.session.changeField(name,value)
 await f.session.save();assert.deepEqual(Object.keys(f.session.getSnapshot().errors).sort(),['bool','duration','num','when']);assert.equal(f.calls.length,0)
 for(const [name,value] of Object.entries({num:'12.5',when:'2026-09-29T00:00:00.000Z',duration:'PT4H30M',bool:'false'}))f.session.changeField(name,value)
 f.setFail('before');await f.session.save();await f.session.recover()
 f.session.configure({...definition,fields},{...rights,create:false});await f.session.retry()
 assert.equal(f.calls.filter(c=>c.op==='create').length,1);assert.equal(f.session.getSnapshot().phase,'retryable')
 f.session.configure({...definition,fields:[...fields,{name:'newfield',label:'新增字段',type:'text',required:true,from:'new'}]},rights);await f.session.retry()
 assert.equal(f.calls.filter(c=>c.op==='create').length,1);assert.equal(f.session.getSnapshot().errorCode,'teloa/schema-changed')
})
test('时长以数值和单位无损往返，空值与不可无损转换的原值保留',async()=>{
 const {businessDurationInput,businessDurationValue}=await import('../src/client/business-record-flow.ts')
 assert.equal(typeof businessDurationInput,'function')
 assert.deepEqual(businessDurationInput('PT4H30M'),{amount:'4.5',unit:'hour'})
 assert.equal(businessDurationValue('4.5','hour'),'16200')
 assert.equal(businessDurationValue('2','hour'),'7200')
 assert.deepEqual(businessDurationInput('7200'),{amount:'2',unit:'hour'})
 assert.equal(businessDurationValue('','hour'),'')
 assert.equal(businessDurationValue('not a number','hour'),'not a number')
 assert.equal(businessDurationInput('P1M').raw,'P1M')
 assert.equal(businessDurationInput('PT0.1234567890123456789S').raw,'PT0.1234567890123456789S')
 assert.equal(businessDurationValue('0.1234567890123456789','second'),'0.1234567890123456789')
 const f=await fixture();f.session.configure({...definition,fields:[{name:'duration',label:'时长',from:'duration',type:'duration',required:false}]},rights)
 f.session.create();f.session.change('title','时长记录');f.session.changeField('duration',businessDurationValue('2','hour'));await f.session.save()
 assert.deepEqual(f.calls[0]?.input.fields,[{name:'duration',value:'7200'}])
})
test('空字符串journal拒绝恢复且不能取消或新建绕过',async()=>{
 const f=await fixture(),{BusinessRecordFlow}=await import('../src/client/business-record-flow.ts')
 for(const raw of ['',undefined]){
 const session=new BusinessRecordFlow(f.api,undefined,()=>({read:()=>raw as string,write:()=>{},clear:()=>{}})).forTarget('SOC','ticket')
 session.configure(definition,rights)
 assert.equal(session.getSnapshot().phase,'recovery-error')
 assert.throws(()=>session.cancel());assert.throws(()=>session.create());assert.equal(f.calls.length,0)
 }
})
test('直接成功和原回执都核对固定正文与原from，不匹配保留journal',async()=>{
 const {BusinessRecordFlow}=await import('../src/client/business-record-flow.ts')
 const original={...definition,fields:[{name:'duration',from:'elapsed',label:'时长',type:'duration' as const,required:true},{name:'optional',from:'note',label:'备注',type:'text' as const,required:false}]}
 for(const operation of ['create','edit'] as const)for(const wrong of ['title','summary','mapping','value','extra'] as const){
  const f=await fixture();let stored:string|null=null,result:BusinessObjectSnapshot
  const make=(input:any)=>({...snapshot(operation==='create'?1:2),title:input.title,summary:input.summary,fields:[{label:'elapsed',value:'PT4H30M'}]})
  const mutate=async(input:any)=>{result=make(input);return wrong==='title'?{...result,title:'他人标题'}:wrong==='summary'?{...result,summary:'他人正文'}:wrong==='mapping'?{...result,fields:[{label:'duration',value:'PT4H30M'}]}:wrong==='value'?{...result,fields:[{label:'elapsed',value:'PT2H'}]}:{...result,fields:[...result.fields,{label:'note',value:'凭空新增'}]}}
  f.api[operation]=mutate
  const journal=()=>({read:()=>stored,write:(value:string)=>{stored=value},clear:()=>{stored=null}})
  const session=new BusinessRecordFlow(f.api,undefined,journal).forTarget('SOC','ticket');session.configure(original,rights)
  if(operation==='create')session.create();else session.edit(snapshot())
  session.change('title','原标题');session.change('summary','原正文');session.changeField('duration','PT4H30M');await session.save()
  assert.equal(session.getSnapshot().phase,'unknown',operation+wrong);assert.ok(stored)
  const pending=session.getSnapshot().pending
  const wrongResult=await mutate((pending as any).input);f.api.receipt=async()=>wrongResult
  const restored=new BusinessRecordFlow(f.api,undefined,journal).forTarget('SOC','ticket');restored.configure({...original,fields:original.fields.map(field=>({...field,from:'changed-'+field.from}))},rights)
  await restored.recover();assert.equal(restored.getSnapshot().phase,'unknown');assert.ok(stored);assert.deepEqual(restored.getSnapshot().pending,pending)
  f.api.receipt=async()=>result!;await restored.recover();assert.equal(restored.getSnapshot().phase,'saved');assert.equal(stored,null)
 }
})
