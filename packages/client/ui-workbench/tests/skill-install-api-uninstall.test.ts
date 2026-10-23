import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillInstallApi,skillUninstallBlockers,type SkillUninstallInput} from '../src/client/skill-install-api.ts'

const installationId='33333333-3333-4333-8333-333333333333',requestId='22222222-2222-4222-8222-222222222222',bundleHash='c'.repeat(64)
const input:SkillUninstallInput={requestId,installationId,expectedVersion:3,expectedBundleHash:bundleHash,confirm:true}
const receipt={requestId,installationId,nativeName:'audit-skill',bundleHash,removedAt:'2026-10-23T00:00:00.000Z'}

test('技能卸载调用真实端点并严格核对回执身份与格式',async()=>{
 let method='',payload:unknown
 const api=createSkillInstallApi(async(m,p)=>{method=m;payload=p;return receipt})
 assert.deepEqual(await api.uninstall(input),receipt)
 assert.equal(method,'skill-installations/uninstall')
 assert.deepEqual(payload,input)
 for(const bad of [
  {...receipt,installationId:'44444444-4444-4444-8444-444444444444'},
  {...receipt,requestId:'55555555-5555-4555-8555-555555555555'},
  {...receipt,nativeName:'Bad Name'},
  {...receipt,bundleHash:'not-a-hash'},
  {...receipt,removedAt:'2026-10-23'},
  {...receipt,extra:true},
 ])await assert.rejects(createSkillInstallApi(async()=>bad).uninstall(input),/回执/,JSON.stringify(bad))
})

test('技能卸载请求只接受固定四字段与 confirm:true，非法请求不触达端点',async()=>{
 let calls=0
 const api=createSkillInstallApi(async()=>{calls++;return receipt})
 for(const bad of [
  {...input,confirm:false},
  {...input,installationId:'not-a-uuid'},
  {...input,expectedVersion:0},
  {...input,expectedBundleHash:'x'.repeat(64)},
  {...input,requestId:undefined},
  {...input,extra:true},
 ])await assert.rejects(api.uninstall(bad as never),/请求/,JSON.stringify(bad))
 assert.equal(calls,0,'非法请求不能发出真实卸载')
})

test('skill-in-use 冲突的 blockers 支持数组与映射两种回包形态',()=>{
 const conflict=(blockers:unknown)=>Object.assign(Error('conflict'),{code:'teloa/conflict',details:{reason:'skill-in-use',blockers}})
 assert.deepEqual(skillUninstallBlockers(conflict(['selected','run-history'])),['selected','run-history'])
 assert.deepEqual(skillUninstallBlockers(conflict([{kind:'industry-usage'}])),['industry-usage'])
 assert.deepEqual(skillUninstallBlockers(conflict({selected:true,'run-history':2,'industry-usage':[]})),['selected','run-history'])
 assert.deepEqual(skillUninstallBlockers(conflict(['unknown-blocker','selected'])),['selected'])
 assert.deepEqual(skillUninstallBlockers(Object.assign(Error(),{details:{reason:'other',blockers:['selected']}})),[])
 assert.deepEqual(skillUninstallBlockers(undefined),[])
})
