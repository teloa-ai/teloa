import {groupResultFixtureModule} from './group-result-fixture.ts'
import {applicationCapabilityModule} from './application-capability-fixture.ts'
import * as knowledgeMarkdown from '../src/client/knowledge-markdown-core.ts'
import * as industryTeamMaterials from '../src/client/industry-team-materials.ts'
import * as groupWorkResources from '../src/client/group-work-resources.ts'
import {staffAvatarComponent,personalProfileForGroup} from './staff-avatar-component.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {contentOf,markdownPrimitivesStub,testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {Group,GroupAgentGrant,GroupMember,GroupMention,GroupMessage,MessageReference} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {groupMentionCandidates,groupMentionLabel,groupMentionQuery} from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {SavedConversationDirectory} from '../src/client/SavedCollaborationPage.js'

/**
 * 群内提及（2026-09-21 AutoDream 一期与群提及）：正文敲「@」就地弹候选、选中插入 @名字 标记并入提及列表、
 * 删标记自动摘除提及、@全员、发送后弹既有建任务表单并预填负责人。
 * 真实运行 SavedCollaborationPage.tsx 的组件函数与 useEffect（手法与 saved-collaboration-topic-draft.test.ts 一致），不经过 jsdom。
 */

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

const stamp='2026-09-21T01:00:00.000Z'
const groupId='11111111-1111-4111-8111-111111111111'
const employeeAId='22222222-2222-4222-8222-222222222222'
const employeeDId='33333333-3333-4333-8333-333333333333'
const employeeBId='44444444-4444-4444-8444-444444444444'
const twinCId='55555555-5555-4555-8555-555555555555'
const rootMessageId='66666666-6666-4666-8666-666666666666'

function role(id:string,name:string,kind:'employee'|'twin',state:'active'|'paused'):PreviewRole{
 return {id,name,kind,scopes:['general'],state,version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
}
const employeeA=role(employeeAId,'员工甲','employee','active')
const employeeD=role(employeeDId,'员工丁','employee','active')
const employeeB=role(employeeBId,'员工乙（暂停）','employee','paused')
const twinC=role(twinCId,'我的分身','twin','active')
const roles:PreviewRole[]=[employeeA,employeeD,employeeB,twinC]

function baseGroup(mentionAllAllowed:boolean,scope='general'):Group{
 return {id:groupId,ownerId:'self',version:1,name:'资料核对群',scope,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed},pinned:false,archived:false,createdAt:stamp,updatedAt:stamp}
}
function baseMembers():GroupMember[]{
 return [
  {groupId,roleId:null,createdAt:stamp},
  {groupId,roleId:employeeAId,createdAt:stamp},
  {groupId,roleId:employeeDId,createdAt:stamp},
  {groupId,roleId:employeeBId,createdAt:stamp},
  {groupId,roleId:twinCId,createdAt:stamp},
 ]
}

type ResourceRow={id:string;groupId:string;ownerId:string;version:number;title:string;withdrawnAt:string|null;createdAt:string;updatedAt:string}
type ApiSetup={mentionAllAllowed?:boolean;members?:GroupMember[];existingMessages?:GroupMessage[];scope?:string;resources?:ResourceRow[]}
function makeApi(setup:ApiSetup={}){
 const calls:{endpoint:string;payload:unknown}[]=[]
 const group=baseGroup(!!setup.mentionAllAllowed,setup.scope)
 const members=setup.members??baseMembers()
 const snapshot:GroupSnapshot={group,members}
 let counter=0
 const api={
  get:async(id:string)=>{assert.equal(id,groupId);return snapshot},
  messages:async(id:string,forRoot?:string)=>{assert.equal(id,groupId);if(forRoot!==undefined)throw Error('未预期读话题：'+forRoot);return {items:setup.existingMessages??[]}},
  resources:async()=>({items:setup.resources??[]}),
  agentGrant:async(_groupId:string,roleId:string)=>({groupVersion:1,roleVersion:1,grant:{groupId,roleId,groupVersion:1,roleVersion:1,grantVersion:1,state:'active' as const,resources:[],canPost:true,canAutoRun:false,createdAt:stamp} satisfies GroupAgentGrant,status:'active' as const}),
  list:async()=>({items:[group]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
  send:async(sendGroupId:string,expectedVersion:number,text:string,rootId?:string,references?:MessageReference[],mentions?:GroupMention[])=>{
   calls.push({endpoint:'groups/messages/send',payload:{groupId:sendGroupId,expectedVersion,text,rootId,references,mentions}})
   counter+=1
   const id='msg-'+counter
   const base={id,groupId:sendGroupId,rootId:rootId??null,authorId:'self' as const,text,references:references??[],createdAt:stamp}
   return mentions&&mentions.length>0?{...base,mentions}:{...base,mentions:[]}
  },
  createTask:async(taskGroupId:string,messageId:string,expectedGroupVersion:number,goal:string,assignee?:{roleId:string;expectedVersion:number},trigger?:'manual'|'mention')=>{
   calls.push({endpoint:'groups/tasks/create',payload:{groupId:taskGroupId,messageId,expectedGroupVersion,goal,assignee,trigger}})
   return {
    task:{id:'task-1',ownerId:'self',title:'群任务',goal,scope:'general',version:1,state:'ready' as const,assigneeRoleId:assignee?.roleId??null,assigneeRoleVersion:assignee?.expectedVersion??null,createdAt:stamp,updatedAt:stamp},
    source:{schema:'teloa.group-task-source/v1' as const,taskId:'task-1',ownerId:'self',groupId:taskGroupId,groupVersion:expectedGroupVersion,messageId,rootId:messageId,messageCreatedAt:stamp,messageText:'',references:[],createdAssignee:assignee?{roleId:assignee.roleId,roleVersion:assignee.expectedVersion}:null,trigger:trigger??'manual',createdAt:stamp},
   }
  },
  changeAgentGrant:async(grantGroupId:string,roleId:string,expectedGroupVersion:number,expectedRoleVersion:number,action:'save'|'revoke',resources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>{
   calls.push({endpoint:'groups/agent-grants/change',payload:{groupId:grantGroupId,roleId,expectedGroupVersion,expectedRoleVersion,action,resources,canPost,canAutoRun}})
   return {groupId:grantGroupId,roleId,groupVersion:expectedGroupVersion,roleVersion:expectedRoleVersion,grantVersion:1,state:action==='save'?'active' as const:'revoked' as const,resources,canPost,canAutoRun,createdAt:stamp}
  },
 } as unknown as GroupApi
 return {api,calls}
}

type Props={visible:boolean;api:GroupApi;routing?:{list:()=>Promise<unknown[]>};directory?:SavedConversationDirectory;target:{groupId:string;rootId:string}|null;roles:PreviewRole[];profileName:string}

/** 执行真实组件函数与真实 effect 调度；只有顶层组件手动调用，嵌套子组件在展开时按普通函数调用。 */
function mount(initial:Props){
 let props=initial
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks={...React,
  useId:()=> 'group-form-test',
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initialValue:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initialValue})},
  useMemo:testUseMemo(slots,()=>cursor++),
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{
   const index=cursor++,previous=effects.get(index)
   if(previous&&deps.every((value,depIndex)=>Object.is(value,previous.deps[depIndex])))return
   pending.push(()=>{previous?.cleanup?.();effects.set(index,{deps,cleanup:run()??undefined})})
  },
 }
 const t=(key:string,params?:Record<string,string|number>)=>params?key+':'+JSON.stringify(params):key
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string):unknown=>{
  const groupResult=groupResultFixtureModule(id);if(groupResult!==undefined)return groupResult
  if(id==='./GroupChannelBindings.js')return {GroupChannelBindings:()=>null}
  const capability=applicationCapabilityModule(id);if(capability!==undefined)return capability
  if(id==='react')return hooks
  if(id==='./ContextDrawer.js')return {ContextDrawer:({open=true,children,title}:any)=>open?React.createElement('dialog',{'aria-label':title},children):null}
  if(id==='./task-preview.js')return {taskStates:{ready:'status.ready',running:'status.running',paused:'status.paused',waiting:'status.waiting',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'}}
  if(id==='./StaffAvatar.js'||id==='./EmployeeAvatar.js'||id==='./TwinAvatar.js')return staffAvatarComponent
  if(id==='./personal-profile.js')return personalProfileForGroup
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  // SavedCollaborationPage 现在直接读契约里的群附件字面量（类型与上限），夹具按真模块喂。
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('knowledge-markdown-core.js'))return knowledgeMarkdown
  if(id.endsWith('ComposerPopover.js'))return {ComposerPopover:({children,label}:{children:React.ReactNode;label:string})=>React.createElement('div',{role:'dialog','aria-label':label},children)}
  if(id.endsWith('dialog-focus.js'))return {openDialog:()=>{}}
  if(id.endsWith('directory-focus.js'))return {closeDirectoryDetailOnEscape:()=>{}}
  if(id.endsWith('panel-focus.js'))return {returnPanelFocus:()=>{}}
  if(id.endsWith('business-scope-context.js'))return {useBusinessScopes:()=>({general:'通用'})}
  if(id.endsWith('saved-collaboration-state.js'))return savedCollaborationState
  if(id.endsWith('saved-collaboration-drafts.js'))return {savedCollaborationDrafts:createSavedCollaborationDraftStore()}
  if(id.endsWith('team-presentation.js'))return {twinDisplayName:(name:string)=>name}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t,time:(value:string)=>value,date:(value:string)=>value.slice(0,10),dateTime:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:()=>()=>{}}
  // 群内直接回应一期 T14 接线后 SavedCollaborationPage 多了这两处依赖；本文件不测表情与折叠行，一律给空实现。
  if(id.endsWith('GroupReactionBar.js'))return {GroupReactionBar:()=>null,GroupEmojiPicker:()=>null}
  if(id.endsWith('group-routing-view.js'))return {groupRoutingPending:()=>[]}
  // DSH 平台模块，Node 下装不起来，给透传桩（见 saved-message-markdown-stubs.ts）。
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return markdownPrimitivesStub
  // 本夹具未接工作关联端口；新组件边界另有源渲染与浏览器用例，不应进入此旧消息测试。
  if(id==='./GroupLinkedWork.js')return {GroupLinkedWork:()=>{throw Error('未接工作关联端口的消息夹具不应渲染关联组件')}}
  // 此夹具没有模板资料端口；保留真实引用合并，意外渲染资料组件时直接失败。
  if(id==='./industry-team-materials.js')return industryTeamMaterials
  if(id==='./group-work-resources.js')return groupWorkResources
  if(id==='./IndustryTeamMaterials.js')return {IndustryTeamMaterials:()=>{throw Error('未接模板资料端口的消息夹具不应渲染模板资料组件')}}
  throw Error('未声明的组件依赖：'+id)
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/SavedCollaborationPage.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,hooks)
 const Component=exported.SavedCollaborationPage as (props:Props)=>React.ReactNode
 const render=():React.ReactNode=>{
  let guard=0
  do{
   assert.ok(guard++<20,'组件不应无限重渲染')
   dirty=false;cursor=0;pending=[]
   tree=Component(props)
   for(const run of pending)run()
  }while(dirty)
  return tree
 }
 // 一次事件循环排空真实异步刷新链；不能用固定8个微任务假定目录与覆盖层已返回。
 const flush=async()=>{for(let round=0;round<8;round++){await new Promise<void>(resolve=>setImmediate(resolve));render()}return tree}
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 return {
  render,flush,
  setProps:(patch:Partial<Props>)=>{props={...props,...patch};render()},
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  contentOf,
 }
}

const directory=():SavedConversationDirectory=>({refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}})
const byContent=(app:ReturnType<typeof mount>,text:string)=>(el:React.ReactElement<Record<string,any>>)=>app.contentOf(el)===text
const composerForm=(app:ReturnType<typeof mount>)=>app.find(el=>el.type==='form'&&el.props.className==='composer')

const textareaOf=(app:ReturnType<typeof mount>)=>app.find(el=>el.type==='textarea'&&el.props['aria-label']==='collaboration.composer.aria')
const draftText=(app:ReturnType<typeof mount>)=>String(textareaOf(app).props.value)
const typeText=(app:ReturnType<typeof mount>,value:string)=>{textareaOf(app).props.onChange({target:{value}});app.render()}
const optionLabels=(app:ReturnType<typeof mount>)=>app.findAll(el=>el.type==='li'&&el.props.role==='option').map(el=>app.contentOf(el))
const optionOf=(app:ReturnType<typeof mount>,label:string)=>app.find(el=>el.type==='li'&&el.props.role==='option'&&app.contentOf(el)===label)
const pressKey=(app:ReturnType<typeof mount>,key:string)=>{textareaOf(app).props.onKeyDown({key,preventDefault:()=>{},stopPropagation:()=>{}});app.render()}
const chooseOption=(app:ReturnType<typeof mount>,label:string)=>{optionOf(app,label).props.onMouseDown({preventDefault:()=>{}});app.render()}
/** 照真人手法提及一位：在正文尾部敲 @名字，再从候选里选中。 */
const mentionByTyping=(app:ReturnType<typeof mount>,name:string)=>{const before=draftText(app);typeText(app,(before&&!/\s$/.test(before)?before+' ':before)+'@'+name);chooseOption(app,name)}
const chipLabels=(app:ReturnType<typeof mount>)=>app.findAll(el=>el.type==='span'&&el.props.className==='mentionChip').map(el=>app.contentOf(el))

test('光标前的 @前缀只在行首或空白后成立，且遇到空白或第二个 @ 就失效',()=>{
 assert.deepEqual(groupMentionQuery('@员','@员'.length),{start:0,query:'员'})
 assert.deepEqual(groupMentionQuery('你好 @员工',6),{start:3,query:'员工'})
 assert.equal(groupMentionQuery('邮箱a@b',5),undefined)
 assert.equal(groupMentionQuery('@员工 甲',4),undefined)
 assert.equal(groupMentionQuery('没有触发词',5),undefined)
})

test('同名同事的候选项与正文标记都带岗位后缀区分',()=>{
 const 甲一={...employeeA,duty:'资料核对'},甲二={...employeeD,name:employeeA.name,duty:'外勤跟进'}
 const both=[甲一,甲二]
 assert.equal(groupMentionLabel(甲一,both),employeeA.name+'·资料核对')
 assert.equal(groupMentionLabel(甲二,both),employeeA.name+'·外勤跟进')
 assert.equal(groupMentionLabel(甲一,[甲一]),employeeA.name)
})

test('@ 候选只列本群在岗 employee，分身与暂停成员不列入，且不按业务范围过滤',()=>{
 const candidates=groupMentionCandidates(baseMembers(),roles)
 assert.deepEqual(candidates.map(item=>item.id),[employeeAId,employeeDId])
})

test('建群成员候选不再按业务范围过滤：跨范围与暂停同事都可选，成员关系不激活员工',async()=>{
 const socId='99999999-9999-4999-9999-999999999999'
 const socEmployee:PreviewRole={...role(socId,'员工SOC','employee','active'),scopes:['SOC'],duty:'安全复核'}
 const extendedRoles=[...roles,socEmployee]
 const {api}=makeApi({})
 const createDirectory:SavedConversationDirectory={refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}
 const app=mount({visible:true,api,directory:createDirectory,target:null,roles:extendedRoles,profileName:'测试者'})
 await app.flush()
 app.setProps({directory:{...createDirectory,createRequest:1}})
 await app.flush()
 assert.ok(app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.action.new'),'创建群弹层必须打开')
 const name=app.find(el=>el.type==='input'&&el.props.maxLength===80)
 name.props.onChange({target:{value:'跨业务协作群'}})
 app.render()
 const next=app.find(el=>el.type==='button'&&el.props.type==='submit'&&app.contentOf(el)==='collaboration.form.next')
 assert.equal(next.props.disabled,false,'填写群名后可以进入成员选择')
 app.find(el=>el.type==='form'&&typeof el.props.onKeyDown==='function').props.onSubmit({preventDefault(){}})
 await app.flush()
 const socRow=app.find(el=>el.props.className==='groupMemberChoice'&&app.contentOf(el).includes('员工SOC'))
 assert.ok(app.contentOf(socRow).includes('SOC'),'候选行必须标注这位员工的业务范围，即便群当前选的是另一个范围')
 const choice=React.Children.toArray(socRow.props.children).find(el=>React.isValidElement<Record<string,any>>(el)&&el.type==='input'&&el.props.type==='checkbox') as React.ReactElement<Record<string,any>>
 assert.ok(choice,'候选行提供真实成员选择控件')
 assert.equal(choice.props.disabled,false,'跨业务在岗员工候选必须可选')
 choice.props.onChange({target:{checked:true}})
 await app.flush()
 assert.ok(app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.form.removeMember:{"name":"员工SOC"}'),'选中员工后加入待创建群的成员列表')
 const pausedRow=app.find(el=>el.props.className==='groupMemberChoice'&&app.contentOf(el).includes('员工乙'))
 assert.ok(app.contentOf(pausedRow).includes('role.state.paused'),'暂停状态仍明确显示')
 const pausedChoice=React.Children.toArray(pausedRow.props.children).find(el=>React.isValidElement<Record<string,any>>(el)&&el.type==='input'&&el.props.type==='checkbox') as React.ReactElement<Record<string,any>>
 assert.equal(pausedChoice.props.disabled,false,'暂停同事可显式加入成员，执行资格仍由原提及和服务端闸门限制')
 assert.equal(employeeB.state,'paused','成员选择不激活员工')
})

test('正文敲 @ 弹出候选浮层，继续输入按名字前缀过滤，Esc 关闭',async()=>{
 const {api}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 assert.equal(optionLabels(app).length,0,'没敲 @ 时不该有候选浮层')
 typeText(app,'@')
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(listbox.props['aria-label'],'group.mention.pick')
 assert.deepEqual(optionLabels(app),['员工甲','员工丁'],'候选只列本群在岗员工')
 typeText(app,'@员工丁')
 assert.deepEqual(optionLabels(app),['员工丁'],'继续输入按名字前缀过滤')
 pressKey(app,'Escape')
 assert.equal(optionLabels(app).length,0,'Esc 必须关闭候选浮层')
})

test('中文输入法组合中的方向键、Esc、Tab、Enter 全部交还输入法，不改候选、不提及、不发送',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush();typeText(app,'@员工')
 const current=textareaOf(app).props['aria-activedescendant']
 for(const key of ['ArrowDown','ArrowUp','Escape','Tab','Enter']){
  let prevented=false,stopped=false
  textareaOf(app).props.onKeyDown({key,nativeEvent:{isComposing:true},preventDefault(){prevented=true},stopPropagation(){stopped=true}})
  app.render()
  assert.equal(prevented,false,key+' 不拦截输入法操作')
  assert.equal(stopped,false,key+' 不阻断输入法事件')
  assert.equal(textareaOf(app).props['aria-activedescendant'],current,key+' 不改变群候选活动项')
  assert.equal(draftText(app),'@员工')
  assert.deepEqual(chipLabels(app),[])
 }
 assert.equal(calls.filter(call=>call.endpoint==='groups/messages/send').length,0)
})

test('↑↓ 移动候选、Enter 选中：正文插入 @名字 标记并把这位加进提及列表',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'请 @员工')
 const first=optionOf(app,'员工甲')
 assert.equal(first.props['aria-selected'],true,'默认活动项是第一条')
 assert.equal(textareaOf(app).props['aria-activedescendant'],first.props.id)
 pressKey(app,'ArrowDown')
 assert.equal(optionOf(app,'员工丁').props['aria-selected'],true)
 pressKey(app,'ArrowUp')
 assert.equal(optionOf(app,'员工甲').props['aria-selected'],true)
 pressKey(app,'ArrowDown')
 pressKey(app,'Enter')
 assert.equal(draftText(app),'请 @员工丁 ','选中后把 @过滤词 替换为 @名字 并留一个尾空格')
 assert.deepEqual(chipLabels(app),['员工丁'])
 assert.equal(optionLabels(app).length,0,'选中后候选浮层必须收起')
 typeText(app,draftText(app)+'核对一下。')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.equal(sent.length,1)
 assert.deepEqual((sent[0]!.payload as {mentions?:unknown}).mentions,[{roleId:employeeDId,expectedVersion:1}],'提交的提及只带 roleId 与 expectedVersion')
})

test('正文里的 @名字 标记被删掉时，对应提及自动从列表移除',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 mentionByTyping(app,'员工丁')
 assert.deepEqual(chipLabels(app),['员工甲','员工丁'])
 typeText(app,'@员工丁 只留这一位。')
 assert.deepEqual(chipLabels(app),['员工丁'],'正文里不再出现的标记必须连带摘除提及')
 typeText(app,'两位都不提了。')
 assert.deepEqual(chipLabels(app),[])
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.equal(sent.length,1)
 assert.equal((sent[0]!.payload as {mentions?:unknown}).mentions,undefined,'没有提及时不写 mentions 键')
})

test('点 chip 上的 × 同时删正文标记与提及',async()=>{
 const {api}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 typeText(app,draftText(app)+'请核对。')
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.form.close').props.onClick();app.render()
 assert.deepEqual(chipLabels(app),[])
 assert.equal(draftText(app),'请核对。')
})

test('客户端不解析正文 @ 文本：只敲不选不会产生任何提及',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@员工甲')
 typeText(app,'@员工甲 麻烦看一下。')
 assert.deepEqual(chipLabels(app),[],'正文里手打的 @名字 不得被推断成提及')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.equal((sent[0]!.payload as {mentions?:unknown}).mentions,undefined)
})

test('提及选满 8 位后第 9 位候选 aria-disabled 并显示上限提示',async()=>{
 const many=Array.from({length:9},(_,index)=>role('role-'+index,'员工'+index,'employee','active'))
 const manyMembers:GroupMember[]=[{groupId,roleId:null,createdAt:stamp},...many.map(item=>({groupId,roleId:item.id,createdAt:stamp}))]
 const {api}=makeApi({members:manyMembers})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles:many,profileName:'测试者'})
 await app.flush()
 for(let index=0;index<8;index++)mentionByTyping(app,'员工'+index)
 assert.equal(chipLabels(app).length,8)
 assert.ok(app.find(el=>el.props.role==='status'&&app.contentOf(el)==='group.mention.limit'))
 typeText(app,draftText(app)+'@员工8')
 const ninth=optionOf(app,'员工8')
 assert.equal(ninth.props['aria-disabled'],true)
 ninth.props.onMouseDown({preventDefault:()=>{}});app.render()
 assert.equal(chipLabels(app).length,8,'第 9 位不得被选中')
})

test('mentionAllAllowed 为假时候选里没有「全员」',async()=>{
 const {api}=makeApi({mentionAllAllowed:false})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 assert.deepEqual(optionLabels(app),['员工甲','员工丁'])
})

test('mentionAllAllowed 为真时「全员」排第一；选中后发送不带 mentions、不新建任务',async()=>{
 const {api,calls}=makeApi({mentionAllAllowed:true})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 assert.deepEqual(optionLabels(app),['group.mention.all','员工甲','员工丁'],'「全员」必须排第一')
 chooseOption(app,'group.mention.all')
 assert.equal(draftText(app),'@group.mention.allName ','选中全员后正文插入全员标记')
 typeText(app,draftText(app)+'周知一下。')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 // 脚注去掉后 <form> 里唯一的文字就是这句提示，contentOf 会连表单一起命中；只认 <p> 这一层。
 assert.ok(app.find(el=>el.type==='p'&&byContent(app,'group.mention.allNotice')(el)))
 assert.equal(calls.filter(call=>call.endpoint==='groups/tasks/create').length,0,'提及全员不得新建任务')
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.equal(sent.length,1)
 assert.equal((sent[0]!.payload as {mentions?:unknown}).mentions,undefined)
})

test('删掉正文里的全员标记后恢复普通发送，不再走全员通知',async()=>{
 const {api,calls}=makeApi({mentionAllAllowed:true})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 chooseOption(app,'group.mention.all')
 typeText(app,'改成只跟一位说。')
 mentionByTyping(app,'员工甲')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.deepEqual((sent[0]!.payload as {mentions?:unknown}).mentions,[{roleId:employeeAId,expectedVersion:1}])
 assert.ok(!app.findAll(byContent(app,'group.mention.allNotice')).length)
})

test('已选中同事时「全员」候选禁用，已选全员时同事候选禁用，避免静默丢弃',async()=>{
 const {api}=makeApi({mentionAllAllowed:true})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 typeText(app,draftText(app)+'@')
 assert.equal(optionOf(app,'group.mention.all').props['aria-disabled'],true)
 typeText(app,'@')
 chooseOption(app,'group.mention.all')
 typeText(app,draftText(app)+'@员工')
 assert.equal(optionOf(app,'员工甲').props['aria-disabled'],true)
})

test('输入框下面不再有「提及同事」「提及全员」两个按钮与旧候选列表',async()=>{
 const {api}=makeApi({mentionAllAllowed:true})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el)==='group.mention.pick').length,0)
 assert.equal(app.findAll(el=>el.type==='button'&&app.contentOf(el)==='group.mention.all').length,0)
 assert.equal(app.findAll(el=>el.props.className==='mentionList').length,0)
 assert.equal(app.findAll(el=>el.props.className==='mentionBar').length,0)
})

test('已启用群内回应时，提及只发送一次消息，不再弹出会创建重复任务的旧表单',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,routing:{list:async()=>[]},directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 assert.equal(calls.filter(call=>call.endpoint==='groups/messages/send').length,1)
 assert.equal(app.findAll(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create').length,0)
 assert.equal(calls.filter(call=>call.endpoint==='groups/tasks/create').length,0)
})

test('未接入群内回应时，发送带两个提及后打开建任务表单，负责人预填第一位',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 mentionByTyping(app,'员工丁')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()

 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create')
 assert.ok(dialog,'必须自动打开建任务表单')
 assert.ok(app.find(byContent(app,'collaboration.task.boundary')),'沿用一份仅创建不执行说明')
 assert.equal(app.findAll(byContent(app,'group.mention.formOpened')).length,0,'不再堆叠兼容入口教学')
 assert.equal(app.findAll(byContent(app,'group.mention.readyOnly')).length,0)
 const select=app.find(el=>el.type==='select'&&el.props.value!==undefined&&(el.props.value===employeeAId||el.props.value===''))
 assert.equal(select.props.value,employeeAId,'负责人必须预填第一位被提及的员工')
 const goalField=app.find(el=>el.type==='textarea'&&el.props.required===true)
 assert.equal(goalField.props.value,'','建任务表单其余字段（目标）必须为空')

 const callsBeforeCancel=calls.length
 const cancelButton=app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.form.cancel')
 cancelButton.props.onClick();app.render()
 assert.equal(calls.length,callsBeforeCancel,'取消表单不得发出任何新请求')
 assert.ok(!app.findAll(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create').length,'取消后表单必须关闭')
})

test('提及触发的建任务表单提交时 trigger 为 mention；手工建任务不带 trigger',async()=>{
 const {api,calls}=makeApi({})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create')
 const form=expandForm(app,dialog)
 await form.props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const created=calls.filter(call=>call.endpoint==='groups/tasks/create')
 assert.equal(created.length,1)
 assert.equal((created[0]!.payload as {trigger?:string}).trigger,'mention')
 assert.equal((created[0]!.payload as {assignee?:{roleId:string}}).assignee?.roleId,employeeAId)
})

test('从既有消息手工点「建任务」不经过提及流程，请求不带 trigger 键',async()=>{
 const rootMessage:GroupMessage={id:rootMessageId,groupId,rootId:null,authorId:'self',text:'请核对这批资料',references:[],mentions:[],createdAt:stamp}
 const {api,calls}=makeApi({existingMessages:[rootMessage]})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.task.create').props.onClick();app.render()
 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create')
 assert.ok(!app.findAll(el=>el.type==='p'&&app.contentOf(el)==='group.mention.formOpened').length,'手工建任务不应出现提及横幅')
 const form=expandForm(app,dialog)
 await form.props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const created=calls.filter(call=>call.endpoint==='groups/tasks/create')
 assert.equal(created.length,1)
 assert.equal('trigger' in (created[0]!.payload as object)?(created[0]!.payload as {trigger?:string}).trigger:undefined,undefined)
})

test('原消息员工已暂停时不自动指派，不能按同名或旧作者身份猜测负责人',async()=>{
 const rootMessage:GroupMessage={id:rootMessageId,groupId,rootId:null,authorId:employeeBId,taskId:'77777777-7777-4777-8777-777777777777',runId:'88888888-8888-4888-8888-888888888888',text:'请跟进这份结果',references:[],createdAt:stamp}
 const {api,calls}=makeApi({existingMessages:[rootMessage]})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.task.create').props.onClick();app.render()
 const owner=app.find(el=>el.type==='select'&&el.props['aria-label']==='collaboration.task.assignee')
 assert.equal(owner.props.value,'','暂停的原作者不能被预选为新任务负责人')
 assert.equal(calls.filter(call=>call.endpoint==='groups/tasks/create').length,0,'打开与预选本身不创建任务')
})

test('切换到另一个群会清空提及草稿与全员通知，不带旧群残留',async()=>{
 const otherGroupId='77777777-7777-4777-8777-777777777777'
 const groupA=baseGroup(false)
 const groupB={...baseGroup(false),id:otherGroupId,name:'另一群'}
 const snapshotA:GroupSnapshot={group:groupA,members:baseMembers()}
 const snapshotB:GroupSnapshot={group:groupB,members:[{groupId:otherGroupId,roleId:null,createdAt:stamp}]}
 const api={
  get:async(id:string)=>id===groupId?snapshotA:snapshotB,
  messages:async()=>({items:[]}),
  resources:async()=>({items:[]}),
  agentGrant:async()=>({groupVersion:1,roleVersion:1,grant:null,status:'not-granted' as const}),
  list:async()=>({items:[groupA,groupB]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
 } as unknown as GroupApi
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 assert.equal(chipLabels(app).length,1,'切群前应已选中一个提及')
 app.setProps({target:{groupId:otherGroupId,rootId:''}})
 await app.flush()
 assert.equal(chipLabels(app).length,0,'切到另一个群后提及草稿必须清空')
 assert.equal(optionLabels(app).length,0,'候选浮层不得留在打开态')
})

test('撤销群授权恒定提交 canAutoRun:false、canPost:false、resources:[]',async()=>{
 const soloMembers:GroupMember[]=[{groupId,roleId:null,createdAt:stamp},{groupId,roleId:employeeAId,createdAt:stamp}]
 const {api,calls}=makeApi({members:soloMembers})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 app.find(el=>el.type==='button'&&el.props.role!=='menuitem'&&el.props['aria-label']==='collaboration.settings.aria').props.onClick();app.render();app.find(el=>el.props.role==='tab'&&app.contentOf(el)==='collaboration.form.tab.permissions').props.onClick();app.render()
 await app.flush()
 const revokeButton=app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.agentGrant.revoke')
 await revokeButton.props.onClick()
 await app.flush()
 const revoked=calls.filter(call=>call.endpoint==='groups/agent-grants/change')
 assert.equal(revoked.length,1)
 const payload=revoked[0]!.payload as {action:string;canAutoRun:boolean;canPost:boolean;resources:unknown[]}
 assert.equal(payload.action,'revoke')
 assert.equal(payload.canAutoRun,false)
 assert.equal(payload.canPost,false)
 assert.deepEqual(payload.resources,[])
})

test('组件源码不得出现依据 canAutoRun 决定启动/准备/运行的分支',()=>{
 const source=readFileSync(new URL('../src/client/SavedCollaborationPage.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/canAutoRun[^)]*\?\s*(start|prepare|run)/i)
})

/**
 * 用户裁定 B（2026-09-21）：群成员不限业务范围，范围只作「从群建任务时的默认范围」。
 * @ 候选照旧不按范围过滤；建任务负责人候选按契约 roleSupportsScope 同口径过滤（通用工作对所有在岗同事开放，
 * 业务范围仍严格要求岗位声明包含该范围）；提及了不支持本群业务范围的同事时负责人留空并给说明。
 */
test('@ 候选不按群业务范围过滤，但建任务负责人候选按契约同口径过滤且给出说明；提及不支持范围的同事时负责人留空',async()=>{
 const socId='77777777-7777-4777-8777-777777777777',appsecId='99999999-9999-4999-9999-999999999999'
 // 本群业务范围是 SOC：群里原有的 employeeA/employeeD 也要声明 SOC 才继续是候选（不再是 general 万能匹配）。
 const socEmployeeA:PreviewRole={...employeeA,scopes:['SOC']},socEmployeeD:PreviewRole={...employeeD,scopes:['SOC']}
 const socEmployee:PreviewRole={...role(socId,'员工SOC乙','employee','active'),scopes:['SOC']}
 const appsecEmployee:PreviewRole={...role(appsecId,'员工AppSec','employee','active'),scopes:['AppSec']}
 const extendedRoles=[socEmployeeA,socEmployeeD,employeeB,twinC,socEmployee,appsecEmployee]
 const extendedMembers=[...baseMembers(),{groupId,roleId:socId,createdAt:stamp},{groupId,roleId:appsecId,createdAt:stamp}]
 const {api,calls}=makeApi({members:extendedMembers,scope:'SOC'})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles:extendedRoles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 assert.deepEqual(optionLabels(app),['员工甲','员工丁','员工SOC乙','员工AppSec'],'@ 候选不按业务范围过滤（用户裁定 B）')
 chooseOption(app,'员工AppSec')
 typeText(app,draftText(app)+'麻烦看一下这批资料。')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create')
 assert.ok(dialog,'提及不支持范围的员工也必须自动打开建任务表单')
 const select=app.find(el=>el.type==='select'&&Array.isArray(el.props.children)&&(el.props.children as any[]).some(child=>React.isValidElement(child)&&(child.props as {value?:string}).value===''&&app.contentOf(child)==='collaboration.task.unassigned'))
 assert.equal(select.props.value,'','负责人不支持本群范围时必须留空，不能预填一个选不中的值')
 const optionValues=(select.props.children as unknown[]).flat(Infinity).filter(React.isValidElement).map(option=>(option.props as {value:string}).value)
 assert.ok(!optionValues.includes(appsecId),'不支持本群范围（SOC）的 AppSec 员工不出现在负责人候选里')
 assert.ok(optionValues.includes(employeeAId)&&optionValues.includes(employeeDId)&&optionValues.includes(socId),'支持本群范围的在岗员工仍是负责人候选')
 assert.ok(app.find(byContent(app,'group.task.targetHint')),'表单里必须给出固定目标业务与负责人原范围限制的说明')
 await expandForm(app,dialog).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const created=calls.filter(call=>call.endpoint==='groups/tasks/create')
 assert.equal(created.length,0,'具体业务工作必须有支持该目标业务的负责人，不能以未指派任务绕过业务授权')
})

// 2026-09-21 用户裁定：通用工作（general）群里任意在岗正式同事都是建任务负责人候选，不要求岗位声明包含 general。
test('通用工作群的建任务负责人候选不按岗位业务声明过滤',async()=>{
 const socId='88888888-8888-4888-8888-888888888888'
 const socEmployee:PreviewRole={...role(socId,'员工SOC丙','employee','active'),scopes:['SOC']}
 const extendedRoles=[...roles,socEmployee]
 const extendedMembers=[...baseMembers(),{groupId,roleId:socId,createdAt:stamp}]
 const {api,calls}=makeApi({members:extendedMembers})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles:extendedRoles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 chooseOption(app,'员工SOC丙')
 typeText(app,draftText(app)+'麻烦看一下这批资料。')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']==='collaboration.task.create')
 assert.ok(dialog)
 const select=app.find(el=>el.type==='select'&&Array.isArray(el.props.children)&&(el.props.children as any[]).some(child=>React.isValidElement(child)&&(child.props as {value?:string}).value===''&&app.contentOf(child)==='collaboration.task.unassigned'))
 assert.equal(select.props.value,socId,'通用工作范围下被提及的跨范围员工应直接预填为负责人')
 void calls
})

test('删除一位同事的提及时按 token 边界匹配，不会把名字前缀相同的另一位提及标记一并删掉',async()=>{
 const prefixId='88888888-8888-4888-8888-888888888888'
 const employeePrefix=role(prefixId,'员工甲乙','employee','active')
 const extendedRoles=[...roles,employeePrefix]
 const extendedMembers=[...baseMembers(),{groupId,roleId:prefixId,createdAt:stamp}]
 const {api}=makeApi({members:extendedMembers})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles:extendedRoles,profileName:'测试者'})
 await app.flush()
 mentionByTyping(app,'员工甲')
 typeText(app,draftText(app)+'@员工甲乙')
 chooseOption(app,'员工甲乙')
 assert.equal(draftText(app),'@员工甲 @员工甲乙 ')
 assert.deepEqual(chipLabels(app),['员工甲','员工甲乙'])
 const closeButtons=app.findAll(el=>el.type==='button'&&el.props['aria-label']==='collaboration.form.close')
 assert.equal(closeButtons.length,2)
 closeButtons[0]!.props.onClick();app.render()
 assert.equal(draftText(app),'@员工甲乙 ','只删「员工甲」自己的 token，不能连带删掉「员工甲乙」的前缀')
 assert.deepEqual(chipLabels(app),['员工甲乙'])
})

function expandForm(app:ReturnType<typeof mount>,dialog:React.ReactElement<Record<string,any>>):React.ReactElement<Record<string,any>>{
 const children=(dialog.props as {children?:React.ReactNode}).children
 const list=Array.isArray(children)?children:[children]
 for(const child of list){
  if(!React.isValidElement<Record<string,any>>(child))continue
  if(child.type==='form')return child
 }
 throw Error('对话框内没有 form 元素')
}

/**
 * 群引用资料改走会话式候选（2026-10-14）：正文 @ 与引用图标到达同一份本群资料候选，员工与资料分组、同名不混淆；
 * 选资料一次即带入固定版本引用并关闭候选，撤销只能走待发送区标签；资料候选不产生提及，不自动授权。
 */
const resourceRow=(id:string,title:string,version:number,withdrawnAt:string|null=null):ResourceRow=>({id,groupId,ownerId:'self',version,title,withdrawnAt,createdAt:stamp,updatedAt:stamp})
const sameNameResourceId='77777777-7777-4777-8777-777777777777'
const planResourceId='88888888-8888-4888-8888-888888888888'
const withdrawnResourceId='99999999-9999-4999-8999-999999999999'
const referenceResources=()=>[resourceRow(sameNameResourceId,'员工甲',3),resourceRow(planResourceId,'方案资料',2),resourceRow(withdrawnResourceId,'已撤回资料',1,stamp)]
const optionNodes=(app:ReturnType<typeof mount>)=>app.findAll(el=>el.type==='li'&&el.props.role==='option')
const sectionLabels=(app:ReturnType<typeof mount>)=>app.findAll(el=>el.type==='li'&&el.props.role==='presentation').map(el=>app.contentOf(el))
const resourceOption=(app:ReturnType<typeof mount>,title:string)=>app.find(el=>el.type==='li'&&el.props.role==='option'&&String(el.props.id).startsWith('resource-')&&app.contentOf(el).startsWith(title))
const referenceChips=(app:ReturnType<typeof mount>)=>app.findAll(el=>el.type==='span'&&el.props.className==='attachmentChip').map(el=>app.contentOf(el))
const referenceIcon=(app:ReturnType<typeof mount>)=>app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.composer.references')

test('正文敲 @ 时员工与本群资料分组列出，同名资料与员工不混淆；选资料只带入固定版本引用、不产生提及',async()=>{
 const {api,calls}=makeApi({resources:referenceResources()})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'请看 @员')
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(listbox.props['aria-label'],'group.mention.pickAny','有资料时候选同时覆盖员工与资料')
 assert.deepEqual(sectionLabels(app),['group.mention.sectionEmployees','group.mention.sectionResources'],'员工与资料各自成组')
 const ids=optionNodes(app).map(el=>String(el.props.id))
 assert.deepEqual(ids,['mention-main-'+employeeAId,'mention-main-'+employeeDId,'resource-main-'+sameNameResourceId],'同名员工与资料是两条不同身份的候选')
 assert.equal(optionOf(app,'员工甲').props.id,'mention-main-'+employeeAId)
 assert.ok(app.contentOf(resourceOption(app,'员工甲')).includes('collaboration.resources.versionLabel:{"version":3}'),'资料候选标明固定版本')
 assert.equal(optionNodes(app).some(el=>app.contentOf(el).includes('已撤回资料')),false,'已撤回资料不列入')
 resourceOption(app,'员工甲').props.onMouseDown({preventDefault:()=>{}});app.render()
 assert.equal(draftText(app),'请看 ','选资料后去掉正文里的 @过滤词，引用落在待发送区标签')
 assert.deepEqual(chipLabels(app),[],'选资料不产生提及')
 assert.deepEqual(referenceChips(app).map(label=>label.startsWith('员工甲')),[true])
 assert.equal(optionLabels(app).length,0,'选一次就关闭候选')
 typeText(app,'请看这份资料。')
 await composerForm(app).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const sent=calls.filter(call=>call.endpoint==='groups/messages/send')
 assert.equal(sent.length,1)
 assert.deepEqual((sent[0]!.payload as {references?:unknown}).references,[{kind:'group-resource',id:sameNameResourceId,version:3}],'引用只带 id 与固定版本')
 assert.equal((sent[0]!.payload as {mentions?:unknown}).mentions,undefined,'资料引用不写 mentions')
 assert.equal(calls.some(call=>call.endpoint.includes('grant')),false,'选资料不触发任何员工授权请求')
})

test('↑↓ 跨过分组标题在员工与资料之间移动，Tab 也能选中资料；Esc 关闭候选',async()=>{
 const {api}=makeApi({resources:referenceResources()})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 assert.deepEqual(optionNodes(app).map(el=>String(el.props.id).split('-')[0]),['mention','mention','resource','resource'])
 assert.equal(optionOf(app,'员工甲').props['aria-selected'],true)
 pressKey(app,'ArrowUp')
 assert.equal(resourceOption(app,'方案资料').props['aria-selected'],true,'向上越过第一条回到最后一条资料')
 assert.equal(textareaOf(app).props['aria-activedescendant'],'resource-main-'+planResourceId)
 pressKey(app,'ArrowDown');pressKey(app,'ArrowDown');pressKey(app,'ArrowDown')
 assert.equal(resourceOption(app,'员工甲').props['aria-selected'],true,'向下移动跨过分组标题进入资料组')
 pressKey(app,'Escape')
 assert.equal(optionLabels(app).length,0,'Esc 关闭候选')
 typeText(app,'@方')
 assert.deepEqual(sectionLabels(app),['group.mention.sectionResources'],'只剩资料匹配时只显示资料组')
 pressKey(app,'Tab')
 assert.deepEqual(referenceChips(app).map(label=>label.startsWith('方案资料')),[true])
 assert.equal(draftText(app),'')
})

test('引用图标与正文 @ 到达同一份资料候选；已引用的资料在候选里禁用，撤销只能走标签',async()=>{
 const {api}=makeApi({resources:referenceResources()})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@')
 const typedIds=optionNodes(app).map(el=>String(el.props.id)).filter(id=>id.startsWith('resource-'))
 pressKey(app,'Escape')
 referenceIcon(app).props.onClick();app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(listbox.props['aria-label'],'collaboration.composer.references')
 assert.deepEqual(optionNodes(app).map(el=>String(el.props.id)),typedIds,'图标打开的资料候选与正文 @ 的资料候选一致')
 assert.deepEqual(sectionLabels(app),['group.mention.sectionResources'],'图标只列资料/文件，不含员工组')
 resourceOption(app,'方案资料').props.onMouseDown({preventDefault:()=>{}});app.render()
 assert.equal(optionLabels(app).length,0)
 assert.equal(referenceIcon(app).props['aria-expanded'],false)
 referenceIcon(app).props.onClick();app.render()
 const picked=resourceOption(app,'方案资料')
 assert.equal(picked.props['aria-disabled'],true,'已引用的资料禁用')
 assert.ok(app.contentOf(picked).includes('group.mention.referenced'))
 picked.props.onMouseDown({preventDefault:()=>{}});app.render()
 assert.deepEqual(referenceChips(app).map(label=>label.startsWith('方案资料')),[true],'再点已引用项不会撤销')
 assert.equal(optionLabels(app).length,2,'点禁用项不关闭候选')
 pressKey(app,'Escape')
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.attachment.remove:{"name":"方案资料"}').props.onClick();app.render()
 assert.deepEqual(referenceChips(app),[])
 referenceIcon(app).props.onClick();app.render()
 assert.equal(resourceOption(app,'方案资料').props['aria-disabled'],false,'移除标签后可再次引用')
})

test('引用已满 8 项时资料候选禁用并给出上限提示',async()=>{
 const many=Array.from({length:9},(_,index)=>resourceRow('aaaaaaaa-aaaa-4aaa-8aaa-'+String(index).padStart(12,'0'),'资料'+index,1))
 const {api}=makeApi({resources:many})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 for(let index=0;index<8;index++){referenceIcon(app).props.onClick();app.render();resourceOption(app,'资料'+index).props.onMouseDown({preventDefault:()=>{}});app.render()}
 assert.equal(referenceChips(app).length,8)
 referenceIcon(app).props.onClick();app.render()
 assert.equal(resourceOption(app,'资料8').props['aria-disabled'],true)
 assert.ok(app.find(el=>el.props.role==='status'&&app.contentOf(el)==='collaboration.attachment.tooMany'))
})

test('引用图标在光标处插入 @ 并进入只列资料/文件模式：继续输入按关键词过滤本群资料或文件、不列员工，token 消失才退出；选一次带入并关闭',async()=>{
 const {api,calls}=makeApi({resources:referenceResources()})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'请看')
 referenceIcon(app).props.onClick();app.render()
 assert.equal(draftText(app),'请看 @','图标与 @ 按钮一样在光标处插入触发符')
 assert.equal(app.find(el=>el.type==='ul'&&el.props.role==='listbox').props['aria-label'],'collaboration.composer.references')
 assert.deepEqual(optionNodes(app).map(el=>String(el.props.id).split('-')[0]),['resource','resource'],'只列资料/文件，不列员工')
 typeText(app,'请看 @员')
 assert.deepEqual(optionNodes(app).map(el=>String(el.props.id)),['resource-main-'+sameNameResourceId],'继续输入沿用同一关键词过滤，同名员工不混入')
 assert.equal(referenceIcon(app).props['aria-expanded'],true,'输入关键词不会关闭图标打开的候选')
 typeText(app,'请看 @不存在')
 assert.equal(optionNodes(app).length,0)
 assert.ok(app.find(el=>el.type==='li'&&el.props.role==='presentation'&&app.contentOf(el)==='group.materials.noMatch'),'无匹配时留在候选里提示，不静默消失')
 typeText(app,'请看 @方')
 pressKey(app,'Enter')
 assert.deepEqual(referenceChips(app).map(label=>label.startsWith('方案资料')),[true])
 assert.equal(draftText(app),'请看 ','选中后去掉 @过滤词')
 assert.equal(optionLabels(app).length,0);assert.equal(referenceIcon(app).props['aria-expanded'],false)
 // token 被用户删掉才退出只列资料模式；再敲 @ 回到员工+资料的普通候选。
 referenceIcon(app).props.onClick();app.render()
 assert.equal(draftText(app),'请看 @')
 typeText(app,'请看 ')
 assert.equal(referenceIcon(app).props['aria-expanded'],false);assert.equal(optionLabels(app).length,0)
 typeText(app,'请看 @')
 assert.deepEqual(sectionLabels(app),['group.mention.sectionEmployees','group.mention.sectionResources'])
 pressKey(app,'Escape')
 assert.equal(draftText(app),'请看 @','Esc 只收起候选，不偷删用户的查询词')
 assert.equal(calls.filter(call=>call.endpoint==='groups/messages/send').length,0)
})
