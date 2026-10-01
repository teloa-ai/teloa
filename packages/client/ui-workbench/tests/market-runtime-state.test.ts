import assert from 'node:assert/strict'
import test from 'node:test'
import {loadMarketSkillRuntime,marketRuntimeForItem,type MarketSkillRuntime} from '../src/client/market-runtime-state.ts'
import type {MarketItem} from '../src/client/market-preview.ts'
import type {SkillInstallationRecord} from '../src/client/skill-install-api.ts'

const hash='a'.repeat(64)
const contentId='10000000-0000-4000-8000-000000000001'
const installationId='20000000-0000-4000-8000-000000000001'
const item:MarketItem={id:'content-'+hash,kind:'skill',title:'报告撰写',version:'1.0.0',scope:'general',visibility:'personal',summary:'说明',requirements:[],output:'结果',author:'本人',license:'MIT',source:{kind:'stored',contentId},owner:'DSH',compatibility:'DSH 0.1.5',components:[],contentStorage:{contentId,createdAt:'2026-09-13T00:00:00.000Z',loaded:true}}
const installation:SkillInstallationRecord={id:installationId,ownerId:'local:teloa-owner',source:{kind:'atomic',contentId,contentHash:hash,resourceId:'report-writing',resourceVersion:'1.0.0'},bundleHash:hash,native:{name:'report-writing',description:'说明',modelInvocable:true,userInvocable:true,bodyHash:hash},state:'installed',version:2,createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z'}

test('市场只用固定内容身份关联真实 Skill 安装，不按标题或同名猜测',()=>{
 const ready:MarketSkillRuntime={state:'ready',facts:[{record:installation,availability:{installationId,ownerId:'local:teloa-owner',availability:'enabled',version:1,updatedAt:'2026-09-13T00:00:00.000Z'},observation:{installationId,scope:'default-workspace',state:'available',current:{...installation.native,provider:'teloa-market',source:'/fixed'}}}]}
 assert.deepEqual(marketRuntimeForItem(item,ready),{status:'已安装并可用',action:'查看安装',installationId})
 assert.deepEqual(marketRuntimeForItem({...item,id:'same-title',contentStorage:{...item.contentStorage!,contentId:'10000000-0000-4000-8000-000000000099'}},ready),{status:'尚未安装',action:'查看并安装'})
})

test('市场如实区分准备中、停用、运行缺失和目录读取失败',()=>{
 const base:MarketSkillRuntime={state:'ready',facts:[{record:{...installation,state:'preparing'},availability:null,observation:null}]}
 assert.equal(marketRuntimeForItem(item,base)!.status,'安装待核对')
 assert.equal(marketRuntimeForItem(item,{state:'ready',facts:[{record:installation,availability:{installationId,ownerId:'local:teloa-owner',availability:'disabled',version:2,updatedAt:'2026-09-13T00:00:00.000Z'},observation:{installationId,scope:'default-workspace',state:'disabled',current:null}}]})!.status,'已停用')
 assert.equal(marketRuntimeForItem(item,{state:'ready',facts:[{record:installation,availability:null,observation:{installationId,scope:'default-workspace',state:'missing',current:null}}]})!.status,'安装记录存在，运行缺失')
 assert.deepEqual(marketRuntimeForItem(item,{state:'error',facts:[]}),{status:'状态未核验',action:'查看安装管理'})
})

test('目录加载后逐条核对可用性与 DSH 原生观察，单条失败保留未核验事实',async()=>{
 const runtime=await loadMarketSkillRuntime({
  list:async()=>({items:[installation],usages:[]}),
  observe:async()=>{throw Error('native unavailable')},
 } as never,{get:async()=>({installationId,ownerId:'local:teloa-owner',availability:'enabled',version:1,updatedAt:'2026-09-13T00:00:00.000Z'})} as never)
 assert.equal(runtime.state,'ready')
 assert.equal(runtime.facts.length,1)
 assert.equal(runtime.facts[0]!.availability?.availability,'enabled')
 assert.equal(runtime.facts[0]!.observation,null)
 assert.equal(runtime.facts[0]!.verificationError,true)
 assert.equal(marketRuntimeForItem(item,runtime)!.status,'已安装，可用性未核验')
})

test('插件没有真实生命周期观测时显示状态未核验',()=>{
 const {contentStorage:_,...base}=item
 const plugin:MarketItem={...base,id:'dsh-visualize',kind:'resource',resourceKind:'plugin',source:{kind:'github',url:'https://github.com/Nagi-ovo/dsh-visualize',revision:'fixed'}}
 assert.deepEqual(marketRuntimeForItem(plugin,{state:'ready',facts:[]}),{status:'状态未核验',action:'查看并安装'})
})
