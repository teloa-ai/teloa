import test from 'node:test'
import assert from 'node:assert/strict'
import {readRoleGroups} from '../src/client/role-group-membership.ts'
import type {GroupApi} from '../src/client/group-api.ts'

test('同事群归属读取已保存的成员，失败不能伪装成零个群',async()=>{
 const groups=[{id:'g1',name:'Lumen'},{id:'g2',name:'Review'}]
 const api={list:async()=>({items:groups}),get:async(id:string)=>({group:groups.find(item=>item.id===id),members:[{roleId:id==='g1'?'alice':'bob'}]})} as Pick<GroupApi,'list'|'get'>
 assert.deepEqual(await readRoleGroups(api,'alice'),[{id:'g1',name:'Lumen'}])
 await assert.rejects(readRoleGroups({...api,get:async()=>{throw Error('离线')}},'alice'),/离线/)
})
