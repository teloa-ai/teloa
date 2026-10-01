import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
const id='abcdefab-1234-4123-8123-abcdefabcdef'
test('负责人请求严格校验并归一身份，不接受会话偏好或隐式清空',()=>{
 assert.equal(typeof api.readBusinessResponsibilitySet,'function')
 const input={requestId:id,scope:'crm',expectedVersion:0,role:{id,expectedVersion:1}}
 assert.deepEqual(api.readBusinessResponsibilitySet({...input,requestId:id.toUpperCase(),role:{...input.role,id:id.toUpperCase()}}),input)
 assert.deepEqual(api.readBusinessResponsibilityRead({scope:'crm'}),{scope:'crm'})
 assert.deepEqual(api.readBusinessResponsibilitySet({...input,role:null}),{...input,role:null})
 for(const bad of [{...input,role:undefined},{...input,roleId:id},{...input,scope:'general'},{...input,scope:''},{...input,expectedVersion:-1},{...input,expectedVersion:2147483647},{...input,role:{id,expectedVersion:0}},{...input,role:{id,expectedVersion:1,name:'同事'}},{...input,requestId:'bad'},{...input,ownerId:'someone'}])assert.throws(()=>api.readBusinessResponsibilitySet(bad),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessResponsibilityRead({scope:'crm',sessionId:'native'}),{code:'teloa/invalid-input'})
})
test('负责人投影保留失效身份，拒绝跨scope和矛盾状态',()=>{
 assert.equal(typeof api.readBusinessResponsibility,'function')
 const none={scope:'crm',version:0,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null}
 assert.deepEqual(api.readBusinessResponsibility(none,'crm'),none)
 const assigned={...none,version:1,roleId:id,selectedRoleVersion:1,availability:'ready',currentRoleVersion:2}
 for(const availability of ['ready','paused','retired','forbidden'])assert.deepEqual(api.readBusinessResponsibility({...assigned,availability},'crm'),{...assigned,availability})
 const missing={...assigned,availability:'missing',currentRoleVersion:null}
 assert.deepEqual(api.readBusinessResponsibility(missing,'crm'),missing)
 for(const bad of [{...assigned,scope:'other'},{...assigned,version:0},{...assigned,roleId:null},{...assigned,availability:'none'},{...assigned,currentRoleVersion:0},{...assigned,currentRoleVersion:null},{...assigned,selectedRoleVersion:3},{...missing,currentRoleVersion:1},{...none,roleId:id},{...assigned,name:'unverified'}])assert.throws(()=>api.readBusinessResponsibility(bad,'crm'),{code:'teloa/invalid-host-response'})
})
