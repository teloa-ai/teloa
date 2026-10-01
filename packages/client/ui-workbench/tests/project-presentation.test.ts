import test from 'node:test'
import assert from 'node:assert/strict'
import {projectFields,filterProjects,projectProgress,removeProjectLink,removeProjectReference,referenceScopeName} from '../src/client/project-presentation.ts'
import * as presentation from '../src/client/project-presentation.ts'
import * as contract from '@teloa/contract'
import type {WorkProject,ProjectItem} from '@teloa/contract'
import {mount,nodes} from './market-component-harness.ts'
const project:WorkProject={id:'10000000-0000-4000-8000-000000000001',ownerId:'self',version:1,createdAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z',scope:'general',title:'Launch',goal:'Ship',state:'running',dueDate:null,links:[{kind:'task',id:'20000000-0000-4000-8000-000000000001'}],references:[]}
const item:ProjectItem={...project.links[0]!,title:'Report',version:1,state:'waiting',available:true,origin:'direct',attention:'review'}
test('项目过滤与进度不把取消或零任务当成交付',()=>{
 assert.equal(filterProjects([project,{...project,id:'archived',state:'archived'}],'ship',false).length,1)
 assert.equal(filterProjects([project],'missing',false).length,0)
 assert.deepEqual(projectProgress({totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0}),{completed:0,total:0,percent:null})
 assert.deepEqual(projectProgress({totalTasks:3,completedTasks:1,cancelledTasks:1,attentionTasks:1}),{completed:1,total:2,percent:50})
 assert.deepEqual(removeProjectLink(project,item).links,[])
 assert.throws(()=>removeProjectLink(project,{...item,origin:'automation'}))
 assert.equal(projectFields(project,{title:'New'}).scope,'general')
 const referenced={...project,references:[{kind:'task' as const,id:'30000000-0000-4000-8000-000000000001',scope:'SOC'}]}
 assert.deepEqual(projectFields(referenced,{title:'New'}).references,referenced.references,'编辑其他字段不丢失跨业务引用')
 assert.deepEqual(removeProjectLink(referenced,item).references,referenced.references)
})
test('详情导航传递准确对象，归档项目保留内容但不提供编辑和移除',()=>{
 const summary={totalTasks:1,completedTasks:0,cancelledTasks:0,attentionTasks:1},opened:ProjectItem[]=[]
 const view=mount('ProjectWorkspace.tsx',{'./project-presentation.js':presentation,'@teloa/contract':contract})
 const props={detail:{project,items:[item],summary,references:[]},busy:false,back:()=>{},edit:()=>{},add:()=>{},addReference:()=>{},changeState:()=>{},remove:()=>{},removeReference:()=>{},open:(value:ProjectItem)=>opened.push(value),refresh:()=>{},scopeName:(scope:string)=>scope}
 const tree=view.render('ProjectDetailView',props)
 const open=nodes(tree).find(node=>node.type==='button'&&node.props['data-project-item']===item.id)
 assert.ok(open);open.props.onClick();assert.equal(opened[0]?.id,item.id)
 const archived=view.render('ProjectDetailView',{...props,detail:{...props.detail,project:{...project,state:'archived'}}})
 assert.equal(nodes(archived).filter(node=>node.type==='button'&&node.props['data-project-edit']).length,0)
 assert.equal(nodes(archived).filter(node=>node.type==='button'&&node.props['data-project-remove']).length,0)
})
test('removeProjectReference 只删指定 (scope,kind,id) 且 links 不变；referenceScopeName 找不到标签回退 scope 码',()=>{
 const a={kind:'task' as const,id:'30000000-0000-4000-8000-000000000001',scope:'SOC'},b={...a,scope:'AppSec'},c={...a,kind:'resource' as const}
 const referenced={...project,references:[a,b,c]}
 const next=removeProjectReference(referenced,a)
 assert.deepEqual(next.references,[b,c].sort((x,y)=>x.scope.localeCompare(y.scope)||x.kind.localeCompare(y.kind)));assert.deepEqual(next.links,project.links)
 const labels=[{scope:'SOC',title:'安全运营',kind:'builtin' as const,loads:0,activeLoads:0,tasks:0,groups:0}]
 assert.equal(referenceScopeName(a,labels,scope=>scope),'安全运营')
 assert.equal(referenceScopeName(b,labels,scope=>scope),'AppSec')
 assert.equal(referenceScopeName(a,labels,scope=>scope==='SOC'?'Security Ops':scope),'Security Ops','本地化名称优先于标签原标题')
})
