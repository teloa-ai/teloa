import assert from 'node:assert/strict'
import test from 'node:test'
import {employeeDraftRequestId} from '../src/client/employee-draft-request.ts'

const draft={entity:'role' as const,ownerId:'owner',id:'role-draft-not-a-uuid',bodyHash:'a'.repeat(64)}
test('员工固定草案使用可复算的合法创建请求 UUID',async()=>{
 const first=await employeeDraftRequestId(draft)
 assert.match(first,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
 assert.equal(await employeeDraftRequestId({...draft}),first)
 for(const change of [{ownerId:'another-owner'},{id:'another-draft'},{bodyHash:'b'.repeat(64)}])assert.notEqual(await employeeDraftRequestId({...draft,...change}),first)
})
test('未核对的草案身份或摘要不能发起员工创建',async()=>{
 for(const change of [{entity:'skill' as const},{id:''},{ownerId:''},{bodyHash:'invalid'}])await assert.rejects(employeeDraftRequestId({...draft,...change}))
})
