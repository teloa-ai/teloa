import assert from 'node:assert/strict'
import test from 'node:test'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import * as projection from '../src/client/industry-workspace-projection.ts'
const {projectIndustryWorkspace}=projection

const kinds:IndustryLoadRecord['items'][number]['kind'][]=['role','knowledge','skill','mcp','plugin','work-template','plan','data-source','execution-tool']
const load:IndustryLoadRecord={
 id:'12345678-1234-4234-8234-123456789012',ownerId:'self',contentId:'22345678-1234-4234-8234-123456789012',contentHash:'f'.repeat(64),templateId:'operations',templateVersion:'4.2.0',templateTitle:'运营模板',domain:'operations',scope:'operations',description:'运营工作',targetVersion:2,
 space:{id:'32345678-1234-4234-8234-123456789012',name:'运营',version:2,scope:'space-32345678-1234-4234-8234-123456789012'},
 items:kinds.map((kind,index)=>({localId:'r'+index,instanceId:`42345678-1234-4234-8234-1234567890${String(index).padStart(2,'0')}`,kind,title:kind,version:'1.0.0',required:true,status:'pending-adapter'})),relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
}

test('九类加载实例投影到八个正式落点并完整保留固定血缘',()=>{
 const rows=projectIndustryWorkspace([load])
 assert.deepEqual(rows.map(row=>row.destination),['digital-employee','knowledge','team-capability','team-capability','extension','task','continuous-work','business-data','business-execution'])
 assert.equal(new Set(rows.map(row=>row.instanceId)).size,9)
 // 插件仍不进团队能力，但它有自己的落点：装在工作室层的扩展加载后必须看得见（业务结构七行分类法第七行）。
 assert.equal(rows.find(row=>row.kind==='plugin')?.destination,'extension')
 assert.equal(rows.find(row=>row.kind==='plugin')?.readiness,'已登记，待安装扩展')
 assert.deepEqual(rows[0]?.source,{loadId:load.id,contentId:load.contentId,contentHash:load.contentHash,templateId:load.templateId,templateTitle:load.templateTitle,templateVersion:load.templateVersion,spaceId:load.space.id,spaceName:load.space.name,spaceScope:load.space.scope,spaceVersion:load.space.version})
 assert.equal(rows.find(row=>row.kind==='work-template')?.readiness,'已登记，可创建任务')
 assert.equal(rows.find(row=>row.kind==='plan')?.readiness,'已登记，可创建自动化')
})

test('正式投影排除加载时跳过的资源并按空间和落点收窄',()=>{
 const skipped={...load,id:'52345678-1234-4234-8234-123456789012',items:load.items.map((item,index)=>index===0?{...item,status:'skipped' as const}:item)}
 const rows=projectIndustryWorkspace([skipped],{scope:load.space.scope,destination:'business-data'})
 assert.deepEqual(rows.map(row=>row.kind),['data-source'])
 assert.deepEqual(projectIndustryWorkspace([skipped],{scope:'space-other'}),[])
})

test('来源血缘保留资源实际加载到的空间版本而不是空间当前版本',()=>{
 const historical={...load,targetVersion:2,space:{...load.space,version:3}}
 const row=projectIndustryWorkspace([historical])[0]
 assert.equal(row?.source.spaceVersion,2)
})

test('业务概览固定展示八个落点及各自待办数量',()=>{
 assert.equal(typeof projection.summarizeIndustryWorkspace,'function')
 const summary=projection.summarizeIndustryWorkspace([load],load.space.scope)
 assert.deepEqual(summary.map(row=>[row.destination,row.count]),[
  ['digital-employee',1],['knowledge',1],['team-capability',2],['task',1],['continuous-work',1],['business-data',1],['business-execution',1],['extension',1],
 ])
 assert.deepEqual(projection.summarizeIndustryWorkspace([load],'space-other').map(row=>row.count),[0,0,0,0,0,0,0,0])
})
