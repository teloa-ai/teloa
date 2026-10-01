import test from 'node:test'
import assert from 'node:assert/strict'
import type {SkillInstallationRecord,SkillInstallUsage} from '../src/client/skill-install-api.ts'
import {filterSkillInstallations,installationSourceInput,reduceInstallationView} from '../src/client/real-skill-installation-state.ts'
import { installationDirectoryMeta } from '../src/client/skill-installation-presentation.ts'
test('启停改变独立状态后清除旧原生观测但保留安装详情',()=>{const first=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill');let state=reduceInstallationView(undefined,{type:'select',id:first.id,token:1});state=reduceInstallationView(state,{type:'detail-ok',token:1,record:first});state=reduceInstallationView(state,{type:'observation-ok',token:1,observation:{installationId:first.id,scope:'default-workspace',state:'missing',current:null}});state=reduceInstallationView(state,{type:'observation-clear',token:1});assert.equal(state.detail?.observation,undefined);assert.equal(state.detail?.record.id,first.id)})

const row=(id:string,name:string,state:SkillInstallationRecord['state']='installed'):SkillInstallationRecord=>({
  id,ownerId:'owner',source:{kind:'atomic',contentId:'11111111-1111-4111-8111-111111111111',contentHash:'a'.repeat(64),resourceId:'market.skill',resourceVersion:'2.1.0'},bundleHash:'b'.repeat(64),native:{name,description:'说明',modelInvocable:true,userInvocable:false,bodyHash:'c'.repeat(64)},state,version:3,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T01:00:00.000Z',
})

test('真实安装目录按名称、版本、身份搜索并筛选真实状态',()=>{
  const installed=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
  const preparing=row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','draft-skill','preparing')
  assert.deepEqual(filterSkillInstallations([installed,preparing],'audit','all'),[installed])
  assert.deepEqual(filterSkillInstallations([installed,preparing],'2.1.0','installed'),[installed])
  assert.deepEqual(filterSkillInstallations([installed,preparing],'bbbb','preparing'),[preparing])
})

test('安装目录明确来源类型，并且不把已安装误写成已启用',()=>{
  const atomic=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
  const industry={...atomic,source:{...atomic.source,kind:'industry-public' as const,loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333',sourceContentId:'44444444-4444-4444-8444-444444444444',sourceContentHash:'d'.repeat(64),sourceResourceId:'shared-skill',sourceResourceVersion:'2.2.0'}}
  assert.deepEqual(installationDirectoryMeta(atomic),{source:'本人固定内容',identity:'market.skill · 2.1.0 · 记录 v3',availability:'启用状态请打开详情核对'})
  assert.deepEqual(installationDirectoryMeta(industry),{source:'行业加载引用的公共固定内容',identity:'market.skill · 2.1.0 · 记录 v3',availability:'启用状态请打开详情核对'})
  assert.equal(installationDirectoryMeta({...atomic,state:'preparing'}).availability,'安装结果待核对')
})

test('preparing记录从固定身份重建安装来源而不接收路径或权限',()=>{
  const atomic=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
  assert.deepEqual(installationSourceInput(atomic.source),{kind:'atomic',contentId:atomic.source.contentId})
  const industry={...atomic.source,kind:'industry-local' as const,loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333'}
  assert.deepEqual(installationSourceInput(industry),{kind:'industry',loadId:industry.loadId,itemInstanceId:industry.itemInstanceId})
})

test('刷新失败保留目录，迟到详情不能覆盖当前选择',()=>{
  const first=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
  const second=row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','draft-skill')
  const usages:SkillInstallUsage[]=[]
  let state=reduceInstallationView(undefined,{type:'list-ok',token:1,items:[first,second],usages})
  state=reduceInstallationView(state,{type:'select',id:first.id,token:2})
  state=reduceInstallationView(state,{type:'select',id:second.id,token:3})
  state=reduceInstallationView(state,{type:'detail-ok',token:2,record:first})
  assert.equal(state.detail,undefined)
  state=reduceInstallationView(state,{type:'list-error',token:4,error:'暂不可用'})
  assert.deepEqual(state.items,[first,second])
  assert.equal(state.error,'暂不可用')
})

test('切换身份清除旧详情，同身份新版本清除旧观测',()=>{
  const first=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill'),second=row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','draft-skill')
  let state=reduceInstallationView(undefined,{type:'select',id:first.id,token:1})
  state=reduceInstallationView(state,{type:'detail-ok',token:1,record:first})
  state=reduceInstallationView(state,{type:'observation-ok',token:1,observation:{installationId:first.id,scope:'default-workspace',state:'missing',current:null}})
  state=reduceInstallationView(state,{type:'select',id:second.id,token:2})
  assert.equal(state.detail,undefined)
  state=reduceInstallationView(state,{type:'select',id:first.id,token:3})
  state=reduceInstallationView(state,{type:'detail-ok',token:3,record:{...first,version:4}})
  assert.equal(state.detail?.observation,undefined)
})

test('同一安装刷新保留事实与观测，真实版本变化才清除观测',()=>{
 const first=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
 let state=reduceInstallationView(undefined,{type:'select',id:first.id,token:1})
 state=reduceInstallationView(state,{type:'detail-ok',token:1,record:first})
 const observation={installationId:first.id,scope:'default-workspace' as const,state:'missing' as const,current:null}
 state=reduceInstallationView(state,{type:'observation-ok',token:1,observation})
 state=reduceInstallationView(state,{type:'select',id:first.id,token:2})
 state=reduceInstallationView(state,{type:'detail-error',token:2,error:'读取失败'})
 assert.equal(state.detail?.record.id,first.id)
 assert.deepEqual(state.detail?.observation,observation)
 state=reduceInstallationView(state,{type:'select',id:first.id,token:3})
 state=reduceInstallationView(state,{type:'detail-ok',token:3,record:first})
 assert.deepEqual(state.detail?.observation,observation)
 state=reduceInstallationView(state,{type:'select',id:first.id,token:4})
 assert.deepEqual(state.detail?.observation,observation)
 state=reduceInstallationView(state,{type:'detail-ok',token:4,record:{...first,version:first.version+1}})
 assert.equal(state.detail?.observation,undefined)
})

test('使用关系初载和读取失败都不具备已核实标记，成功空目录才是零引用',()=>{
 let state=reduceInstallationView(undefined,{type:'list-start',token:1})
 assert.equal(state.directoryLoaded,false)
 state=reduceInstallationView(state,{type:'list-error',token:1,error:'无法读取'})
 assert.equal(state.directoryLoaded,false)
 state=reduceInstallationView(state,{type:'list-ok',token:2,items:[],usages:[]})
 assert.equal(state.directoryLoaded,true)
 state=reduceInstallationView(state,{type:'list-error',token:3,error:'刷新失败'})
 assert.equal(state.directoryLoaded,true)
 assert.equal(state.error,'刷新失败')
})

test('同一安装详情拒绝版本倒退和同版本冲突，保留已核实记录',()=>{
 const first=row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','audit-skill')
 let state=reduceInstallationView(undefined,{type:'select',id:first.id,token:1})
 state=reduceInstallationView(state,{type:'detail-ok',token:1,record:first})
 state=reduceInstallationView(state,{type:'select',id:first.id,token:2})
 state=reduceInstallationView(state,{type:'detail-ok',token:2,record:{...first,version:2,state:'preparing'}})
 assert.deepEqual(state.detail?.record,first)
 assert.equal(state.detailLoading,false)
 state=reduceInstallationView(state,{type:'detail-ok',token:2,record:{...first,state:'preparing'}})
 assert.deepEqual(state.detail?.record,first)
 assert.match(state.detailError,/同一版本/)
})
