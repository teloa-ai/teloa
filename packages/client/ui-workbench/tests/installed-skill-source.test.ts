import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import type {MarketItem} from '../src/client/market-preview.js'
import type {SkillInstallationRecord,SkillInstallSourceIdentity} from '../src/client/skill-install-api.js'

registerHooks({resolve(specifier,context,next){return next(specifier==='./industry-manifest.js'&&context.parentURL?.endsWith('/installed-skill-source.ts')?'./industry-manifest.ts':specifier,context)}})
const {readInstalledSkillSource}=await import('../src/client/installed-skill-source.ts')
const id='11111111-1111-4111-8111-111111111111',parentId='22222222-2222-4222-8222-222222222222',installedId='33333333-3333-4333-8333-333333333333',stamp='2026-10-26T00:00:00.000Z',hash='a'.repeat(64),parentHash='b'.repeat(64)
const atomicSource:SkillInstallSourceIdentity={kind:'atomic',contentId:id,contentHash:hash,resourceId:'fixed-source-skill',resourceVersion:'1.0.0'}
const record=(source:SkillInstallSourceIdentity):SkillInstallationRecord=>({id:installedId,ownerId:'owner',source,bundleHash:'c'.repeat(64),native:{name:'fixed-source-skill',description:'fixed',bodyHash:'d'.repeat(64),modelInvocable:true,userInvocable:true},state:'installed',version:2,createdAt:stamp,updatedAt:stamp})
// 最小替身只填本只读契约要复验的固定字段；浏览器测试另跑正式 MarketPage/MarketDetail。
const atomic={id:'stored-'+id,kind:'skill',title:'原版本',version:'1.0.0',hash,contentStorage:{contentId:id,createdAt:stamp,loaded:true},atomicSkill:{id:'fixed-source-skill',version:'1.0.0',hash,files:[{path:'SKILL.md',hash:'d'.repeat(64),bytes:new Uint8Array([65])}]}} as unknown as MarketItem
function parent(kind:'local'|'public',version='1.0.0'):MarketItem{return {id:'stored-'+parentId,kind:'bundle',hash:parentHash,contentStorage:{contentId:parentId,createdAt:stamp,loaded:true},manifest:{format:'teloa.business-package/v2',resources:[{id:'bundled-method',kind:'skill',version,source:kind==='local'?{kind:'local',path:'method/SKILL.md'}:{kind:'public',id:'fixed-source-skill',version:'1.0.0'}}]},packageContent:{hash:parentHash,manifestPath:'teloa.json',files:[{path:'method/SKILL.md',bytes:new Uint8Array([65])}]}} as unknown as MarketItem}
const loadSource={loadId:'44444444-4444-4444-8444-444444444444',itemInstanceId:'55555555-5555-4555-8555-555555555555'}

test('固定来源使用完整安装身份与contentId/hash，忽略同名较新内容',async()=>{
 const latest={...atomic,id:'stored-latest',version:'2.0.0',contentStorage:{...atomic.contentStorage!,contentId:parentId}},reads:string[]=[],source=atomicSource
 const result=await readInstalledSkillSource({get:async target=>{assert.equal(target,installedId);return record(source)}},{list:async()=>[latest,atomic],hydrate:async item=>{reads.push(item.contentStorage!.contentId);return item}},{installationId:installedId,source})
 assert.equal(result,atomic);assert.deepEqual(reads,[id])
})
test('原安装变更/无权限、缺来源、摘要不符与资源版本变化均拒绝，不替换同名来源',async()=>{
 const request={installationId:installedId,source:atomicSource},content={list:async()=>[atomic],hydrate:async(item:MarketItem)=>item}
 await assert.rejects(readInstalledSkillSource({get:async()=>record({...atomicSource,resourceVersion:'2.0.0'})},content,request))
 await assert.rejects(readInstalledSkillSource({get:async()=>{throw Object.assign(Error('forbidden'),{code:'teloa/forbidden'})}},content,request),{code:'teloa/forbidden'})
 for(const summaries of [[],[{...atomic,hash:'e'.repeat(64)}]]){let hydrated=false;await assert.rejects(readInstalledSkillSource({get:async()=>record(atomicSource)},{list:async()=>summaries,hydrate:async item=>{hydrated=true;return item}},request));assert.equal(hydrated,false)}
 await assert.rejects(readInstalledSkillSource({get:async()=>record(atomicSource)},{...content,hydrate:async()=>({...atomic,atomicSkill:{...atomic.atomicSkill!,hash:'f'.repeat(64)}})},request))
 await assert.rejects(readInstalledSkillSource({get:async()=>record(atomicSource)},{...content,hydrate:async()=>({...atomic,atomicSkill:{...atomic.atomicSkill!,version:'2.0.0'}})},request))
})
test('行业本地技能复验精确资源版本与入口文件，读取原整包不加载最新版',async()=>{
 const source:SkillInstallSourceIdentity={kind:'industry-local',...loadSource,contentId:parentId,contentHash:parentHash,resourceId:'bundled-method',resourceVersion:'1.0.0'},item=parent('local'),request={installationId:installedId,source}
 assert.equal(await readInstalledSkillSource({get:async()=>record(source)},{list:async()=>[item],hydrate:async item=>item},request),item)
 for(const bad of [parent('local','2.0.0'),{...item,packageContent:{...item.packageContent!,files:[{path:'unrelated.md',bytes:new Uint8Array([65]),hash}]}}])await assert.rejects(readInstalledSkillSource({get:async()=>record(source)},{list:async()=>[bad],hydrate:async item=>item},request))
})
test('行业公共技能同时绑定固定原子正文和原方案引用，丢失/改版父映射不能成功',async()=>{
 const source:SkillInstallSourceIdentity={kind:'industry-public',...loadSource,contentId:parentId,contentHash:parentHash,resourceId:'bundled-method',resourceVersion:'1.0.0',sourceContentId:id,sourceContentHash:hash,sourceResourceId:'fixed-source-skill',sourceResourceVersion:'1.0.0'},request={installationId:installedId,source},item=parent('public')
 assert.equal(await readInstalledSkillSource({get:async()=>record(source)},{list:async()=>[atomic,item],hydrate:async item=>item},request),atomic)
 for(const rows of [[atomic],[atomic,parent('public','2.0.0')]])await assert.rejects(readInstalledSkillSource({get:async()=>record(source)},{list:async()=>rows,hydrate:async item=>item},request))
})
