import test from 'node:test'
import assert from 'node:assert/strict'
import {buildEmployeeKnowledgeGroups,filterEmployeeKnowledgeGroups,libraryResourceDirectory,listedEmployee} from '../src/client/resource-manager-presentation.ts'
import type {ResourceDirectory,WorkResource,SourceReference,RoleArtifactSummary} from '@teloa/contract'

const stamp='2024-01-01T00:00:00Z'
const resource=(id:string,sourceId:string,status:'active'|'withdrawn'='active'):WorkResource=>({
 id,ownerId:'owner-1',version:1,status,
 title:'Resource '+id,sourceId,sourceVersion:'a'.repeat(64),
 scopeIds:['general'],createdAt:stamp,updatedAt:stamp,
})
const knowledgeSource=(id:string):SourceReference=>({
 id,title:'KB '+id,source:'kb',version:'b'.repeat(64),bytes:100,
 knowledge:{knowledgeId:'33333333-3333-4333-a333-333333333333',knowledgeVersion:1,workspaceId:'default',category:'sop',topics:[],scopeIds:['general']},
})

test('buildEmployeeKnowledgeGroups 按员工分组资源，跳过无知识员工',()=>{
 const r1=resource('res-1','industry_sop_v1')
 const r2=resource('res-2','industry_policy_v1')
 const r3=resource('res-3','industry_ref_v1')
 const directory:ResourceDirectory={drafts:[],resources:[r1,r2,r3]}
 const roles=[
  {id:'role-a',kind:'employee' as const,state:'active' as const,name:'销售员工',knowledge:['res-1','res-2']},
  {id:'role-b',kind:'employee' as const,state:'active' as const,name:'运营员工',knowledge:['res-3']},
  {id:'role-c',kind:'employee' as const,state:'active' as const,name:'空员工',knowledge:[]},
 ]
 const groups=buildEmployeeKnowledgeGroups(roles,directory)
 assert.equal(groups.length,2,'空知识员工不生成分组')
 assert.equal(groups[0]!.roleId,'role-a')
 assert.equal(groups[0]!.roleName,'销售员工')
 assert.deepEqual(groups[0]!.resources,[r1,r2])
 assert.equal(groups[1]!.roleId,'role-b')
 assert.deepEqual(groups[1]!.resources,[r3])
})

test('buildEmployeeKnowledgeGroups 跳过找不到对应资源的知识 ID',()=>{
 const r1=resource('res-1','industry_sop_v1')
 const directory:ResourceDirectory={drafts:[],resources:[r1]}
 const roles=[{id:'role-a',kind:'employee' as const,state:'active' as const,name:'员工',knowledge:['res-1','missing-id']}]
 const groups=buildEmployeeKnowledgeGroups(roles,directory)
 assert.equal(groups.length,1)
 assert.equal(groups[0]!.resources.length,1)
 assert.equal(groups[0]!.resources[0]!.id,'res-1')
})

test('buildEmployeeKnowledgeGroups 所有知识都缺失时不生成空分组',()=>{
 const directory:ResourceDirectory={drafts:[],resources:[]}
 const roles=[{id:'role-a',kind:'employee' as const,state:'active' as const,name:'员工',knowledge:['missing-a','missing-b']}]
 const groups=buildEmployeeKnowledgeGroups(roles,directory)
 assert.equal(groups.length,0,'所有知识丢失时不应产生空分组')
})

// isLocalMaterialSourceId 要求格式 local_material_<uuid>，使用合法 UUID
const localSourceId='local_material_11111111-1111-4111-a111-111111111111'

test('libraryResourceDirectory 不传员工 ID 时不包含 industry 来源资源',()=>{
 const local=resource('loc-1',localSourceId)
 const ind=resource('ind-1','industry_sop_v1')
 const directory:ResourceDirectory={drafts:[],resources:[local,ind]}
 const sources:SourceReference[]=[]
 const result=libraryResourceDirectory(directory,sources)
 assert.ok(result.resources.some(r=>r.id==='loc-1'),'本地资料应被包含')
 assert.ok(!result.resources.some(r=>r.id==='ind-1'),'industry 资源默认不包含')
})

test('libraryResourceDirectory 传入员工资源 ID 集合时包含对应 industry 资源',()=>{
 const local=resource('loc-1',localSourceId)
 const ind=resource('ind-1','industry_sop_v1')
 const other=resource('other-1','some_other_source')
 const directory:ResourceDirectory={drafts:[],resources:[local,ind,other]}
 const sources:SourceReference[]=[]
 const result=libraryResourceDirectory(directory,sources,new Set(['ind-1']))
 assert.ok(result.resources.some(r=>r.id==='ind-1'),'员工知识资源应被包含')
 assert.ok(!result.resources.some(r=>r.id==='other-1'),'非员工来源的其他资源不包含')
})

test('libraryResourceDirectory 仍包含带 knowledge 元数据的 paste 资源',()=>{
 const paste=resource('paste-1','knowledge_abc123')
 const directory:ResourceDirectory={drafts:[],resources:[paste]}
 const sources:SourceReference[]=[knowledgeSource('knowledge_abc123')]
 const result=libraryResourceDirectory(directory,sources)
 assert.ok(result.resources.some(r=>r.id==='paste-1'),'paste 知识资源应始终包含')
})

test('buildEmployeeKnowledgeGroups 不列已退役员工与分身，暂停员工保留',()=>{
 const directory:ResourceDirectory={drafts:[],resources:[resource('res-1','industry_sop_v1')]}
 const role=(id:string,kind:'employee'|'twin',state:'active'|'paused'|'retired')=>({id,name:id,kind,state,knowledge:['res-1']})
 const groups=buildEmployeeKnowledgeGroups([role('retired','employee','retired'),role('twin','twin','active'),role('paused','employee','paused')],directory)
 assert.deepEqual(groups.map(g=>g.roleId),['paused'])
})

test('filterEmployeeKnowledgeGroups 按标题过滤资料，空分组不显示',()=>{
 const groups=[{roleId:'a',roleName:'A',resources:[resource('sop','industry_sop_v1'),resource('ref','industry_ref_v1')],outputs:[]},{roleId:'b',roleName:'B',resources:[resource('other','industry_x_v1')],outputs:[]}]
 assert.deepEqual(filterEmployeeKnowledgeGroups(groups,' SOP ').map(g=>[g.roleId,g.resources.map(r=>r.id)]),[['a',['sop']]])
 assert.equal(filterEmployeeKnowledgeGroups(groups,'').length,2)
})

const output=(id:string,title:string):RoleArtifactSummary=>({artifactId:id,number:1,title,source:{kind:'task',id:'task-'+id,scope:'general',version:'1',title:'来源任务'},createdAt:stamp,updatedAt:stamp,attribution:'task'})

test('buildEmployeeKnowledgeGroups 同时承载员工工作成果，只有成果的员工也出分组',()=>{
 const directory:ResourceDirectory={drafts:[],resources:[resource('res-1','industry_sop_v1')]}
 const role=(id:string,kind:'employee'|'twin',state:'active'|'paused'|'retired',knowledge:string[])=>({id,name:id,kind,state,knowledge})
 const outputs=new Map([['both',[output('a1','周报')]],['only-output',[output('a2','调研结论')]],['retired',[output('a3','旧成果')]],['twin',[output('a4','分身成果')]],['empty',[]]])
 const groups=buildEmployeeKnowledgeGroups([role('both','employee','active',['res-1']),role('only-output','employee','paused',[]),role('retired','employee','retired',['res-1']),role('twin','twin','active',[]),role('empty','employee','active',[])],directory,outputs)
 assert.deepEqual(groups.map(g=>[g.roleId,g.resources.map(r=>r.id),g.outputs.map(o=>o.artifactId)]),[['both',['res-1'],['a1']],['only-output',[],['a2']]])
 assert.deepEqual(buildEmployeeKnowledgeGroups([role('both','employee','active',['res-1'])],directory)[0]!.outputs,[],'未取得成果目录时只列资料')
})

test('listedEmployee 只认在岗或暂停的员工，与分组口径一致',()=>{
 assert.equal(listedEmployee({kind:'employee',state:'paused'}),true)
 assert.equal(listedEmployee({kind:'employee',state:'retired'}),false)
 assert.equal(listedEmployee({kind:'twin',state:'active'}),false)
})

test('filterEmployeeKnowledgeGroups 同步按标题过滤工作成果，仅成果命中也保留分组',()=>{
 const groups=[{roleId:'a',roleName:'A',resources:[resource('sop','industry_sop_v1')],outputs:[output('o1','季度周报'),output('o2','调研结论')]},{roleId:'b',roleName:'B',resources:[resource('x','industry_x_v1')],outputs:[]}]
 assert.deepEqual(filterEmployeeKnowledgeGroups(groups,'周报').map(g=>[g.roleId,g.resources.length,g.outputs.map(o=>o.artifactId)]),[['a',0,['o1']]])
 assert.deepEqual(filterEmployeeKnowledgeGroups(groups,'').map(g=>g.outputs.length),[2,0])
})
