import test from 'node:test'
import assert from 'node:assert/strict'
import type {ResourceDraft,SourceReference,WorkResource} from '@teloa/contract'
import {createResourceApi} from '../src/client/resource-api.ts'
import {createLocalMaterialRegistration} from '../src/client/local-material-registration.ts'
import {libraryResourceDirectory,filterResourceManagerDirectory} from '../src/client/resource-manager-presentation.ts'

const registrationId='11111111-1111-4111-8111-111111111111',draftRequestId='22222222-2222-4222-8222-222222222222',draftId='33333333-3333-4333-8333-333333333333'
const fields={title:'本机制度',path:'资料/制度.md',scopeIds:['general']},ref:SourceReference={id:'local_material_'+registrationId,title:fields.title,source:fields.path,version:'a'.repeat(64),bytes:12}
const draft:ResourceDraft={id:draftId,ownerId:'owner',requestId:draftRequestId,title:fields.title,sourceId:ref.id,sourceVersion:ref.version,scopeIds:fields.scopeIds,version:1,status:'draft',createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z'}
test('本机原件登记与草稿未知回包恢复原两个请求，固定来源版本，不自动 apply',async()=>{
 let raw:string|null=null,registrationLost=true,draftLost=true
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},calls:Array<[string,unknown]>=[]
 const api=createResourceApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(endpoint==='resources/register-local-material'){if(registrationLost){registrationLost=false;throw Error('登记回包未知')}return ref}if(endpoint==='resources/create'){if(draftLost){draftLost=false;throw Error('草稿回包未知')}return draft}throw Error('不得自动 apply')})
 let sequence=0;const first=createLocalMaterialRegistration(api,journal,()=>[registrationId,draftRequestId][sequence++]!)
 await assert.rejects(first.begin(fields),/登记回包未知/);assert.ok(raw)
 const second=createLocalMaterialRegistration(api,journal);await assert.rejects(second.recover(),/草稿回包未知/)
 assert.deepEqual(calls[0],calls[1]);assert.equal(second.pending()?.source?.version,ref.version)
 const third=createLocalMaterialRegistration(api,journal);assert.deepEqual(await third.recover(),draft);assert.deepEqual(calls[2],calls[3]);assert.equal(raw,null)
 assert.deepEqual(calls.map(([endpoint])=>endpoint),['resources/register-local-material','resources/register-local-material','resources/create','resources/create'])
})
test('登记拒绝伪来源/知识元数据与错误草稿回执；明确 rejected 清除原记录',async()=>{
 const api=createResourceApi(async()=>({...ref,id:'knowledge_'+registrationId}))
 assert.ok(api.registerLocalMaterial);await assert.rejects(api.registerLocalMaterial({requestId:registrationId,...fields}),/格式/)
 let raw:string|null=null;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 let sequence=0;const rejected=createLocalMaterialRegistration(createResourceApi(async()=>{throw Object.assign(Error('明确拒绝'),{rejected:true})}),journal,()=>[registrationId,draftRequestId][sequence++ % 2]!)
 await assert.rejects(rejected.begin(fields),/拒绝/);assert.equal(raw,null)
 const wrong=createLocalMaterialRegistration(createResourceApi(async endpoint=>endpoint==='resources/register-local-material'?ref:{...draft,sourceVersion:'b'.repeat(64)}),journal,()=>[registrationId,draftRequestId][sequence++ % 2]!)
 await assert.rejects(wrong.begin(fields),/回执/);assert.ok(raw)
})
test('本机文件原目录可查、选中及保留撤回状态，不生成知识页元数据',()=>{
 const {requestId:_,status:__,...base}=draft,resource:WorkResource={...base,status:'active'},withdrawn:WorkResource={...resource,id:'44444444-4444-4444-8444-444444444444',status:'withdrawn'}
 const directory=libraryResourceDirectory({drafts:[draft],resources:[resource,withdrawn,{...resource,id:'55555555-5555-4555-8555-555555555555',sourceId:'public-policy'}]},[ref])
 assert.deepEqual(directory.resources.map(row=>[row.id,row.status]),[[resource.id,'active'],[withdrawn.id,'withdrawn']]);assert.deepEqual(directory.drafts,[draft])
 assert.equal(filterResourceManagerDirectory(directory,'资料/制度.md',[ref]).resources[0]?.id,resource.id)
 assert.equal(Object.hasOwn(directory.resources[0]!,'knowledgeId'),false);assert.equal(Object.hasOwn(ref,'knowledge'),false)
 assert.equal(libraryResourceDirectory(directory,[]).resources.find(row=>row.id===withdrawn.id)?.status,'withdrawn')
})
