import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {marketPageGuidance} from '../src/client/market-page-guidance.ts'

const builtin={id:'demo',source:{kind:'builtin' as const}},stored={id:'stored',source:{kind:'stored' as const,contentId:'11111111-1111-4111-8111-111111111111'},contentStorage:{contentId:'11111111-1111-4111-8111-111111111111',createdAt:'2026-09-12T00:00:00.000Z',loaded:false}},loaded={...stored,id:'loaded',contentStorage:{...stored.contentStorage,contentId:'22222222-2222-4222-8222-222222222222',loaded:true}}
const facts=(overrides:Record<string,unknown>={})=>({items:[builtin],intents:[],industryLoadCount:0,contentPending:false,skillInstallPending:false,...overrides})

test('只有内置演示目录时从发现开始，后续步骤不冒充已完成',()=>{
 const steps=marketPageGuidance(facts())
 assert.deepEqual(steps.map(step=>[step.title,step.state]),[['发现资源','current'],['核对来源与版本','upcoming'],['安装 / 加载到工作空间','upcoming'],['配置对象并核验可用','upcoming']])
 assert.match(steps[0]!.description,/示例/);assert.doesNotMatch(JSON.stringify(steps),/已安装|已启用/)
})

test('固定摘要、已读详情和未完成导入分别使用真实状态，不把摘要当详情核对',()=>{
 let steps=marketPageGuidance(facts({items:[builtin,stored]}));assert.equal(steps[0]?.state,'complete');assert.equal(steps[1]?.state,'current');assert.match(steps[1]!.label!,/详情待核对/)
 steps=marketPageGuidance(facts({items:[builtin,loaded]}));assert.deepEqual(steps.slice(0,3).map(step=>step.state),['complete','complete','current']);assert.match(steps[1]!.label!,/详情已核对/)
 steps=marketPageGuidance(facts({contentPending:true}));assert.equal(steps[0]?.state,'complete');assert.equal(steps[1]?.state,'current');assert.equal(steps[1]?.label,'导入待核对')
})

test('真实行业加载推进到对象配置，使用方案只标待应用且永不伪装为可用',()=>{
 const steps=marketPageGuidance(facts({items:[loaded],industryLoadCount:2,intents:[{status:'draft'},{status:'withdrawn'}]}))
 assert.deepEqual(steps.map(step=>step.state),['complete','complete','complete','current']);assert.equal(steps[2]?.label,'行业加载 2 项');assert.equal(steps[3]?.label,'待应用方案 1 份');assert.match(steps[3]!.description,/目标对象.*核验/)
})

test('只有真实加载记录时不虚构本人目录数量，并单独暴露待恢复的 技能安装',()=>{
 const steps=marketPageGuidance(facts({industryLoadCount:1,skillInstallPending:true}))
 assert.equal(steps[0]?.label,'已有真实加载来源');assert.equal(steps[1]?.label,'真实加载来源已固定');assert.match(steps[2]!.description,/另有技能安装待核对/)
})

test('Skill 未完成安装只进入核对步骤，不被写成已安装或可用',()=>{
 const steps=marketPageGuidance(facts({items:[loaded],skillInstallPending:true}))
 assert.equal(steps[2]?.state,'current');assert.equal(steps[2]?.label,'技能安装待核对');assert.match(steps[2]!.description,/原请求/)
})

test('市场目录复用统一引导组件',async()=>{
 const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.match(source,/import \{ GuidedSetup \} from '\.\/GuidedSetup\.js'/)
 assert.match(source,/<GuidedSetup title=\{t\('market\.guide\.title'\)\}/)
 assert.doesNotMatch(source,/>应用与安装服务尚未接入。</)
})
