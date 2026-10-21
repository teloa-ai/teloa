import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as savedState from '../src/client/saved-collaboration-state.ts'
import {groupHasSharedArtifactReference,groupSharedResults} from '../src/client/group-result-index.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import * as groupPanelPreference from '../src/client/group-panel-preference.ts'
import * as contract from '@teloa/contract'

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}
if(!('requestAnimationFrame'in globalThis))(globalThis as Record<string,unknown>).requestAnimationFrame=(callback:FrameRequestCallback)=>{callback(0);return 1}
const content=(node:any):string=>typeof node==='string'?node:node?.children?.map(content).join('')??''
const t=(key:string)=>key
// 与 3100 现场同构：安全群 scope=SOC；员工只服务 general 与各自的产品业务，不服务 SOC。
const outside={id:'r1',name:'质量工程师',kind:'employee',scopes:['general','business_quality'],state:'active',version:3,duty:'质量核对',avatarKey:undefined}
const serving={id:'r2',name:'告警分析员',kind:'employee',scopes:['SOC'],state:'active',version:1,duty:'核对告警'}
const retired={id:'r3',name:'旧分析员',kind:'employee',scopes:['SOC'],state:'retired',version:2,duty:'已退役'}
const read=(status:string)=>({groupVersion:1,roleVersion:1,grant:null,status})
const page=()=>mount('SavedCollaborationPage.tsx',{
 './business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营'})},
 './saved-collaboration-state.js':savedState,
 './group-result-index.js':{groupHasSharedArtifactReference,groupSharedResults},
 './saved-collaboration-drafts.js':{savedCollaborationDrafts:createSavedCollaborationDraftStore()},
 './group-panel-preference.js':groupPanelPreference,
 './group-message-refresh.js':{scheduleGroupMessageRefresh:()=>()=>{}},
 './task-preview.js':{taskStates:{ready:'status.ready'}},
 '@teloa/contract':contract,
 './GroupMembersPanel.js':{GroupMembersPanel:function GroupMembersPanel(){}},
 './i18n/provider.js':{useI18n:()=>({t,locale:'zh-CN',time:(at:string)=>at})},
},['SavedAgentGrantForm'])

test('成员栏按真实资格说明原因：不服务本群业务、不在岗与真实授权状态分开显示，授权入口仍可打开查看原因',()=>{
 const panel=mount('GroupMembersPanel.tsx',{'./i18n/provider.js':{useI18n:()=>({t})}})
 const opened:string[]=[]
 // 原因表由真实的群概览按本群业务计算后交给成员栏。
 const overview=page().render('SavedGroupOverview',{group:{id:'g1',scope:'SOC',version:1,archived:false},tasks:[],roles:[outside,serving,retired],profileName:'Max',blocked:false,work:undefined,tab:'members',members:['r1','r2','r3'],addMembers(){},changeTab(){},membersOnly:true,
  grants:{r1:read('not-granted'),r2:read('not-granted'),r3:read('not-granted')},configureGrant:(id:string)=>opened.push(id)})
 const memberProps=nodes(overview).find(node=>node.type?.name==='GroupMembersPanel')!.props
 assert.deepEqual(memberProps.grantBlocks,{r1:'scope',r3:'inactive'},'与服务端保存前置判据同口径：先业务范围后在岗')
 const tree=panel.render('GroupMembersPanel',memberProps)
 const rows=nodes(tree).filter(node=>node.type==='article')
 const row=(name:string)=>content(rows.find(node=>content(node).includes(name)))
 assert.ok(row('质量工程师').includes('group.members.notServing'),'不服务本群业务时直接说明原因')
 assert.ok(!row('质量工程师').includes('collaboration.agentGrant.status.not-granted'),'不用泛化的「未授权」掩盖原因')
 assert.ok(row('告警分析员').includes('collaboration.agentGrant.status.not-granted'),'服务本群业务的员工保留真实未授权状态')
 assert.ok(row('旧分析员').includes('group.members.inactive'),'不在岗如实说明')
 const grant=nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='group.members.grantAria')!
 assert.equal(grant.props.disabled,false,'仍可打开授权抽屉查看原因与员工档案入口');grant.props.onClick();assert.deepEqual(opened,['r1'])
 // 已有授权因范围变化失效：保留真实的失效状态，同时说明原因。
 const stale=panel.render('GroupMembersPanel',{groupId:'g1',grantBlocks:{r1:'scope'},members:['r1'],roles:[outside],tasks:[],profileName:'Max',blocked:false,addMembers(){},grants:{r1:read('invalidated')},configureGrant(){}})
 const text=content(nodes(stale).find(node=>node.type==='article'))
 assert.ok(text.includes('collaboration.agentGrant.status.invalidated')&&text.includes('group.members.notServing'))
})

test('授权抽屉：不服务本群业务或不在岗时不展示可保存的权限表单，明确原因并提供员工档案入口；服务本群业务时保留原表单',()=>{
 const app=page()
 const base={workResources:[],resources:[],attachments:[],artifacts:[],artifactSummaries:{},scope:'SOC',error:undefined,save(){assert.fail('不支持的员工不能提交授权')}}
 for(const [role,reason] of [[outside,'group.grant.notServing'],[retired,'group.grant.inactive']] as const){
  const opened:string[]=[]
  const tree=app.render('SavedAgentGrantForm',{...base,form:{role,read:read('not-granted')},close(){},openRole:(id:string)=>opened.push(id)})
  assert.ok(content(tree).includes(reason),'明确不可授权的原因')
  assert.equal(nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox').length,0,'不给可勾选的权限表单')
  assert.equal(nodes(tree).filter(node=>node.type==='button'&&node.props.type==='submit').length,0,'没有会让人以为保存必成的提交按钮')
  nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='group.grant.openProfile')!.props.onClick()
  assert.deepEqual(opened,[role.id],'进入现有员工档案（由页面关闭抽屉后打开原档案）')
 }
 const tree=app.render('SavedAgentGrantForm',{...base,form:{role:serving,read:read('not-granted')},close(){},openRole(){},save(){}})
 assert.ok(nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox').length>=2,'服务本群业务的在岗员工保留原表单')
 assert.ok(!content(tree).includes('group.grant.notServing'))
})

test('建群与添加成员选择器：不服务所选业务的员工照常可选，并提示不能在本群授权或自动响应',()=>{
 const app=page()
 const tree=app.render('SavedGroupForm',{form:{kind:'create',draft:{scope:'SOC'}},roles:[outside,serving],profileName:'Max',close(){},save(){},error:undefined})
 nodes(tree).find(node=>node.props.role==='tab'&&content(node)==='collaboration.form.tab.members')?.props.onClick()
 const picker=app.render('SavedGroupForm',{form:{kind:'create',draft:{scope:'SOC'}},roles:[outside,serving],profileName:'Max',close(){},save(){},error:undefined})
 const labels=nodes(picker).filter(node=>node.type==='label'&&node.props.className==='groupMemberChoice')
 const label=(name:string)=>labels.find(node=>content(node).includes(name))!
 assert.ok(content(label('质量工程师')).includes('group.members.notServingHint'))
 assert.ok(!content(label('告警分析员')).includes('group.members.notServingHint'))
 assert.equal(nodes(label('质量工程师')).find(node=>node.type==='input')!.props.disabled,false,'只提示，不改变原成员资格')
})

test('建群范围选择：通用业务在群选择器里表达为跨业务协作，并用一句话区分跨业务群与业务专属群；全平台业务名称不变',()=>{
 // 每次独立挂载：已选业务来自本人草稿（新建默认 general），不是入口业务。
 const render=(scope?:string)=>page().render('SavedGroupForm',{form:{kind:'create',...scope?{draft:{scope}}:{}},roles:[outside,serving],profileName:'Max',close(){},save(){},error:undefined})
 const general=render(),options=nodes(general).filter(node=>node.type==='option')
 assert.equal(content(options.find(node=>node.props.value==='general')),'group.scope.crossBusiness')
 assert.equal(content(options.find(node=>node.props.value==='SOC')),'安全运营','其他业务沿用平台名称')
 assert.ok(content(general).includes('group.scope.crossBusinessHint'))
 assert.ok(content(render('SOC')).includes('group.scope.dedicatedHint'))
})
