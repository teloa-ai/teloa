import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import type {SkillInstallationRecord} from '../src/client/skill-install-api.ts'
import {mergeSkillInstallation,uniqueSkillInstallations} from '../src/client/skill-install-state.ts'

test('真实Skill安装只挂持久原子内容和未跳过行业Skill，并与演示安装状态分离',async()=>{
  const [market,industry,frame]=await Promise.all([
    readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
  ])
  assert.match(market,/item\.kind==='skill'&&item\.contentStorage\?\.loaded&&<SkillInstallControl key=\{'atomic-'/)
  assert.match(industry,/item\.kind==='skill'&&item\.status==='pending-adapter'&&<SkillInstallControl key=\{'industry-skill-'/)
  assert.doesNotMatch(industry,/item\.status==='skipped'&&<SkillInstallControl/)
  assert.doesNotMatch(market,/installations\.preview/)
  assert.doesNotMatch(frame,/installationFailures\(installations\)/)
  assert.match(market,/<p>\{t\('market\.skill\.originalContentSavedNotice'\)\}<\/p>/)
  assert.match(frame,/skillInstallApi=\{skillInstallApi\}/)
  assert.match(frame,/industryResources=\{state\.marketMode==='industry-resources'/)
  assert.match(frame,/state\.industryResourceTarget/)
  assert.match(industry,/target\?:\{loadId:string;itemInstanceId:string\}/)
  assert.match(industry,/item\.instanceId===target\.itemInstanceId/)
})

const record=(version:number,state:SkillInstallationRecord['state']):SkillInstallationRecord=>({
  id:'11111111-1111-4111-8111-111111111111',
  ownerId:'owner',
  source:{kind:'atomic',contentId:'content',contentHash:'a'.repeat(64),resourceId:'resource',resourceVersion:'v1'},
  bundleHash:'b'.repeat(64),
  native:{name:'example-skill',description:'example',modelInvocable:true,userInvocable:true,bodyHash:'c'.repeat(64)},
  state,version,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',
})

test('Skill安装刷新不以旧版本或preparing覆盖已确认installed',()=>{
  const base=record(2,'installed')
  assert.equal(mergeSkillInstallation(base,record(1,'preparing')),base)
  assert.equal(mergeSkillInstallation(base,record(2,'preparing')),base)
  assert.equal(mergeSkillInstallation(base,record(3,'installed'))?.version,3)
})

test('安装目录按安装身份去重并保留最新确认版本',()=>{
  const older=record(1,'preparing'),latest=record(2,'installed')
  assert.deepEqual(uniqueSkillInstallations([older,latest,latest]),[latest])
})

import {selectSkillInstallation} from '../src/client/skill-install-state.ts'
test('行业来源命中可复用安装但没有usage时仍要求登记当前加载',()=>{
  const installed=record(2,'installed')
  const preview={source:{kind:'industry-public' as const,loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333',contentId:'44444444-4444-4444-8444-444444444444',contentHash:'d'.repeat(64),sourceContentId:'content',sourceContentHash:'a'.repeat(64),sourceResourceId:'resource',sourceResourceVersion:'v1',resourceId:'industry-resource',resourceVersion:'v1'},bundleHash:installed.bundleHash,native:installed.native,files:[{path:'SKILL.md',hash:'e'.repeat(64),size:1}]}
  const source={kind:'industry' as const,loadId:preview.source.loadId,itemInstanceId:preview.source.itemInstanceId}
  const reusable=selectSkillInstallation(source,preview,[installed],[])
  assert.equal(reusable.record,installed)
  assert.equal(reusable.linked,false)
  assert.equal(selectSkillInstallation(source,preview,[installed],[{...source,installationId:installed.id}]).linked,true)
})

import {skillPendingForSource} from '../src/client/skill-install-state.ts'
test('A来源待恢复不会在B来源控件显示为可恢复',()=>{
  const pending={source:{kind:'industry' as const,loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333'}}
  assert.equal(skillPendingForSource(pending,pending.source),true)
  assert.equal(skillPendingForSource(pending,{kind:'industry',loadId:pending.source.loadId,itemInstanceId:'44444444-4444-4444-8444-444444444444'}),false)
  assert.equal(skillPendingForSource(pending,{kind:'atomic',contentId:'55555555-5555-4555-8555-555555555555'}),false)
})

test('服务端仅有preparing记录时保留继续核对入口',async()=>{
  const control=await readFile(new URL('../src/client/SkillInstallControl.tsx',import.meta.url),'utf8')
  const status=await readFile(new URL('../src/client/SkillInstallationStatus.tsx',import.meta.url),'utf8')
  assert.match(control,/record\?\.state==='preparing'&&linked&&preview&&!pending&&!busy/)
  assert.match(status,/t\('market\.skill\.status\.continue'\)/)
})

import {recoverSkillForSource} from '../src/client/skill-install-state.ts'
test('旧A恢复按钮点击时pending已换成B则不调用recover',async()=>{
  const sourceA={kind:'atomic' as const,contentId:'55555555-5555-4555-8555-555555555555'}
  const sourceB={kind:'atomic' as const,contentId:'66666666-6666-4666-8666-666666666666'}
  let calls=0
  const api={pending:()=>({source:sourceB}),recover:async()=>{calls++;return record(2,'installed')}}
  await assert.rejects(()=>recoverSkillForSource(api,sourceA),/请求已变化/)
  assert.equal(calls,0)
  await recoverSkillForSource(api,sourceB)
  assert.equal(calls,1)
})
