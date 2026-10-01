import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
const requestId='11111111-1111-4111-8111-111111111111'
test('记录请求只校验结构，拒绝未知键、重复字段和越界',()=>{
 assert.equal(typeof api.readBusinessRecordCreate,'function')
 const input={scope:'crm',type:'customer',requestId,title:'客户',summary:'',fields:[{name:'state',value:'待联系'}]}
 assert.deepEqual(api.readBusinessRecordCreate(input),input)
 for(const value of [{...input,extra:true},{...input,title:''},{...input,fields:[...input.fields,...input.fields]},{...input,fields:[{name:'state',value:1}]},{...input,requestId:'bad'}])assert.throws(()=>api.readBusinessRecordCreate(value),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessRecordEdit({...input,id:'one',expectedVersion:0}),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessRecordList({scope:'crm',type:'customer',limit:101}),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessRecordGet({scope:'crm',type:'customer',id:'one',version:2147483648}),{code:'teloa/invalid-input'})
})
test('记录回包共享reader严格保留归档版本并拒绝越界与跨范围',()=>{
 assert.equal(typeof api.readBusinessRecordSnapshot,'function')
 const item={scope:'crm',type:'customer',id:'one',version:3,snapshotHash:'a'.repeat(64),title:'甲',source:'本地',observedAt:'2026-09-29T00:00:00.000Z',receivedAt:'2026-09-29T00:00:00.000Z',quality:'complete',summary:'',fields:[{label:'阶段',value:'洽谈'}],deletedAt:'2026-09-29T00:01:00.000Z'}
 assert.deepEqual(api.readBusinessRecordSnapshot(item,'crm'),item,'归档时刻晚于原receivedAt仍保留原快照时间')
 for(const bad of [{...item,owner:'other'},{...item,scope:'other'},{...item,version:0},{...item,deletedAt:'invalid'},{...item,fields:[...item.fields,...item.fields]}])assert.throws(()=>api.readBusinessRecordSnapshot(bad,'crm'),{code:'teloa/invalid-host-response'})
 assert.throws(()=>api.readBusinessRecordPage({schema:'teloa.business-data-page/v1',sourceId:'records',capturedAt:item.receivedAt,items:[item]},'crm'),{code:'teloa/invalid-host-response'})
})
test('原子记录批次复用单条归一并拒绝嵌套身份、重复目标和越界',()=>{
 const create={operation:'create',type:'customer',title:'客户',summary:'',fields:[{name:'z',value:'后'},{name:'a',value:'先'}]}
 const edit={operation:'edit',type:'customer',id:'old',expectedVersion:1,fields:[]}
 const input={requestId,scope:'crm',operations:[create,edit,{operation:'archive',type:'article',id:'old',expectedVersion:2}]}
 assert.equal(typeof api.readBusinessRecordBatch,'function')
 const result=api.readBusinessRecordBatch(input)
 assert.deepEqual(result.operations[0],{...create,fields:[{name:'a',value:'先'},{name:'z',value:'后'}]})
 assert.deepEqual(result.operations.slice(1),input.operations.slice(1))
 assert.equal(api.readBusinessRecordBatch({...input,requestId:requestId.toUpperCase()}).requestId,requestId)
 for(const bad of [
  {...input,source:{sessionId:'injected'}},{...input,scope:'general'},{...input,operations:[]},{...input,operations:Array(51).fill(create)},
  {...input,operations:[{...create,scope:'crm'}]},{...input,operations:[{...create,requestId}]},{...input,operations:[{...create,id:'new'}]},
  {...input,operations:[{...edit,expectedVersion:0}]},{...input,operations:[edit,{operation:'archive',type:'customer',id:'old',expectedVersion:1}]},
  {...input,operations:[{...create,operation:'upsert'}]},{...input,operations:[{...create,fields:[{name:'a',value:'x'},{name:'a',value:'y'}]}]},
 ])assert.throws(()=>api.readBusinessRecordBatch(bad),{code:'teloa/invalid-input'})
 assert.equal(api.readBusinessRecordBatch({...input,operations:Array(50).fill(create)}).operations.length,50)
})
