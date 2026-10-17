import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import * as api from '../src/index.ts'
test('行动草稿使用现有批次边界；模型不能提交主体、批准或外部操作',()=>{
 assert.equal(typeof api.readBusinessChangeSetPrepare,'function')
 const value={requestId:randomUUID(),scope:'sales',operations:[{operation:'create',type:'customer',title:'客户',summary:'',fields:[]}]}
 assert.equal(api.readBusinessChangeSetPrepare(value).operations.length,1)
 for(const extra of [{ownerId:'other'},{approved:true},{authorization:{}},{sessionId:'other'}])assert.throws(()=>api.readBusinessChangeSetPrepare({...value,...extra}),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessChangeSetPrepare({...value,operations:[]}),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessChangeSetPrepare({...value,operations:[{operation:'send',type:'mail'}]}),{code:'teloa/invalid-input'})
})
test('采用绑定固定草稿版本与完整摘要；不能传入批准状态',()=>{
 assert.equal(typeof api.readBusinessChangeSetApply,'function')
 const value={changeSetId:randomUUID(),expectedRevision:1,expectedDigest:'a'.repeat(64)}
 assert.deepEqual(api.readBusinessChangeSetApply(value),value)
 for(const patch of [{expectedRevision:0},{expectedDigest:'short'},{approved:true}])assert.throws(()=>api.readBusinessChangeSetApply({...value,...patch}),{code:'teloa/invalid-input'})
})
