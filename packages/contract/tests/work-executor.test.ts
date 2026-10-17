import test from 'node:test'
import assert from 'node:assert/strict'
import {readWorkExecutor} from '../src/tasks.ts'

const id='446df86e-98d0-49e1-a4e6-ec674d486b19'
test('执行身份明确区分本人和员工，空负责人不构成本人授权',()=>{
 assert.deepEqual(readWorkExecutor({kind:'owner',grantId:id,grantVersion:1}),{kind:'owner',grantId:id,grantVersion:1})
 assert.deepEqual(readWorkExecutor({kind:'role',roleId:id,roleVersion:2}),{kind:'role',roleId:id,roleVersion:2})
 for(const value of [null,{}, {kind:'unassigned'},{kind:'owner',grantId:id,grantVersion:0},{kind:'owner',grantId:id,grantVersion:1,ownerId:'other'},{kind:'owner',grantId:id,grantVersion:1,roleId:id}])assert.throws(()=>readWorkExecutor(value),{code:'teloa/invalid-input'})
})
