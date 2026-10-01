import test from 'node:test'
import assert from 'node:assert/strict'
import {readManagedRunSkill} from '../src/client/task-run-managed-skill.ts'
const fixed={installationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bundleHash:'a'.repeat(64),files:[{path:'SKILL.md',hash:'b'.repeat(64),size:20},{path:'references/说明.txt',hash:'c'.repeat(64),size:12}]}
test('受管执行依据保留完整文件身份，非受管历史不添加字段',()=>{
 assert.equal(readManagedRunSkill(undefined),undefined)
 assert.deepEqual(readManagedRunSkill(fixed),fixed)
 const output=readManagedRunSkill(fixed)!
 output.files[0]!.size=1
 assert.equal(fixed.files[0]!.size,20)
})
test('受管执行依据拒绝越界、缺入口、重复文件与未知权限字段',()=>{
 for(const value of [
 {...fixed,ownerId:'other'},
 {...fixed,files:[{path:'../SKILL.md',hash:'b'.repeat(64),size:20}]},
 {...fixed,files:fixed.files.slice(1)},
 {...fixed,files:[fixed.files[0],{path:'skill.md',hash:'b'.repeat(64),size:20}]},
 {...fixed,files:[...fixed.files,{path:'references/说明.txt/child',hash:'c'.repeat(64),size:1}]},
 {...fixed,files:[{...fixed.files[0],size:2*1024*1024+1}]},
 {...fixed,installationId:'/tmp/installed'},
 ])assert.throws(()=>readManagedRunSkill(value))
})
