import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupWorkLinkApi} from '../src/client/group-work-links-api.ts'
const groupId='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',links=[{kind:'project' as const,scope:'general',id}]
const result={groupId,groupVersion:1,version:1,items:[{...links[0],available:true,title:'Original project',state:'planning',objectVersion:1}]}
test('断线及页面重建只重放原请求，修改草稿不能覆盖未决关联',async()=>{
 let raw:string|null=null;const calls:unknown[]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createGroupWorkLinkApi(async(_endpoint,input)=>{calls.push(input);throw Error('disconnected')},journal,()=>id)
 await assert.rejects(api.change(groupId,1,0,links));assert.ok(raw)
 await assert.rejects(api.change(groupId,1,0,[]));assert.equal(calls.length,1)
 const recovered=createGroupWorkLinkApi(async(_endpoint,input)=>{calls.push(input);return result},journal)
 assert.deepEqual(await recovered.recover(),result);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
test('错群响应与关联身份错配不清除恢复记录',async()=>{
 const api=createGroupWorkLinkApi(async()=>({...result,groupId:id}),undefined,()=>id)
 await assert.rejects(api.change(groupId,1,0,links));assert.equal(api.pending()!.groupId,groupId)
})
test('本地清理失败不能显示保存完成；重试保留原请求',async()=>{
 let raw:string|null=null,clearFails=true;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{if(clearFails)throw Error('storage unavailable');raw=null}}
 const api=createGroupWorkLinkApi(async()=>result,journal,()=>id)
 await assert.rejects(api.change(groupId,1,0,links));assert.ok(api.pending());assert.ok(raw)
 clearFails=false;assert.deepEqual(await api.recover(),result);assert.equal(raw,null)
})
