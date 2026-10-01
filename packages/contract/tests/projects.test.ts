import test from 'node:test'
import assert from 'node:assert/strict'
import {projectDefinition,readProject,readProjectDetail,projectSummary,readProjectReference,readProjectReferenceItem,projectOverviewInput,readProjectOverviewPage,type ProjectItem} from '../src/projects.ts'

const id='10000000-0000-4000-8000-000000000001'
const fields={scope:'general',title:' Release ',goal:' Ship the new product ',dueDate:null,state:'planning',links:[]}
const project={...fields,title:'Release',goal:'Ship the new product',id,ownerId:'owner',version:1,createdAt:'2026-09-24T00:00:00.000Z',updatedAt:'2026-09-24T00:00:00.000Z'}

test('项目定义归一化且业务范围与关系类型不限于安全业务',()=>{
 assert.equal(projectDefinition(fields).title,'Release')
 assert.equal(projectDefinition({...fields,scope:'marketing',dueDate:'2028-02-29',links:[{kind:'role',id}]}).links[0]?.id,id)
 assert.equal(readProject(project).ownerId,'owner')
})
test('拒绝未知字段、无效日期、过长字段和未知生命周期',()=>{
 for(const patch of [{extra:true},{title:' '},{goal:'x'.repeat(8001)},{scope:'../secret'},{dueDate:'2026-02-29'},{dueDate:'2026-9-1'},{state:'done'}])assert.throws(()=>projectDefinition({...fields,...patch}),{code:'teloa/invalid-input'})
})
test('关系必须有合法身份、固定类型且不重复',()=>{
 for(const links of [[{kind:'folder',id}],[{kind:'task',id:'bad'}],[{kind:'task',id},{kind:'task',id}],[{kind:'task',id,ownerId:'other'}],Array.from({length:301},()=>({kind:'task',id}))])assert.throws(()=>projectDefinition({...fields,links}),{code:'teloa/invalid-input'})
})
test('严格读取项目身份和版本，缺字段不变成空项目',()=>{
 for(const patch of [{id:'bad'},{version:0},{ownerId:''},{updatedAt:'yesterday'},{links:undefined}])assert.throws(()=>readProject({...project,...patch}))
})
test('汇总由真实任务状态生成，取消不冒充已完成，不可用对象仍保留',()=>{
 const item=(suffix:string,state:string,attention:null|'review'=null):ProjectItem=>({kind:'task',id:id.slice(0,-1)+suffix,title:'Task',version:1,state,available:true,origin:'direct',attention})
 const items:ProjectItem[]=[item('2','completed'),item('3','cancelled'),item('4','waiting','review'),{kind:'group',id,title:null,version:null,state:null,available:false,origin:'direct',attention:null}]
 assert.deepEqual(projectSummary(items),{totalTasks:3,completedTasks:1,cancelledTasks:1,attentionTasks:1})
 assert.equal(readProjectDetail({project,items,summary:projectSummary(items),references:[]}).items.length,4)
 assert.throws(()=>readProjectDetail({project,items,summary:{totalTasks:3,completedTasks:3,cancelledTasks:0,attentionTasks:0}}))
 assert.throws(()=>readProjectDetail({project,items:[...items,items[0]],summary:projectSummary(items)}))
 assert.throws(()=>readProjectDetail({project,items:[{...items[0],state:'success'}],summary:projectSummary([items[0]!])}))
})

const ref=(suffix:string,scope='SOC',kind:'task'|'resource'|'plan'='task')=>({kind,id:id.slice(0,-1)+suffix,scope})
test('定义缺失 references 解析为空数组；显式给出时去重排序，不得指向主业务，最多 100 条',()=>{
 assert.deepEqual(projectDefinition(fields).references,[])
 assert.deepEqual(projectDefinition({...fields,references:[ref('2','SOC'),ref('1','AppSec'),ref('1','SOC','resource')]}).references,[ref('1','AppSec'),ref('1','SOC','resource'),ref('2','SOC')])
 assert.deepEqual(projectDefinition({...fields,references:[ref('1','SOC'),ref('1','AppSec')]}).references.map(item=>item.scope),['AppSec','SOC'])
 for(const references of [[ref('1'),ref('1')],[ref('1','general')],[{kind:'task',id}],[{...ref('1'),extra:true}],[ref('1','../x')],Array.from({length:101},(_,i)=>ref(String(i%10),'s'+i))])assert.throws(()=>projectDefinition({...fields,references}),{code:'teloa/invalid-input'})
 assert.deepEqual(readProjectReference(ref('3')),{kind:'task',id:id.slice(0,-1)+'3',scope:'SOC'})
})
test('引用条目不可用时不得带标题/状态/版本，可用时校验状态与版本',()=>{
 const base={...ref('1'),title:'Task',state:'ready',version:1,available:true}
 assert.deepEqual(readProjectReferenceItem(base),base)
 assert.deepEqual(readProjectReferenceItem({...ref('1'),title:null,state:null,version:null,available:false}),{...ref('1'),title:null,state:null,version:null,available:false})
 for(const patch of [{available:false},{state:'success'},{version:0},{title:''},{origin:'direct'},{available:'yes'}])assert.throws(()=>readProjectReferenceItem({...base,...patch}),{code:'teloa/invalid-input'})
})
test('详情回包必须含 references 且恰好四键，引用不进 items 与汇总',()=>{
 const items:ProjectItem[]=[],references=[{...ref('1'),title:'Task',state:'ready',version:1,available:true}]
 assert.deepEqual(readProjectDetail({project:{...project,references:[ref('1')]},items,summary:projectSummary(items),references}).references,references)
 assert.equal(readProjectDetail({project,items,summary:projectSummary(items),references:[]}).summary.totalTasks,0)
 assert.throws(()=>readProjectDetail({project,items,summary:projectSummary(items)}),{code:'teloa/invalid-input'})
 assert.throws(()=>readProjectDetail({project,items,summary:projectSummary(items),references:[],extra:1}),{code:'teloa/invalid-input'})
 assert.throws(()=>readProjectDetail({project,items,summary:projectSummary(items),references:[references[0],references[0]]}),{code:'teloa/invalid-input'})
})
test('总览输入恰好四键、limit 1..100、cursor 形如 iso|uuid',()=>{
 const input={scope:null,state:null,cursor:null,limit:20}
 assert.deepEqual(projectOverviewInput(input),input)
 assert.deepEqual(projectOverviewInput({scope:'SOC',state:'archived',cursor:'2026-09-25T00:00:00.000Z|'+id,limit:100}),{scope:'SOC',state:'archived',cursor:'2026-09-25T00:00:00.000Z|'+id,limit:100})
 for(const patch of [{limit:101},{limit:0},{limit:1.5},{cursor:'not-a-cursor'},{cursor:'2026-09-25T00:00:00.000Z|bad'},{state:'bogus'},{scope:'../x'},{extra:1}])assert.throws(()=>projectOverviewInput({...input,...patch}),{code:'teloa/invalid-input'})
 assert.throws(()=>projectOverviewInput({scope:null,state:null,limit:20}),{code:'teloa/invalid-input'})
})
test('总览 state 放行 current（非归档），null 仍为全部；未知取值与空串拒绝',()=>{
 assert.deepEqual(projectOverviewInput({scope:null,state:'current',cursor:null,limit:50}),{scope:null,state:'current',cursor:null,limit:50})
 assert.equal(projectOverviewInput({scope:null,state:null,cursor:null,limit:50}).state,null)
 for(const state of ['active',''])assert.throws(()=>projectOverviewInput({scope:null,state,cursor:null,limit:50}),{code:'teloa/invalid-input'})
})
test('总览回包恰好两键，rows 去重，nextCursor 为 null 或合法游标',()=>{
 assert.deepEqual(readProjectOverviewPage({rows:[project],nextCursor:null}).rows[0]?.id,id)
 assert.equal(readProjectOverviewPage({rows:[],nextCursor:project.updatedAt+'|'+id}).nextCursor,project.updatedAt+'|'+id)
 for(const value of [{rows:[project,project],nextCursor:null},{rows:[project]},{rows:[project],nextCursor:'x'},{rows:[project],nextCursor:null,extra:1},{rows:{},nextCursor:null}])assert.throws(()=>readProjectOverviewPage(value),{code:'teloa/invalid-input'})
})
