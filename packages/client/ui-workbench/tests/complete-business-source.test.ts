import {dashboardResourceFixture} from './fixtures/business-dashboard-resource.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import type {DigitalRole,EmployeeKnowledgeContent,WorkResource} from '@teloa/contract'
import {createCompleteBusinessSource} from '../src/client/complete-business-source.ts'
import {buildCompleteBusinessPackage} from '../src/client/complete-business-package.ts'
import {createBusinessShareApi} from '../src/client/business-share-flow.ts'

const id=(n:number)=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111',hash=(value:string)=>createHash('sha256').update(value).digest('hex'),at='2026-10-29T00:00:00.000Z'
const role:DigitalRole={id:id(1),ownerId:'test-owner',kind:'employee',name:'Export employee',scopes:['general'],state:'active',version:2,duty:'Review the supplied acceptance document.',dataScope:'Acceptance documents',executionScope:'Read and edit supplied knowledge',skills:[],knowledge:[id(2)],createdAt:at,updatedAt:at}
const resource=(n:number,text:string):WorkResource=>({id:id(n),ownerId:role.ownerId,title:'Knowledge '+n,sourceId:'knowledge_'+id(n),sourceVersion:hash(text),scopeIds:['general'],version:1,status:'active',createdAt:at,updatedAt:at})
const text='Acceptance knowledge\n',raw=resource(2,text)
const document:EmployeeKnowledgeContent={roleId:role.id,resourceId:raw.id,documentId:'origin-document',knowledgeId:null,title:raw.title,bodyVersion:1,contentHash:raw.sourceVersion,bytes:Buffer.byteLength(text),resource:raw,origin:{resourceId:raw.id,sourceId:raw.sourceId,sourceVersion:raw.sourceVersion},editing:'fork-on-write',indexState:'not-enrolled',markdown:text}
const empty=()=>({objectTypes:[],views:[],actions:[],sources:[],available:{workTemplates:[],executionTools:[]}})
function fixture(){
 const strict:Array<unknown>=[],extraText='Unassigned business policy\n',extra=resource(3,extraText)
 let doc=document,pending=false,skillRevision=0,localRevision=0,reads=0
 const declarations=()=>({...empty(),sources:localRevision?[{sourceId:'changed-source'}]:[]})
 const ports={
  declarations:{read:async()=>declarations()},readDeclarations:async()=>declarations(),
  loads:{list:async()=>[]},roles:{list:async()=>[role,{...role,id:id(10),scopes:['other']},{...role,id:id(11),kind:'twin',knowledge:[]}]},industryRoles:{list:async()=>[]},industryKnowledge:{list:async()=>[]},market:{list:async()=>[],hydrate:async()=>{throw Error('Unexpected package read')}},
  resources:{
   directory:async()=>({resources:[raw,extra],drafts:[]}),sources:async()=>[{id:extra.sourceId,title:extra.title,version:extra.sourceVersion,knowledge:{knowledgeId:extra.id,knowledgeVersion:1,scopeIds:['general']}}],
   listKnowledgeVersions:async()=>[{knowledgeId:extra.id,version:1,contentHash:extra.sourceVersion}],readKnowledgeVersion:async()=>({ownerId:extra.ownerId,contentHash:extra.sourceVersion,markdown:extraText}),
   employeeKnowledge:{list:async(_roleId:string,options:unknown)=>{strict.push(options);if(pending)throw Object.assign(Error('Import pending'),{code:'teloa/conflict'});const {markdown:_markdown,...value}=doc;return [value]},read:async()=>{reads++;return document}},
  },skills:async()=>skillRevision?[{name:'changed'}]:[],
 }
 return {ports,source:createCompleteBusinessSource(ports as never),strict,extraText,setPending:()=>{pending=true},replaceHead:()=>{doc={...document,bodyVersion:2,contentHash:hash('changed'),resource:{...raw,id:id(20),sourceVersion:hash('changed')}}},changeDeclarations:()=>{localRevision++},changeSkills:()=>{skillRevision++},reads:()=>reads}
}

test('完整业务快照包含当前员工及未绑定员工的知识，前后严格复核且可生成可导入包',async()=>{
 const f=fixture(),snapshot=await f.source.read('general')
 assert.equal(snapshot.roles.length,1);assert.equal(snapshot.roles[0]!.role.id,role.id)
 assert.deepEqual(f.strict,[{requireReady:true},{requireReady:true}]);assert.equal(snapshot.knowledge?.[0]?.markdown,f.extraText)
 const result=await buildCompleteBusinessPackage({...snapshot,packageId:'acceptance-business',packageVersion:'1.0.0',title:'Acceptance business',description:'Acceptance business package'})
 assert.equal(result.counts.role,1);assert.equal(result.counts.knowledge,2)
 assert.ok(result.item.packageContent?.files.some(file=>new TextDecoder().decode(file.bytes)===f.extraText))
})

test('导入未接入时严格列表拒绝导出，用户普通旧文读取不被此调用替代',async()=>{
 const f=fixture();f.setPending();await assert.rejects(f.source.read('general'),{code:'teloa/conflict'});assert.equal(f.reads(),0)
})

test('正文读取期间员工知识已更新时拒绝混合版本快照',async()=>{
 const f=fixture(),read=f.ports.resources.employeeKnowledge.read
 f.ports.resources.employeeKnowledge.read=async()=>{const value=await read();f.replaceHead();return value}
 await assert.rejects(f.source.read('general'),{code:'teloa/version-conflict'})
})

test('正文读取期间本地声明变化时拒绝导出旧声明与新正文组合',async()=>{
 const f=fixture(),read=f.ports.resources.employeeKnowledge.read
 f.ports.resources.employeeKnowledge.read=async()=>{const value=await read();f.changeDeclarations();return value}
 await assert.rejects(f.source.read('general'),{code:'teloa/version-conflict'})
})

test('同名技能的安装正文发生变化时也拒绝混合快照',async()=>{
 const f=fixture();f.ports.roles.list=async()=>[{...role,skills:['method']}]
 f.ports.skills=async()=>[{name:'method',text:f.reads()?'changed':'old'}] as never
 await assert.rejects(f.source.read('general'),{code:'teloa/version-conflict'})
})

test('完整业务导出预览与下载绑定实际字节和用途，修改后拒绝下载',async()=>{
 const f=fixture(),snapshot=await f.source.read('general'),api=createBusinessShareApi(f.ports.declarations as never,{} as never,f.source).complete!
 const preview=await api.plan({...snapshot,packageId:'acceptance-business',packageVersion:'1.0.0',title:'Acceptance business',description:'Acceptance business package'})
 const archive=await api.download(preview.item,preview.inspection.digest,'Acceptance business package');assert.ok(archive.bytes.byteLength>0)
 const tampered=structuredClone(preview.item);const firstFile=tampered.packageContent!.files[0]!;firstFile.bytes[0]=firstFile.bytes[0]!^1
 await assert.rejects(api.download(tampered,preview.inspection.digest,'Acceptance business package'))
 await assert.rejects(api.download(preview.item,preview.inspection.digest,'Other purpose'))
})

test('跨业务员工只投影当前scope；其资料属于其他或多个scope时明确拒绝，不静默漏文',async()=>{
 const clean=fixture();clean.ports.roles.list=async()=>[{...role,scopes:['general','other']}]
 assert.deepEqual((await clean.source.read('general')).roles[0]!.role.scopes,['general'])
 for(const scopeIds of [['other'],['general','other']]){
  const f=fixture(),foreign={...document,resource:{...raw,scopeIds}}
  f.ports.roles.list=async()=>[{...role,scopes:['general','other']}]
  f.ports.resources.employeeKnowledge.list=async()=>{const {markdown:_markdown,...row}=foreign;return [row]}
  f.ports.resources.employeeKnowledge.read=async()=>foreign
  await assert.rejects(f.source.read('general'),{code:'teloa/complete-business-cross-scope'})
 }
})

test('未绑定员工的多scope资料和独立知识同样拒绝导出，不把限制收窄成单scope',async()=>{
 const f=fixture(),directory=f.ports.resources.directory
 f.ports.resources.directory=async()=>{const value=await directory();return {...value,resources:value.resources.map(row=>row.id===id(3)?{...row,scopeIds:['general','other']}:row)}}
 await assert.rejects(f.source.read('general'),{code:'teloa/complete-business-cross-scope'})
 const g=fixture(),sources=g.ports.resources.sources
 g.ports.resources.sources=async()=>[...await sources(),{id:'knowledge_'+id(4),title:'跨业务独立知识',version:hash('standalone'),knowledge:{knowledgeId:id(4),knowledgeVersion:1,scopeIds:['general','other']}}]
 await assert.rejects(g.source.read('general'),{code:'teloa/complete-business-cross-scope'})
})


test('完整源读取当前正式配置并前后比对摘要及内容，不能仅相信旧包配置',async()=>{
 const ports=()=>{const f=fixture();return {...f.ports,roles:{list:async()=>[]},resources:{...f.ports.resources,directory:async()=>({resources:[],drafts:[]}),sources:async()=>[]}}}
 const resource=dashboardResourceFixture();let calls=0
 const source=createCompleteBusinessSource({...ports(),readConfiguration:async(scope:string)=>{assert.equal(scope,'SOC');calls++;return {resource,configurationHash:'a'.repeat(64)}}} as never)
 assert.deepEqual((await source.read('SOC')).configuration,resource);assert.equal(calls,2)
 for(const change of ['hash','content'] as const){
  let reads=0
  const unstable=createCompleteBusinessSource({...ports(),readConfiguration:async()=>{const resource=dashboardResourceFixture();if(++reads===2&&change==='content')resource.configuration.title='Changed current configuration';return {resource,configurationHash:(reads===2&&change==='hash'?'b':'a').repeat(64)}}} as never)
  await assert.rejects(unstable.read('SOC'),{code:'teloa/version-conflict'})
 }
 const missing=createCompleteBusinessSource({...ports(),readConfiguration:async()=>null} as never);assert.equal((await missing.read('SOC')).configuration,null)
 const other=dashboardResourceFixture(),cross=createCompleteBusinessSource({...ports(),readConfiguration:async()=>({resource:other,configurationHash:'a'.repeat(64)})} as never)
 await assert.rejects(cross.read('AppSec'),{code:'teloa/complete-business-cross-scope'})
})
