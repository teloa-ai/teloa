import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {IndustryPluginSource} from '../src/work/industry-plugin-source.ts'

const enc=new TextEncoder()
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')

function fixture(definition:unknown,options:{publicSource?:boolean;contentDrift?:boolean;fileDrift?:boolean}={}){
 const owner=randomUUID(),loadId=randomUUID(),itemInstanceId=randomUUID(),contentId=randomUUID(),contentHash='a'.repeat(64),bytes=enc.encode(JSON.stringify(definition)),path='plugins/visualize.json'
 const resource={id:'visualize-plugin',kind:'plugin',title:'可视化插件',version:'1.0.0',required:true,source:options.publicSource?{kind:'public',id:'visualize-plugin',version:'1.0.0'}:{kind:'local',path}}
 const manifest={format:'teloa.business-package/v2',id:'security',title:'安全运营',version:'1.0.0',domain:'security',description:'安全模板',resources:[resource],relations:[],entrypoints:[]}
 const load={id:loadId,ownerId:owner,contentId,contentHash,templateId:'security',templateVersion:'1.0.0',templateTitle:'安全运营',domain:'security',description:'安全模板',targetVersion:1,space:{id:randomUUID(),name:'SOC',version:1,scope:'space-'+randomUUID()},items:[{localId:'visualize-plugin',instanceId:itemInstanceId,kind:'plugin',title:'可视化插件',version:'1.0.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[],createdAt:new Date().toISOString()}
 const content={id:contentId,ownerId:owner,kind:'industry-template',logicalId:'security',version:'1.0.0',hash:options.contentDrift?'b'.repeat(64):contentHash,baseHash:'c'.repeat(64),manifestPath:'teloa.json',metadata:manifest,files:options.publicSource?[]:[{path,hash:options.fileDrift?'d'.repeat(64):sha(bytes),bytes}],provides:options.publicSource?[]:[{resourceId:'visualize-plugin',kind:'plugin',version:'1.0.0',path}],references:[],createdAt:new Date().toISOString()}
 const calls:{load:number;content:number}={load:0,content:0}
 const source=new IndustryPluginSource(
  {getInTransaction:async(_db,actor,input)=>{calls.content+=1;assert.deepEqual(actor,{ownerId:owner,kind:'human'});assert.deepEqual(input,{contentId});return content as never}},
  {getInTransaction:async(_db,actualOwner,input)=>{calls.load+=1;assert.equal(actualOwner,owner);assert.deepEqual(input,{loadId});return load as never},storedItemStatus:async(_db,actualOwner,instanceId)=>{assert.equal(actualOwner,owner);assert.equal(instanceId,itemInstanceId);return 'pending-adapter' as const}},
 )
 return {owner,loadId,itemInstanceId,contentId,contentHash,bytes,calls,source}
}

const valid={format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}

test('读取固定行业插件定义并返回不可变来源摘要',async()=>{
 const f=fixture(valid),value=await f.source.read({} as PoolClient,f.owner,{loadId:f.loadId,itemInstanceId:f.itemInstanceId})
 assert.deepEqual(value.definition,valid)
 assert.equal(value.loadId,f.loadId)
 assert.equal(value.itemInstanceId,f.itemInstanceId)
 assert.equal(value.itemLocalId,'visualize-plugin')
 assert.equal(value.contentId,f.contentId)
 assert.equal(value.contentHash,f.contentHash)
 assert.equal(value.itemVersion,'1.0.0')
 assert.equal(value.fileHash,sha(f.bytes))
 assert.deepEqual(f.calls,{load:1,content:1})
})

test('拒绝额外字段、错误格式、非 npm registry 和非精确版本',async()=>{
 const cases=[
  {...valid,label:'客户端伪造'},
  {...valid,format:'teloa.plugin/v2'},
  {...valid,registry:'github'},
  {...valid,version:'^0.1.2'},
  {...valid,packageName:'DSH Visualize'},
 ]
 for(const [index,value] of cases.entries()){
  if(index===0)(value as Record<string,unknown>).extra=true
  const f=fixture(value)
  await assert.rejects(f.source.read({} as PoolClient,f.owner,{loadId:f.loadId,itemInstanceId:f.itemInstanceId}),{code:'teloa/source-unavailable'})
 }
})

test('拒绝公共插件引用、内容漂移和文件摘要漂移',async()=>{
 for(const options of [{publicSource:true},{contentDrift:true},{fileDrift:true}]){
  const f=fixture(valid,options)
  await assert.rejects(f.source.read({} as PoolClient,f.owner,{loadId:f.loadId,itemInstanceId:f.itemInstanceId}),{code:'teloa/source-unavailable'})
 }
})
