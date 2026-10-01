import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as businessPreview from '../src/client/business-preview.ts'
import type {BusinessPreview} from '../src/client/business-preview.ts'
import {businessPageSurface} from '../src/client/business-page-mode.ts'
import * as presentation from '../src/client/project-presentation.ts'
import * as contract from '@teloa/contract'
import type {ProjectItem,ProjectReferenceItem,WorkProject} from '@teloa/contract'
import {mount,nodes} from './market-component-harness.ts'

test('通用空间显示项目，专业空间显示具体项目名称',()=>{
 const label=(businessPreview as Record<string,unknown>).projectTypeLabel as ((scope:string)=>string)|undefined
 assert.equal(label?.('general'),'项目')
 assert.equal(label?.('AppSec'),'审计项目')
 assert.equal(label?.('Design'),'项目')
})

test('项目固定主会话，并让任务会话从任务追溯所属项目',()=>{
 const state=businessPreview.businessExamples('2026-09-13T08:00:00.000Z') as BusinessPreview & {projects?:Array<Record<string,unknown>>}
 const project=state.projects?.find(row=>row.scope==='AppSec') as {
  id:string
  mainConversation?:{projectId:string;relation:string}
  tasks?:Array<{id:string;projectId:string;conversations:Array<{projectId:string;taskId:string;relation:string}>}>
 }|undefined
 assert.ok(project)
 assert.deepEqual(project.mainConversation,{projectId:project.id,relation:'main',id:'audit-main',title:'年度代码审计 · 主会话'})
 assert.ok(project.tasks && project.tasks.length>=2)
 for(const task of project.tasks){
  assert.equal(task.projectId,project.id)
  assert.ok(task.conversations.length>=1)
  for(const conversation of task.conversations){
   assert.equal(conversation.projectId,project.id)
   assert.equal(conversation.taskId,task.id)
   assert.equal(conversation.relation,'task')
  }
 }
})

test('项目聚合全部公共工作关系且每条关系保留项目身份',()=>{
 const state=businessPreview.businessExamples('2026-09-13T08:00:00.000Z') as BusinessPreview & {projects?:Array<Record<string,unknown>>}
 const projects=state.projects as Array<{
  id:string
  mainConversation:{projectId:string}
  tasks:Array<{projectId:string;conversations:Array<{projectId:string}>}>
  groups:Array<{projectId:string}>
  plans:Array<{projectId:string}>
  resources:Array<{projectId:string}>
  artifacts:Array<{projectId:string}>
 }> | undefined
 assert.equal(projects?.length,3)
 for(const project of projects??[]){
  assert.equal(project.mainConversation.projectId,project.id)
  for(const relation of [...project.tasks,...project.groups,...project.plans,...project.resources,...project.artifacts])assert.equal(relation.projectId,project.id)
 }
})

test('项目关系摘要把任务会话作为任务子关系而不是主会话同级项',()=>{
 const preview=businessPreview.businessExamples('2026-09-13T08:00:00.000Z') as BusinessPreview & {projects:Array<Record<string,unknown>>}
 const project=preview.projects.find(row=>row.scope==='AppSec')
 const summarize=(businessPreview as Record<string,unknown>).projectRelationshipSections as ((project:unknown)=>Array<{kind:string;count:number;childCount?:number}>)|undefined
 assert.deepEqual(summarize?.(project).map(row=>[row.kind,row.count,row.childCount??0]),[
  ['main-conversation',1,0],['tasks',3,4],['groups',1,0],['plans',1,0],['resources',2,0],['artifacts',2,0],
 ])
})

test('项目子页独立于数据连接状态呈现项目工作区',()=>{
 assert.equal(businessPageSurface({mode:'real',section:'projects' as never,scope:'AppSec'}),'project-workspace')
 assert.equal(businessPageSurface({mode:'sandbox',section:'projects' as never,scope:'AppSec'}),'project-workspace')
})

test('正式业务项目页不把同范围记录伪造成项目，并且目录入口不再使用空回调',async()=>{
 const client=new URL('../src/client/',import.meta.url)
 const [page,frame,workspace]=await Promise.all([
  readFile(new URL('BusinessPage.tsx',client),'utf8'),
  readFile(new URL('WorkbenchFrame.tsx',client),'utf8'),
  readFile(new URL('ProjectWorkspace.tsx',client),'utf8'),
 ])
 assert.doesNotMatch(page,/<ProjectWorkspace projects=\{\[\]\}/)
 assert.match(page,/<ProjectWorkspace[^>]*api=\{projectApi\}/)
 assert.match(page,/openItem=\{openProjectItem\}/)
 assert.match(frame,/artifactApi\.get\(item\.id\)/)
 assert.match(frame,/section==='projects'\)\{restorePending\.current\.spaces=false;settleBusinessTarget\(state\.businessTarget\);return\}/)
 assert.doesNotMatch(workspace,/persistentDirectoryUnavailable|mainConversation/)
})

test('详情页有跨业务引用分区：可用引用带业务名与只读标记可打开，不可用引用显示占位与提示且无打开按钮，归档时不显示添加/移除',()=>{
 const project:WorkProject={id:'10000000-0000-4000-8000-000000000001',ownerId:'self',version:1,createdAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z',scope:'general',title:'Launch',goal:'Ship',state:'running',dueDate:null,links:[],references:[{kind:'task',id:'30000000-0000-4000-8000-000000000001',scope:'SOC'},{kind:'resource',id:'30000000-0000-4000-8000-000000000002',scope:'SOC'}]}
 const live:ProjectReferenceItem={kind:'task',id:'30000000-0000-4000-8000-000000000001',scope:'SOC',title:'SOC triage',state:'ready',version:1,available:true}
 const gone:ProjectReferenceItem={kind:'resource',id:'30000000-0000-4000-8000-000000000002',scope:'SOC',title:null,state:null,version:null,available:false}
 const summary={totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0},opened:Array<ProjectItem|ProjectReferenceItem>=[],removed:ProjectReferenceItem[]=[]
 const view=mount('ProjectWorkspace.tsx',{'./project-presentation.js':presentation,'@teloa/contract':contract})
 const props={detail:{project,items:[],summary,references:[live,gone]},busy:false,back:()=>{},edit:()=>{},add:()=>{},addReference:()=>{},changeState:()=>{},remove:()=>{},removeReference:(ref:ProjectReferenceItem)=>removed.push(ref),open:(value:ProjectItem|ProjectReferenceItem)=>opened.push(value),refresh:()=>{},scopeName:(scope:string)=>scope==='SOC'?'Security Ops':scope}
 const tree=view.render('ProjectDetailView',props),all=nodes(tree)
 const section=all.find(node=>node.props['data-project-references']!==undefined);assert.ok(section,'有跨业务引用分区')
 const inside=nodes(section)
 const open=inside.find(node=>node.type==='button'&&node.props['data-project-reference']===live.id);assert.ok(open);open.props.onClick();assert.equal(opened[0],live)
 assert.ok(inside.some(node=>node.children.includes('Security Ops')),'显示业务名')
 assert.ok(inside.some(node=>node.children.includes('project.reference.readonly')),'显示只读标记')
 assert.equal(inside.find(node=>node.type==='button'&&node.props['data-project-reference']===gone.id),undefined,'不可用引用无打开按钮')
 assert.ok(inside.some(node=>node.children.includes('project.item.unavailable'))&&inside.some(node=>node.children.includes('project.reference.unavailableHint')))
 const remove=inside.find(node=>node.type==='button'&&node.props['data-project-reference-remove']===gone.id);assert.ok(remove);remove.props.onClick();assert.equal(removed[0],gone)
 assert.ok(inside.some(node=>node.type==='button'&&node.props['data-project-reference-add']!==undefined))
 assert.equal(all.filter(node=>node.props['data-project-item']!==undefined).length,0,'引用不进入六类分区')
 const archived=nodes(view.render('ProjectDetailView',{...props,detail:{...props.detail,project:{...project,state:'archived'}}}))
 assert.equal(archived.filter(node=>node.type==='button'&&(node.props['data-project-reference-remove']!==undefined||node.props['data-project-reference-add']!==undefined)).length,0)
})
