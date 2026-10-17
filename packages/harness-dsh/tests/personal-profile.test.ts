import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPersonalProfileHost} from '../src/personal-profile.ts'
import {readRoutingMessage} from '../src/group-routing-dispatch.ts'

test('资料称呼只由本人连接保存；首次迁移不覆盖已有姓名，重启后可供群读取',async t=>{
 const temporary=await mkdtemp(join(tmpdir(),'teloa-profile-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const path=join(temporary,'profile.json'),profile=createPersonalProfileHost(path,'owner-a')
 assert.deepEqual(await profile.handler('profile/get',{}),{displayName:''})
 assert.deepEqual(await profile.handler('profile/initialize',{displayName:'  Max   Luo  '}),{displayName:'Max Luo'})
 assert.deepEqual(await profile.handler('profile/initialize',{displayName:'旧浏览器姓名'}),{displayName:'Max Luo'})
 assert.equal((await createPersonalProfileHost(path,'owner-a').read()).displayName,'Max Luo')
 await assert.rejects(createPersonalProfileHost(path,'owner-b').read(),/不属于/)
 await assert.rejects(profile.handler('profile/save',{displayName:'max@example.test'}))
 await assert.rejects(profile.handler('profile/save',{displayName:'Max',ownerId:'someone-else'}))
 assert.equal((await profile.read()).displayName,'Max Luo')
 assert.equal(JSON.parse(await readFile(path,'utf8')).ownerId,'owner-a')
 await profile.handler('profile/save',{displayName:'李明'})
 assert.equal((await profile.read()).displayName,'李明')
})

test('群路由保留 self 权限身份，显示资料姓名；姓名缺失不使用本人称呼',async()=>{
 const db={query:async()=>({rows:[{group_id:'group-1',root_id:null,author_id:'self',text:'大家好',created_at:new Date('2026-10-15T00:00:00Z'),mention_snapshot:[],reply_to_message_id:null,mention_all:false}]})}
 const message=await readRoutingMessage('owner','message-1',db,'Max Luo')
 assert.equal(message?.authorId,'self');assert.equal(message?.authorKind,'self');assert.equal(message?.authorName,'Max Luo')
 assert.equal((await readRoutingMessage('owner','message-1',db))?.authorName,'用户')
})

test('损坏的显示资料不阻断群，只有明确保存可修复；已知他人归属不能覆盖',async t=>{
 const temporary=await mkdtemp(join(tmpdir(),'teloa-profile-corrupt-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const path=join(temporary,'profile.json'),profile=createPersonalProfileHost(path,'owner-a')
 await writeFile(path,'broken')
 assert.equal(await profile.displayName(),'')
 await assert.rejects(profile.handler('profile/initialize',{displayName:'旧窗口'}))
 await profile.handler('profile/save',{displayName:'Max Luo'})
 assert.equal(await profile.displayName(),'Max Luo')
 await writeFile(path,JSON.stringify({schema:'teloa.personal-profile/v1',ownerId:'owner-b',displayName:'其他用户',extra:true}))
 assert.equal(await profile.displayName(),'')
 await assert.rejects(profile.handler('profile/save',{displayName:'Max Luo'}),/不属于/)
})
