import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'

const enc=new TextEncoder()
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const responsibility={triggers:['收到安全事件'],autonomousActions:['读取已授权证据'],confirmationPoints:['执行变更前请本人核对'],escalationRules:['证据冲突时升级'],deliveryChecks:['结论包含证据来源']}

function fixture(definition:unknown,options:{projectedStatus?:string;storedStatus?:'pending-adapter'|'skipped';publicSource?:boolean;contentDrift?:boolean}={}){
 const owner=randomUUID(),loadId=randomUUID(),itemInstanceId=randomUUID(),contentId=randomUUID(),contentHash='a'.repeat(64),bytes=enc.encode(JSON.stringify(definition)),path='roles/analyst.json'
 const resource={id:'analyst',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:options.publicSource?{kind:'public',id:'analyst',version:'1.0.0'}:{kind:'local',path}}
 const manifest={format:'teloa.business-package/v2',id:'security',title:'安全运营',version:'1.0.0',domain:'security',description:'安全模板',resources:[resource],relations:[],entrypoints:[]}
 const load={id:loadId,ownerId:owner,contentId,contentHash,templateId:'security',templateVersion:'1.0.0',templateTitle:'安全运营',domain:'security',description:'安全模板',targetVersion:1,space:{id:randomUUID(),name:'SOC',version:1,scope:'space-'+randomUUID()},items:[{localId:'analyst',instanceId:itemInstanceId,kind:'role',title:'分析岗',version:'1.0.0',required:true,status:options.projectedStatus??'pending-adapter'}],relations:[],entrypoints:[],createdAt:new Date().toISOString()}
 const content={id:contentId,ownerId:owner,kind:'industry-template',logicalId:'security',version:'1.0.0',hash:options.contentDrift?'b'.repeat(64):contentHash,baseHash:'c'.repeat(64),manifestPath:'teloa.json',metadata:manifest,files:options.publicSource?[]:[{path,hash:sha(bytes),bytes}],provides:options.publicSource?[]:[{resourceId:'analyst',kind:'role',version:'1.0.0',path}],references:[],createdAt:new Date().toISOString()}
 const calls:{load:number;content:number;stored:number}={load:0,content:0,stored:0}
 const source=new IndustryRoleSource(
  {get:async(actor,input)=>{calls.content+=1;assert.deepEqual(actor,{ownerId:owner,kind:'human'});assert.deepEqual(input,{contentId});return content as never},getInTransaction:async()=>{throw Error('本用例不走事务内读取')}},
  {get:async(actualOwner,input)=>{calls.load+=1;assert.equal(actualOwner,owner);assert.deepEqual(input,{loadId});return load as never},storedItemStatus:async(_db,actualOwner,instanceId)=>{calls.stored+=1;assert.equal(actualOwner,owner);assert.equal(instanceId,itemInstanceId);return options.storedStatus??'pending-adapter'}},
 )
 return {owner,loadId,itemInstanceId,contentId,contentHash,bytes,calls,source}
}

const valid={format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility}

test('读取固定行业岗位定义并返回不可变来源摘要',async()=>{
 const f=fixture(valid),value=await f.source.read({} as Pool,f.owner,f.loadId,f.itemInstanceId)
 assert.equal(value.loadId,f.loadId)
 assert.equal(value.itemInstanceId,f.itemInstanceId)
 assert.equal(value.itemLocalId,'analyst')
 assert.equal(value.contentId,f.contentId)
 assert.equal(value.contentHash,f.contentHash)
 assert.equal(value.itemVersion,'1.0.0')
 assert.equal(value.fileHash,sha(f.bytes))
 assert.equal(value.definition.name,'分析岗')
 assert.deepEqual(value.definition.responsibility,responsibility)
 assert.deepEqual(f.calls,{load:1,content:1,stored:1})
})

test('终审 I-2：模板 runtimeConfig 里的首选/备用模型被剥离且标记，只保留 agentPresetId；无模型字段时不标记',async()=>{
 const withModels=fixture({...valid,runtimeConfig:{agentPresetId:'security-analyst',model:{provider:'deepseek-official',model:'deepseek-flash'},fallbackModel:{provider:'other-cloud',model:'x'}}})
 const stripped=await withModels.source.read({} as Pool,withModels.owner,withModels.loadId,withModels.itemInstanceId)
 assert.deepEqual(stripped.definition.runtimeConfig,{agentPresetId:'security-analyst'});assert.equal(stripped.ignoredModelSelection,true)
 const onlyModel=fixture({...valid,runtimeConfig:{model:{provider:'deepseek-official',model:'deepseek-flash'}}})
 const dropped=await onlyModel.source.read({} as Pool,onlyModel.owner,onlyModel.loadId,onlyModel.itemInstanceId)
 assert.equal(dropped.definition.runtimeConfig,undefined);assert.equal(dropped.ignoredModelSelection,true)
 const plain=fixture({...valid,runtimeConfig:{agentPresetId:'security-analyst'}})
 const kept=await plain.source.read({} as Pool,plain.owner,plain.loadId,plain.itemInstanceId)
 assert.deepEqual(kept.definition.runtimeConfig,{agentPresetId:'security-analyst'});assert.equal(kept.ignoredModelSelection,false)
})

test('投影状态已实例化但存储列仍待适配时照常读取固定来源',async()=>{
 for(const projectedStatus of ['instantiated','active','detached']){
  const f=fixture(valid,{projectedStatus})
  const value=await f.source.read({} as Pool,f.owner,f.loadId,f.itemInstanceId)
  assert.equal(value.itemInstanceId,f.itemInstanceId)
  assert.equal(f.calls.stored,1)
 }
})

test('存储列为已跳过时拒绝读取，即使投影状态看起来可用',async()=>{
 for(const projectedStatus of ['pending-adapter','instantiated']){
  const f=fixture(valid,{projectedStatus,storedStatus:'skipped'})
  await assert.rejects(f.source.read({} as Pool,f.owner,f.loadId,f.itemInstanceId),{code:'teloa/source-unavailable'})
 }
})

test('拒绝错误格式、额外字段、公共来源与内容漂移',async()=>{
 const cases=[{...valid,format:'teloa.role/v2'},{...valid,label:'客户端伪造'},{...valid,kind:'unknown'}]
 for(const value of cases){
  const f=fixture(value)
  await assert.rejects(f.source.read({} as Pool,f.owner,f.loadId,f.itemInstanceId),{code:'teloa/source-unavailable'})
 }
 for(const options of [{publicSource:true},{contentDrift:true}]){
  const f=fixture(valid,options)
  await assert.rejects(f.source.read({} as Pool,f.owner,f.loadId,f.itemInstanceId),{code:'teloa/source-unavailable'})
 }
})
