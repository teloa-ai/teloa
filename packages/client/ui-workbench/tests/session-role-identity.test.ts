import test from 'node:test'
import assert from 'node:assert/strict'
import {readSessionRoleIdentity,readDirectoryRoleIdentities} from '../src/client/session-role-identity.ts'

const roles=[{id:'role-a',name:'甲岗位'},{id:'role-b',name:'乙岗位'}]
test('侧栏会话按自身关联读取身份，不继承主会话或父会话的岗位',async()=>{
  const port={
    links:async(sessionId:string)=>sessionId==='session-b'?[{kind:'role' as const,sessionId:'session-b',objectId:'role-b',active:true}]:[],
    roles:async()=>roles,
  }
  assert.equal(await readSessionRoleIdentity('session-b',port),'乙岗位')
  assert.equal(await readSessionRoleIdentity('child-of-b',port),undefined)
})

test('拒绝将另一会话、已解绑或缺失岗位显示为当前会话身份',async()=>{
  for(const link of [
    {kind:'role' as const,sessionId:'other-session',objectId:'role-a',active:true},
    {kind:'role' as const,sessionId:'session-b',objectId:'role-a',active:false},
    {kind:'role' as const,sessionId:'session-b',objectId:'missing-role',active:true},
  ])assert.equal(await readSessionRoleIdentity('session-b',{links:async()=>[link],roles:async()=>roles}),undefined)
})


test('目录员工身份只来自该条原会话的正式关联；读失败、多重身份和迟到外来关联不冒认',async()=>{
 const read=async(sessionId:string)=>{
  if(sessionId==='offline')throw Error('unavailable')
  return sessionId==='own'?[{kind:'role' as const,sessionId,objectId:'role-a',active:true}]:sessionId==='multiple'?roles.map(role=>({kind:'role' as const,sessionId,objectId:role.id,active:true})):[{kind:'role' as const,sessionId:'own',objectId:'role-a',active:true}]
 }
 assert.deepEqual(await readDirectoryRoleIdentities(['own','offline','foreign','multiple'],read,roles),{own:roles[0]})
 assert.deepEqual(await readDirectoryRoleIdentities(['own'],read,[]),{})
})
