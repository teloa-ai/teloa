import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as savedState from '../src/client/saved-collaboration-state.ts'
import {groupHasSharedArtifactReference,groupSharedResults} from '../src/client/group-result-index.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import * as groupPanelPreference from '../src/client/group-panel-preference.ts'
import {isCompletedGroupReply} from '../src/client/group-task-source-presentation.ts'

// 此父层状态夹具未挂浏览器；补上焦点观察面，真实焦点由浏览器用例验。
if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}
if(!('requestAnimationFrame'in globalThis))(globalThis as Record<string,unknown>).requestAnimationFrame=(callback:FrameRequestCallback)=>{callback(0);return 1}
const content=(node:any):string=>typeof node==='string'?node:node?.children?.map(content).join('')??''
const group={id:'g1',name:'核对群',scope:'general',version:1,archived:false,pinned:false,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}}
const roles=[{id:'r1',name:'林析',kind:'employee',scopes:['general'],state:'active',duty:'核对证据'}]
function page(archived=false){
 const app=mount('SavedCollaborationPage.tsx',{
  './business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作'})},
  './saved-collaboration-state.js':savedState,
  './group-result-index.js':{groupHasSharedArtifactReference,groupSharedResults},
  './saved-collaboration-drafts.js':{savedCollaborationDrafts:createSavedCollaborationDraftStore()},
  './group-panel-preference.js':groupPanelPreference,
  './group-message-refresh.js':{scheduleGroupMessageRefresh:()=>()=>{}},
  './task-preview.js':{taskStates:{ready:'status.ready'}},
  './GroupMembersPanel.js':{GroupMembersPanel:function GroupMembersPanel(){}},
  './GroupLinkedWork.js':{GroupLinkedWork:function GroupLinkedWork(){},isCompletedGroupReply},
  './i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'zh-CN',time:(at:string)=>at,date:(at:string)=>at.slice(0,10),dateTime:(at:string)=>at})},
 },['SavedMessage'])
 const props={visible:true,target:{groupId:'g1',rootId:''},roles,profileName:'Max',api:{
  get:async()=>({group:{...group,archived},members:[{roleId:null},{roleId:'r1'}]}),
  messages:async()=>({items:[]}),resources:async()=>({items:[]}),list:async()=>({items:[]}),
  agentGrant:async()=>({status:'not-granted'}),pending:()=>undefined,recoveryMessage:()=>undefined,
 }}
 return {app,props}
}
async function load(app:any,props:any){
 app.render('SavedCollaborationPage',props)
 for(const effect of app.effects)effect()
 await new Promise(resolve=>setImmediate(resolve))
 return app.render('SavedCollaborationPage',props)
}

test('群正文只有讨论，关联工作收进概览且资料并排查看保留原输入',async()=>{
 const {app,props}=page();let tree=await load(app,props)
 const tabs=nodes(tree).filter(node=>node.props.role==='tab'&&node.props['data-group-view'])
 assert.deepEqual(tabs,[],'正文不再重复显示右栏的关联工作页签')
 assert.equal(nodes(tree).filter(node=>node.props.role==='region'&&node.props['aria-label']==='collaboration.view.discussion').length,1)
 const composer=nodes(tree).find(node=>node.type?.name==='SavedComposer')!
 composer.props.setText('原讨论草稿')
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='overview.title')!.props.onClick();tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).find(node=>node.type?.name==='SavedComposer')!.props.text,'原讨论草稿')
 assert.equal(nodes(tree).find(node=>node.type?.name==='SavedGroupOverview')!.props.tab,'work','关联工作只在原概览中显示')
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.view.materials')!.props.onClick();tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).filter(node=>node.props.role==='region'&&node.props['aria-label']==='collaboration.view.discussion').length,1,'查看资料仍留在原讨论')
 assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.view.materials')!.props['aria-expanded'],true)
 assert.equal(nodes(tree).find(node=>node.type?.name==='SavedComposer')!.props.text,'原讨论草稿')
})

test('归档群设置可查阅但不能保存、修改成员或群规则',()=>{
 const {app}=page(true)
 const tree=app.render('SavedGroupForm',{form:{kind:'change',snapshot:{group:{...group,archived:true},members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save(){assert.fail('归档不能写入')},error:undefined})
 assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props.type==='submit')!.props.disabled,true)
 const input=nodes(tree).find(node=>node.type==='input'&&node.props.required)!
 assert.equal(input.props.readOnly,true)
})

test('非模态工作概览默认关联工作，授权信息留在群设置',async()=>{
 const {app,props}=page();let tree=await load(app,props)
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='overview.title')!.props.onClick()
 tree=app.render('SavedCollaborationPage',props)
 const overview=nodes(tree).find(node=>node.type?.name==='SavedGroupOverview')
 assert.ok(overview)
 assert.equal(overview.props.tab,'work')
 assert.equal(nodes(tree).some(node=>node.type==='aside'&&node.props.role==='dialog'),false)
})

test('群设置按需保留原授权面和渠道状态入口',()=>{
 const {app}=page()
 const props={form:{kind:'change',snapshot:{group,members:[{roleId:null},{roleId:'r1'}]}},roles,profileName:'Max',close(){},save(){},error:undefined,permissions:'原授权面',channels:'当前群渠道'}
 let tree=app.render('SavedGroupForm',props)
 const permission=nodes(tree).find(node=>node.props.role==='tab'&&content(node)==='collaboration.form.tab.permissions')
 assert.ok(permission)
 permission.props.onClick();tree=app.render('SavedGroupForm',props)
 assert.ok(nodes(tree).some(node=>node.props.role==='tabpanel'&&!node.props.hidden&&content(node)==='原授权面'))
 assert.ok(nodes(tree).some(node=>node.props.role==='tab'&&content(node)==='collaboration.form.tab.channels'))
})
test('群名与群图标直接打开同一原群设置，不改变原群身份或默认提交',async()=>{
 for(const via of ['name','avatar'] as const){
  const {app,props}=page();let tree=await load(app,props)
  const button=nodes(tree).find(node=>node.type==='button'&&(via==='name'?node.props.className==='groupTitle':node.props['aria-label']==='collaboration.settings.aria'&&node.props.role!=='menuitem'))!
  assert.ok(button);button.props.onClick();tree=app.render('SavedCollaborationPage',props)
  const form=nodes(tree).find(node=>node.type?.name==='SavedGroupForm')!
  assert.ok(form);assert.equal(form.props.form.kind,'change');assert.equal(form.props.form.snapshot.group.id,'g1');assert.equal(form.props.form.snapshot.group.version,1)
 }
})

test('关联工作名称、负责员工和加号各进入原对象，归档只阻止添加',()=>{
 const {app}=page();const opened:string[]=[]
 const props={group,tasks:[{id:'task1',title:'核对告警',assigneeId:'r1',state:'ready'}],roles,profileName:'Max',blocked:false,work:{openTask:(id:string)=>opened.push('task:'+id),openRole:(id:string)=>opened.push('role:'+id),createTask:(id:string)=>opened.push('new:'+id)}}
 let tree=app.render('SavedGroupWork',props)
 nodes(tree).find(node=>node.type==='button'&&content(node)==='核对告警')!.props.onClick()
 nodes(tree).find(node=>node.type==='button'&&content(node)==='林析')!.props.onClick()
 const add=nodes(tree).find(node=>node.props['aria-label']==='collaboration.task.create')!
 assert.equal(add.props.title,'collaboration.task.create');add.props.onClick()
 assert.deepEqual(opened,['task:task1','role:r1','new:g1'])
 tree=app.render('SavedGroupWork',{...props,blocked:true})
 assert.equal(nodes(tree).find(node=>node.props['aria-label']==='collaboration.task.create')!.props.disabled,true)
 assert.equal(nodes(tree).find(node=>content(node)==='核对告警')!.props.disabled,false)
})

test('工作概览页签方向键和 Home/End 切换，员工空态和只读添加明确',()=>{
 const {app}=page();let selected='work',prevented=0
 const props={group,tasks:[],roles,profileName:'Max',blocked:true,work:undefined,tab:'work',members:[],addMembers(){},changeTab:(tab:string)=>{selected=tab}}
 let tree=app.render('SavedGroupOverview',props)
 const tabs=nodes(tree).filter(node=>node.props.role==='tab')
 tabs[0]!.props.onKeyDown({key:'End',preventDefault(){prevented++}})
 assert.equal(selected,'members')
 tree=app.render('SavedGroupOverview',{...props,tab:selected})
 assert.equal(nodes(tree).filter(node=>node.type?.name==='GroupMembersPanel').length,0,'概览参与员工页签不重复渲染成员管理')
 assert.ok(content(tree).includes('collaboration.view.employeesEmpty'))
 tree=app.render('SavedGroupOverview',{...props,tab:selected,membersOnly:true})
 const memberPanel=nodes(tree).find(node=>node.type?.name==='GroupMembersPanel')!
 const memberTree=mount('GroupMembersPanel.tsx').render('GroupMembersPanel',memberPanel.props)
 assert.ok(content(memberTree).includes('collaboration.view.employeesEmpty'))
 assert.equal(nodes(memberTree).find(node=>node.props['aria-label']==='collaboration.form.addMembers')!.props.disabled,true,'成员管理只在头部成员面板')
 tree=app.render('SavedGroupOverview',{...props,tab:selected})
 nodes(tree).find(node=>node.props.role==='tab'&&node.props['aria-selected'])!.props.onKeyDown({key:'Home',preventDefault(){prevented++}})
 assert.equal(selected,'work');assert.equal(prevented,2)
})

test('概览页签显示真实数量：关联读取完成前不显示 0，参与员工只列负责事项，不带对话或授权',()=>{
 const {app}=page(),opened:string[]=[]
 const roleB={id:'r2',name:'周核',kind:'employee',scopes:['general'],state:'active',duty:'复核'}
 const tasks=[{id:'t1',title:'核对告警',assigneeId:'r1',state:'ready'},{id:'t2',title:'补充证据',assigneeId:'r1',state:'ready'},{id:'t3',title:'外部任务',assigneeId:'r2',state:'ready'}]
 const props={group,tasks:[],roles:[...roles,roleB],profileName:'Max',blocked:false,tab:'members',members:['self','r1','r2'],addMembers(){},changeTab(){},work:{tasks,links:{},openLink(){},openTask(){},openRole:(id:string)=>opened.push(id)}}
 let tree=app.render('SavedGroupOverview',props)
 const text=(node:any):string=>typeof node==='string'||typeof node==='number'?String(node):node?.children?.map(text).join('')??''
 const tabText=()=>nodes(tree).filter(node=>node.props.role==='tab').map(text)
 assert.deepEqual(tabText(),['collaboration.context.work','collaboration.view.participants 2'],'关联读取完成前不显示数量，参与员工不含本人')
 assert.ok(!content(tree).includes('collaboration.view.employeeWork'),'负责事项未知时不显示 0')
 const work=nodes(tree).find(node=>node.type?.name==='SavedGroupWork')!
 work.props.summarize({count:3,taskIds:['t1','t2']})
 tree=app.render('SavedGroupOverview',props)
 assert.deepEqual(tabText(),['collaboration.context.work 3','collaboration.view.participants 2'])
 assert.ok(content(tree).includes('collaboration.view.employeeWork'),'林析负责两项已关联任务')
 assert.ok(content(tree).includes('collaboration.view.employeeNoWork'),'周核的任务未关联本群，不计入')
 assert.equal(nodes(tree).filter(node=>node.type==='button'&&/对话|授权|grant|chat/i.test(String(node.props['aria-label']??''))).length,0)
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='林析')!.props.onClick()
 assert.deepEqual(opened,['r1'],'员工名进入原身份')
 tree=app.render('SavedGroupOverview',{...props,group:{...group,id:'g2'}})
 assert.deepEqual(tabText(),['collaboration.context.work','collaboration.view.participants 2'],'切群后不沿用旧群计数')
})

test('已贴回的纯回复不占概览及员工负责事项，已有消息状态沿原props传给关联工作',()=>{
 const {app}=page(),task={id:'reply-task',title:'群回复',contentVersion:1,assigneeId:'r1',assigneeRoleVersion:1,state:'waiting',source:{groupId:group.id,messageId:'m',rootId:'m',text:'只回复收到',trigger:'routed',executionMode:'reply',createdAssignee:{roleId:'r1',roleVersion:1}}},status={messageId:'m',attemptVersion:1,phase:'completed',recipients:[{roleId:'r1',name:'林析',taskId:task.id,runId:'run',phase:'completed',resultMessageId:'formal-reply',executionMode:'reply'}],hintCode:null,canRetry:false}
 const props={group,tasks:[task],messageStatuses:[status],roles,profileName:'Max',blocked:false,tab:'members',members:['self','r1'],addMembers(){},changeTab(){},work:{tasks:[task],openTask(){},openRole(){}}}
 let tree=app.render('SavedGroupOverview',props)
 const text=(node:any):string=>typeof node==='string'||typeof node==='number'?String(node):node?.children?.map(text).join('')??''
 assert.ok(nodes(tree).some(node=>node.props.role==='tab'&&text(node)==='collaboration.context.work 0'))
 assert.ok(content(tree).includes('collaboration.view.employeeNoWork'))
 tree=app.render('SavedGroupWork',props)
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,0,'未接关联端口的兼容视图同样不显示已回复内部工作')
 tree=app.render('SavedGroupWork',{...props,work:{...props.work,links:{},openLink(){}}})
 assert.equal(nodes(tree).find(node=>node.type?.name==='GroupLinkedWork')!.props.messageStatuses,props.messageStatuses)
 const failed={...props,messageStatuses:[{...status,recipients:[{...status.recipients[0],phase:'blocked'}]}]}
 tree=app.render('SavedGroupWork',failed)
 assert.equal(nodes(tree).filter(node=>node.type==='article').length,1,'失败状态保留原工作')
})

test('概览与资料关闭后保留讨论草稿，目录过滤与返回入口持续可用',async()=>{
 const {app,props}=page();let tree=await load(app,props)
 nodes(tree).find(node=>node.type?.name==='SavedComposer')!.props.setText('未发送草稿')
 const search=nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.search.aria')!
 search.props.onChange({target:{value:'核对'}})
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='overview.title')!.props.onClick()
 tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).find(node=>node.type?.name==='SavedGroupOverview')!.props.tab,'work')
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.panel.close')!.props.onClick()
 tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).find(node=>node.type?.name==='SavedComposer')!.props.text,'未发送草稿')
 assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.search.aria')!.props.value,'核对')
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='collaboration.action.back')!.props.onClick()
 tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='collaboration.search.aria')!.props.value,'核对')
})

test('归档资料仍使用原版本内容抽屉查阅，保存不能写入',()=>{
 const {app}=page();let saved=0
 const tree=app.render('SavedResourceForm',{form:{groupId:'g1',resource:{id:'res',title:'SOP',version:3},markdown:'原版本资料'},open:true,readOnly:true,close(){},discard(){},save(){saved++},error:undefined})
 assert.equal(nodes(tree).find(node=>node.type==='textarea')!.props.readOnly,true)
 assert.equal(nodes(tree).find(node=>node.type==='textarea')!.props.value,'原版本资料')
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 assert.equal(saved,0)
})

test('群成果归入非模态概况并保持同一消息版本，资料页不重复汇总成果',async()=>{
 const {app,props}=page(),reads:string[]=[]
 const message={id:'message1',groupId:'g1',rootId:null,authorId:'self',text:'合成成果',createdAt:'2026-10-12T01:00:00Z',mentions:[],references:[{kind:'artifact',id:'artifact1',version:2}]}
 props.api.messages=async(_id?:string,rootId?:string)=>{if(rootId)reads.push(rootId);return {items:[message] as any}}
 let tree=await load(app,props)
 nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='overview.title')!.props.onClick()
 tree=app.render('SavedCollaborationPage',props)
 const overview=nodes(tree).find(node=>node.type?.name==='SavedGroupOverview')!
 assert.ok(overview.props.results,'右栏必须包含真实成果投影')
 assert.equal(overview.props.results.props.groupId,'g1')
 assert.deepEqual(overview.props.results.props.rows.map((row:any)=>[row.reference.id,row.reference.version,row.message.id]),[['artifact1',2,'message1']])
 overview.props.results.props.openMessage(message)
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(reads,['message1'],'来源打开原群消息话题，不创建独立成果会话')
 tree=app.render('SavedCollaborationPage',props)
 assert.equal(nodes(tree).filter(node=>node.type==='h4'&&content(node)==='collaboration.view.results').length,0,'输入资料页不保留第二套成果汇总')
})

test('员工消息的头像与姓名用键盘按钮打开同一原身份，本人消息保留原样',()=>{
 const {app}=page(),opened:string[]=[]
 const props={message:{id:'m1',authorId:'r1',runId:'run1',text:'核对完成',createdAt:'2026-10-11T00:00:00Z',references:[]},roleNames:{r1:'林析'},roleAvatars:{r1:roles[0]},opened:{},artifactSummaries:{},artifactFiles:{},openArtifactFile(){},attachmentBytes(){},openImage(){},openRole:(id:string)=>opened.push(id)}
 const tree=app.render('SavedMessage',props)
 const identity=nodes(tree).filter(node=>node.type==='button'&&node.props['aria-label']==='林析')
 assert.equal(identity.length,2)
 for(const button of identity){assert.equal(button.props.type,'button');button.props.onClick()}
 assert.deepEqual(opened,['r1','r1'])
 const {runId,...selfMessage}=props.message
 const self=app.render('SavedMessage',{...props,message:{...selfMessage,authorId:'self'}})
 assert.equal(nodes(self).some(node=>node.type==='button'&&node.props['aria-label']==='collaboration.message.self'),false)
})
