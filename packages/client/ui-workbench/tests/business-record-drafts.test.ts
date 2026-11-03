import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessRecordFlow} from '../src/client/business-record-flow.ts'
import {createBusinessRecordDrafts} from '../src/client/business-record-drafts.ts'
import type {BusinessObjectSnapshot,BusinessObjectTypeDefinition} from '@teloa/contract'
const definition:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',domain:'SOC',id:'alert',version:'1.0.0',sourceId:'records',title:'告警',unit:'条',lead:'合成验收',fields:[{name:'count',label:'数量',from:'数量',type:'number',required:false}]}
const rights={create:true,edit:true,archive:true},stamp='2026-11-02T00:00:00.000Z'
const snapshot=(id:string,version=1):BusinessObjectSnapshot=>({scope:'SOC',type:'alert',id,version,snapshotHash:'a'.repeat(64),title:id,summary:'',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]})
const storageFor=(rows:Map<string,string>)=>({get length(){return rows.size},key:(index:number)=>[...rows.keys()][index]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}})
function fixture(){
 const rows=new Map<string,string>(),calls:unknown[]=[],receipts=new Map<string,BusinessObjectSnapshot>();let sequence=0,offline=false,quota=false
 const storage={...storageFor(rows),get length(){return rows.size},getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw Error('quota');rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const api={list:async()=>{throw Error('not used')},get:async()=>{throw Error('not used')},create:async()=>{throw Error('not used')},archive:async()=>{throw Error('not used')},edit:async(input:any)=>{calls.push(structuredClone(input));const result={...snapshot(input.id,input.expectedVersion+1),title:input.title,summary:input.summary,fields:input.fields.filter((f:any)=>f.value!=='').map((f:any)=>({label:'数量',value:f.value}))};receipts.set(input.requestId,result);if(offline)throw Error('lost');return result},receipt:async(input:any)=>{calls.push({receipt:input.requestId});return receipts.get(input.requestId)??null}}
 const make=(owner='owner-a',scope='SOC',type='alert')=>{
  const journal=(scope:string,type:string)=>{const key=owner+'/request/'+scope+'/'+type;return{read:()=>storage.getItem(key),write:(v:string)=>storage.setItem(key,v),clear:()=>storage.removeItem(key)}}
  const flow=new BusinessRecordFlow(api as any,()=>{sequence++;return '11111111-1111-4111-8111-'+String(sequence).padStart(12,'0')},journal,createBusinessRecordDrafts({namespace:owner,storage}))
  const session=flow.forTarget(scope,type);session.configure({...definition,domain:scope,id:type},rights);return session
 }
 return {rows,calls,make,get ids(){return sequence},setOffline:(value:boolean)=>{offline=value},setQuota:(value:boolean)=>{quota=value}}
}
test('原三告警草稿分别归属记录；关闭、换记录、重建 flow 后恢复且零请求',()=>{
 const f=fixture(),session=f.make()
 for(const id of ['alert-a','alert-b','alert-c']){session.edit(snapshot(id));session.change('summary','未提交-'+id);session.cancel()}
 for(const id of ['alert-c','alert-a','alert-b']){const restored=f.make();restored.edit(snapshot(id));assert.equal(restored.getSnapshot().form?.summary,'未提交-'+id);assert.equal(restored.getSnapshot().form?.base?.id,id)}
 assert.equal(f.calls.length,0);assert.equal(f.ids,0)
})
test('R2 成功回执清理遇到另一页交错写入，只结清原修订且新稿仍可恢复',()=>{
 const rows=new Map<string,string>(),base=storageFor(rows);let interleave:(()=>void)|undefined
 const fire=()=>{const fn=interleave;interleave=undefined;fn?.()}
 const storage={...base,get length(){return rows.size},getItem:(key:string)=>{const raw=base.getItem(key);fire();return raw},setItem:(key:string,value:string)=>{if(key.includes('/saved/'))fire();base.setItem(key,value)}}
 const a=createBusinessRecordDrafts({namespace:'race-owner',storage}),b=createBusinessRecordDrafts({namespace:'race-owner',storage})
 const form={kind:'edit' as const,title:'A',summary:'已提交A',values:{},schema:JSON.stringify(['SOC','alert','records',[['count','数量','number',false,null,null]]]),definition,base:{id:'alert-a',version:1}}
 const expected=a.write('SOC','alert',form);b.read('SOC','alert',form)
 interleave=()=>{b.write('SOC','alert',{...form,summary:'B交错写入的新稿'})};a.clearMatching('SOC','alert',form,expected)
 assert.equal(createBusinessRecordDrafts({namespace:'race-owner',storage:base}).read('SOC','alert',form)?.summary,'B交错写入的新稿')
})
test('R2 旧页只改标题不能覆盖另一页摘要；两个原稿持久保留并显式核对',()=>{
 const rows=new Map<string,string>(),storage=storageFor(rows),a=createBusinessRecordDrafts({namespace:'stale-owner',storage}),b=createBusinessRecordDrafts({namespace:'stale-owner',storage})
 const form={kind:'edit' as const,title:'A',summary:'旧摘要',values:{},schema:JSON.stringify(['SOC','alert','records',[['count','数量','number',false,null,null]]]),definition,base:{id:'alert-a',version:1}}
 a.write('SOC','alert',form);const old=a.read('SOC','alert',form)!;b.read('SOC','alert',form);b.write('SOC','alert',{...form,summary:'B的新摘要'})
 assert.throws(()=>a.write('SOC','alert',{...old,title:'A只改标题'}),error=>{const forms=(error as Error&{forms?:typeof form[]}).forms;return !!forms?.some(x=>x.title==='A只改标题')&&forms.some(x=>x.summary==='B的新摘要')})
 const raw=[...rows.values()].join('\n');assert.match(raw,/B的新摘要/);assert.match(raw,/A只改标题/)
 const f=fixture(),one=f.make(),two=f.make();one.edit(snapshot('alert-a'));two.edit(snapshot('alert-a'));two.change('summary','另一页输入');one.change('title','旧页标题');assert.equal(one.getSnapshot().phase,'draft-conflict')
 one.configure({...definition,fields:[{...definition.fields[0]!,required:true}]},rights);assert.equal(one.getSnapshot().phase,'draft-conflict');assert.equal(f.calls.length,0)
})
test('R2 字段变更可明确保留原稿并按当前定义继续，不提交且旧定义原稿留存',()=>{
 const f=fixture(),session=f.make();session.edit(snapshot('alert-a'));session.change('summary','旧定义原稿');session.changeField('count','1.')
 const changed={...definition,fields:[{...definition.fields[0]!,required:true}]};session.configure(changed,rights);session.cancel();session.edit(snapshot('alert-a'));assert.equal(session.getSnapshot().phase,'schema-changed')
 const reopen=(session as unknown as {reopenWithCurrentDefinition?:()=>void}).reopenWithCurrentDefinition;assert.equal(typeof reopen,'function');reopen!.call(session)
 assert.equal(session.getSnapshot().phase,'idle');assert.equal(session.getSnapshot().form?.summary,'旧定义原稿');assert.equal(session.getSnapshot().form?.values.count,'1.');assert.equal(session.getSnapshot().form?.definition.fields[0]?.required,true);assert.equal(f.calls.length,0);assert.equal(f.ids,0)
 assert.ok([...f.rows.values()].some(raw=>raw.includes('旧定义原稿')&&raw.includes('"required":false')))
})
test('空白/尚未完成的字段按草稿恢复，不借用其他本人、业务或类型',()=>{
 const f=fixture(),session=f.make();session.edit(snapshot('alert-a'));session.change('title','');session.changeField('count','1.');session.cancel()
 const restored=f.make();restored.edit(snapshot('alert-a'));assert.equal(restored.getSnapshot().form?.title,'');assert.equal(restored.getSnapshot().form?.values.count,'1.')
 const other=f.make('owner-b');other.edit(snapshot('alert-a'));assert.equal(other.getSnapshot().form?.title,'alert-a');assert.equal(other.getSnapshot().form?.values.count,'')
 const otherScope=f.make('owner-a','other-business');otherScope.edit({...snapshot('alert-a'),scope:'other-business'});assert.equal(otherScope.getSnapshot().form?.title,'alert-a')
 const otherType=f.make('owner-a','SOC','other-alert');otherType.edit({...snapshot('alert-a'),type:'other-alert'});assert.equal(otherType.getSnapshot().form?.title,'alert-a')
 assert.equal(f.calls.length,0);assert.equal(f.ids,0)
})
test('新版本/定义不被旧草稿默默覆盖，恢复不恢复编辑权限',async()=>{
 const f=fixture(),first=f.make();first.edit(snapshot('alert-a'));first.change('summary','原版本草稿')
 const restored=f.make();restored.edit(snapshot('alert-a',2));assert.equal(restored.getSnapshot().phase,'conflict');assert.equal(restored.getSnapshot().form?.base?.version,1);assert.equal(restored.getSnapshot().comparison?.version,2);await restored.save();assert.equal(f.calls.length,0)
 const changed=f.make();changed.configure({...definition,fields:[{...definition.fields[0]!,required:true}]},rights);changed.edit(snapshot('alert-a'));assert.equal(changed.getSnapshot().phase,'schema-changed');await changed.save();assert.equal(f.calls.length,0)
 const forbidden=f.make();forbidden.configure(definition,{...rights,edit:false});assert.throws(()=>forbidden.edit(snapshot('alert-a')),/权限/);assert.equal(f.calls.length,0)
})
test('未知请求刷新保留同 requestId；迟到成功不删除另一标签页较新草稿或其他告警',async()=>{
 const f=fixture(),first=f.make();first.edit(snapshot('alert-a'));first.change('summary','已明确提交');f.setOffline(true);await first.save();const request=first.getSnapshot().pending!.input.requestId;assert.equal(first.getSnapshot().phase,'unknown')
 const second=f.make();assert.equal(second.getSnapshot().pending!.input.requestId,request);assert.equal(f.calls.length,1)
 // 另一既有标签页的本机草稿不构成第二次业务提交。
 const drafts=createBusinessRecordDrafts({namespace:'owner-a',storage:storageFor(f.rows)})
 const form=structuredClone(first.getSnapshot().form!);drafts.read('SOC','alert',form);drafts.write('SOC','alert',{...form,summary:'另一页的新输入'});drafts.write('SOC','alert',{...form,base:{id:'alert-b',version:1},summary:'B的输入'})
 await second.recover();assert.equal(second.getSnapshot().phase,'saved');assert.deepEqual(f.calls[1],{receipt:request});assert.equal(f.ids,1)
 const reopened=f.make();reopened.edit(snapshot('alert-a',2));assert.equal(reopened.getSnapshot().form?.summary,'另一页的新输入');assert.equal(reopened.getSnapshot().phase,'conflict');reopened.cancel();reopened.edit(snapshot('alert-b'));assert.equal(reopened.getSnapshot().form?.summary,'B的输入')
})
test('正常成功仅清本次提交的精确草稿，不清其他记录',async()=>{
 const f=fixture(),session=f.make();session.edit(snapshot('alert-b'));session.change('summary','B保留');session.cancel();session.edit(snapshot('alert-a'));session.change('summary','A保存');await session.save();assert.equal(session.getSnapshot().phase,'saved')
 const reopened=f.make();reopened.edit(snapshot('alert-a',2));assert.equal(reopened.getSnapshot().form?.summary,'');assert.equal(reopened.getSnapshot().phase,'idle');reopened.cancel();reopened.edit(snapshot('alert-b'));assert.equal(reopened.getSnapshot().form?.summary,'B保留')
})
test('另一既有标签页不能覆盖原未知 request；迟到回执也不能清除其它原请求',async()=>{
 const f=fixture(),first=f.make(),other=f.make();first.edit(snapshot('alert-a'));first.change('summary','A保存');other.edit(snapshot('alert-b'));other.change('summary','B保存')
 f.setOffline(true);await first.save();const request=first.getSnapshot().pending!.input.requestId,key=[...f.rows.keys()].find(x=>x.includes('/request/'))!,original=f.rows.get(key)!
 await other.save();assert.equal(other.getSnapshot().phase,'recovery-error');assert.equal(f.calls.length,1);assert.equal(f.rows.get(key),original)
 const newer=JSON.parse(original);newer.mutation.input={...newer.mutation.input,id:'alert-b',requestId:'22222222-2222-4222-8222-222222222222'};const newerRaw=JSON.stringify(newer);f.rows.set(key,newerRaw)
 await first.recover();assert.equal(first.getSnapshot().phase,'saved');assert.deepEqual(f.calls[1],{receipt:request});assert.equal(f.rows.get(key),newerRaw)
 const restored=f.make();assert.equal(restored.getSnapshot().pending!.input.requestId,newer.mutation.input.requestId)
})
test('存储失败保留当前内存输入；损坏记录不被恢复输入或静默覆盖',()=>{
 const f=fixture(),session=f.make();session.edit(snapshot('alert-a'));f.setQuota(true);session.change('summary','内存保留');assert.equal(session.getSnapshot().draftError,true);session.cancel();session.edit(snapshot('alert-a'));assert.equal(session.getSnapshot().form?.summary,'内存保留');f.setQuota(false);session.change('summary','存储已恢复');assert.equal(session.getSnapshot().draftError,false)
 const key=[...f.rows.keys()].find(x=>x.includes('/record-drafts/'))!;f.rows.set(key,'{broken');const restored=f.make();restored.edit(snapshot('alert-a'));assert.equal(restored.getSnapshot().draftError,true);restored.change('summary','新输入');assert.equal(f.rows.get(key),'{broken');assert.equal(f.calls.length,0)
})
