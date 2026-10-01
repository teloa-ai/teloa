import assert from 'node:assert/strict'
import test from 'node:test'
import {createResourceApi} from '../src/client/resource-api.ts'

const id='10000000-0000-4000-8000-000000000001',sourceId='20000000-0000-4000-8000-000000000001',hash='a'.repeat(64),createdAt='2026-09-12T00:00:00.000Z'
const summary={knowledgeId:id,ownerId:'self',sourceId,sourceType:'paste' as const,version:1,contentHash:hash,bytes:8,createdAt}
const version={...summary,markdown:'# 标题'}
const item={id,ownerId:'self',sourceId,sourceType:'paste' as const,workspaceId:'default',title:'知识',category:'reference' as const,topics:[],scopeIds:['general'],currentVersion:1,status:'active' as const,createdAt,updatedAt:createdAt}
const resource={id:'33333333-3333-4333-8333-333333333333',ownerId:item.ownerId,title:item.title,sourceId:'knowledge_'+item.id,sourceVersion:version.contentHash,scopeIds:['general'],version:1,status:'active' as const,createdAt,updatedAt:createdAt}
const space={id:'space_default',ownerId:'self',workspaceId:'default',title:'知识库',rootNodeId:'root_default',directoryRevision:1,scopeIds:['general'],createdAt,updatedAt:createdAt}
const root={id:'root_default',spaceId:space.id,parentId:null,type:'space' as const,title:'知识库',siblingOrder:0,path:['root_default'],createdAt,updatedAt:createdAt}
const folder={id:'44444444-4444-4444-8444-444444444444',spaceId:space.id,parentId:root.id,type:'folder' as const,title:'安全运营',siblingOrder:0,path:[root.id,'44444444-4444-4444-8444-444444444444'],createdAt,updatedAt:createdAt}
const mutation={space:{...space,directoryRevision:2},node:folder}

test('知识版本客户端读取历史，并通过原子端点修订和恢复可引用版本',async()=>{
 const calls:Array<[string,unknown]>=[]
 const api=createResourceApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(endpoint==='knowledge/list-versions')return[summary];if(endpoint==='knowledge/read-version')return version;return{knowledge:{item,version},resource}})
 assert.deepEqual(await api.listKnowledgeVersions(id),[summary])
 assert.deepEqual(await api.readKnowledgeVersion(id,1),version)
 assert.deepEqual(await api.reviseKnowledgeResource({requestId:id,knowledgeId:id,expectedKnowledgeVersion:1,resourceId:resource.id,expectedResourceVersion:1,markdown:'# 标题'}),{knowledge:{item,version},resource})
 assert.deepEqual(await api.restoreKnowledgeResource({requestId:id,knowledgeId:id,expectedKnowledgeVersion:1,resourceId:resource.id,expectedResourceVersion:1,restoreVersion:1}),{knowledge:{item,version},resource})
 assert.deepEqual(calls.map(([endpoint])=>endpoint),['knowledge/list-versions','knowledge/read-version','knowledge/revise-resource','knowledge/restore-resource'])
})

test('知识目录客户端读取真实树并执行带目录修订的治理操作',async()=>{
 const calls:Array<[string,unknown]>=[]
 const api=createResourceApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='knowledge/tree'?{space,nodes:[root]}:mutation})
 assert.deepEqual(await api.knowledgeTree(),{space,nodes:[root]})
 assert.deepEqual(await api.createKnowledgeFolder({requestId:id,parentId:root.id,title:'安全运营',expectedDirectoryRevision:1}),mutation)
 assert.deepEqual(await api.renameKnowledgeNode({requestId:id,nodeId:folder.id,title:'SOC',expectedDirectoryRevision:2}),mutation)
 assert.deepEqual(await api.moveKnowledgeNode({requestId:id,nodeId:folder.id,parentId:root.id,position:0,expectedDirectoryRevision:2}),mutation)
 assert.deepEqual(calls.map(([endpoint])=>endpoint),['knowledge/tree','knowledge/create-folder','knowledge/rename-node','knowledge/move-node'])
})

test('知识版本客户端拒绝跨知识身份和损坏响应',async()=>{
 const wrong='30000000-0000-4000-8000-000000000001'
 await assert.rejects(createResourceApi(async()=>({...version,knowledgeId:wrong})).readKnowledgeVersion(id,1),/格式/)
 await assert.rejects(createResourceApi(async()=>[{...summary,contentHash:'bad'}]).listKnowledgeVersions(id),/格式/)
 await assert.rejects(createResourceApi(async()=>({knowledge:{item,version},resource:{...resource,sourceId:'knowledge_'+wrong}})).reviseKnowledgeResource({requestId:id,knowledgeId:id,expectedKnowledgeVersion:1,resourceId:resource.id,expectedResourceVersion:1,markdown:'# 标题'}),/格式/)
})
