import test from 'node:test'
import assert from 'node:assert/strict'
import {createPersonalProfileSync} from '../src/client/personal-profile-sync.ts'

test('群发送前迁移现有资料；旧标签重连服从已保存姓名，明确编辑才可修改',async()=>{
 let saved='',displayName='Max Luo';const calls:string[]=[]
 const sync=createPersonalProfileSync(async(endpoint,payload)=>{
  calls.push(endpoint)
  if(endpoint==='profile/save'||endpoint==='profile/initialize'&&!saved)saved=(payload as {displayName:string}).displayName
  return {displayName:saved}
 },{read:()=>({displayName}),write:profile=>{displayName=profile.displayName}})
 await sync.ready();assert.equal(saved,'Max Luo')
 saved='李明';displayName='旧窗口姓名';await sync.ready()
 assert.equal(displayName,'李明');assert.equal(saved,'李明')
 await sync.save('Alice Chen');assert.equal(saved,'Alice Chen');assert.equal(displayName,'Alice Chen')
 assert.equal(calls.filter(endpoint=>endpoint==='profile/initialize').length,1)
})

test('资料同步失败可重试，旧连接的迟到资料不能写入新界面',async()=>{
 let failed=true,displayName='Max',release:(value:unknown)=>void=()=>{}
 const sync=createPersonalProfileSync(async()=>{if(failed)throw Error('offline');return {displayName:'Max Luo'}},{read:()=>({displayName}),write:profile=>{displayName=profile.displayName}})
 await assert.rejects(sync.ready(),/offline/);assert.equal(displayName,'Max')
 failed=false;await sync.ready();assert.equal(displayName,'Max Luo')
 const old=createPersonalProfileSync(()=>new Promise(resolve=>{release=resolve}),{read:()=>({displayName:''}),write:profile=>{displayName=profile.displayName}})
 const pending=old.ready();old.dispose();release({displayName:'旧账号'})
 await assert.rejects(pending,/连接已变化/);assert.equal(displayName,'Max Luo')
})

test('保存期间的重连读取等待真实保存，损坏资料可通过明确保存修复',async()=>{
 let displayName='Max',release:(profile:unknown)=>void=()=>{},started:()=>void=()=>{},reads=0
 const began=new Promise<void>(resolve=>{started=resolve})
 const sync=createPersonalProfileSync(async(endpoint)=>{
  if(endpoint==='profile/save'){started();return new Promise(resolve=>{release=resolve})}
  reads++;return {displayName:'Max'}
 },{read:()=>({displayName}),write:profile=>{displayName=profile.displayName}})
 const save=sync.save('Max Luo')
 await began
 const refresh=sync.ready(),before=reads
 release({displayName:'Max Luo'});await Promise.all([save,refresh])
 assert.equal(reads,before);assert.equal(displayName,'Max Luo')
 const repaired=createPersonalProfileSync(async endpoint=>{
  if(endpoint==='profile/get')throw Object.assign(Error('corrupt'),{code:'teloa/storage-corrupt'})
  return {displayName:'李明'}
 },{read:()=>({displayName}),write:profile=>{displayName=profile.displayName}})
 await repaired.save('李明');assert.equal(displayName,'李明')
})
