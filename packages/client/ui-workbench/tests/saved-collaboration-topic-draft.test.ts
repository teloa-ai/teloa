import {groupResultFixtureModule} from './group-result-fixture.ts'
import {applicationCapabilityModule} from './application-capability-fixture.ts'
import * as knowledgeMarkdown from '../src/client/knowledge-markdown-core.ts'
import * as industryTeamMaterials from '../src/client/industry-team-materials.ts'
import {staffAvatarComponent,personalProfileForGroup} from './staff-avatar-component.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {contentOf,markdownPrimitivesStub,testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {Group,GroupChangeFields,GroupMember,GroupMessage} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore,type SavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import type {PendingAttachment} from '../src/client/group-attachment-api.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {GroupWorkContext,SavedConversationDirectory} from '../src/client/SavedCollaborationPage.js'
import type {WorkbenchNavigationStorage} from '../src/client/workbench-navigation-state.js'

/**
 * 复现「返回来源话题」后草稿是否丢失：真实运行 SavedCollaborationPage.tsx 的组件函数与
 * useEffect，只替换钩子调度（与 page-create-render.test.ts 的手法一致），不经过 jsdom。
 */

// 面板打开/关闭的焦点归还只探测 document.activeElement；测试跑在 node 里没有 DOM，补最小桩。
if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

const stamp='2026-09-20T01:00:00.000Z'
const groupId='11111111-1111-4111-8111-111111111111'
const rootId='22222222-2222-4222-8222-222222222222'
const replyId='33333333-3333-4333-8333-333333333333'

const group:Group={id:groupId,ownerId:'self',version:1,name:'资料核对群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:stamp,updatedAt:stamp}
const member:GroupMember={groupId,roleId:null,createdAt:stamp}
const changedGroup=(current:Group,fields:GroupChangeFields):Group=>{
 const {coordinatorRoleId:previous,...group}=current,{coordinatorRoleId:requested,...changes}=fields
 const coordinatorRoleId=requested===undefined?previous:requested
 return {...group,...changes,...(coordinatorRoleId?{coordinatorRoleId}:{})}
}
const snapshot:GroupSnapshot={group,members:[member]}
const rootMessage:GroupMessage={id:rootId,groupId,rootId:null,authorId:'self',text:'请核对这批资料并保留来源',references:[],mentions:[],createdAt:stamp}
const replyMessage:GroupMessage={id:replyId,groupId,rootId,authorId:'self',text:'形成可复核工作结论',references:[],mentions:[],createdAt:stamp}

function makeApi(resources:unknown[]=[]):GroupApi{
 return {
  get:async(id:string)=>{assert.equal(id,groupId);return snapshot},
  messages:async(id:string,forRoot?:string)=>{
   assert.equal(id,groupId)
   if(forRoot===undefined)return {items:[rootMessage]}
   if(forRoot===rootId)return {items:[rootMessage,replyMessage]}
   throw Error('未预期的话题根：'+forRoot)
  },
  resources:async()=>({items:resources}),
  agentGrant:async()=>({groupVersion:1,roleVersion:1,grant:null,status:'not-granted'}),
  list:async()=>({items:[group]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
 } as unknown as GroupApi
}

type Props={preferences?:WorkbenchNavigationStorage;work?:GroupWorkContext;visible:boolean;api:GroupApi;directory?:SavedConversationDirectory;target:{groupId:string;rootId:string}|null;roles:unknown[];profileName:string}

/** 执行真实组件函数与真实 effect 调度；只有顶层组件手动调用，嵌套子组件在展开时按普通函数调用。 */
function mount(initial:Props,options?:{draftStore?:SavedCollaborationDraftStore;scheduleRefresh?:(run:()=>Promise<void>)=>(()=>void)}){
 let props=initial
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks={...React,
  useId:()=>'group-reference-test',
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
  // 本文件核对群草稿和异步回包；渠道读回由 group-channel-bindings.test.ts 单独覆盖。
  if(id==='./GroupChannelBindings.js')return {GroupChannelBindings:()=>null}
  const capability=applicationCapabilityModule(id);if(capability!==undefined)return capability
  if(id==='react')return hooks
  if(id==='./ContextDrawer.js')return {ContextDrawer:({children,title,open}:any)=>open?React.createElement('dialog',{'aria-label':title},children):null}
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
  if(id.endsWith('business-scope-context.js'))return {useBusinessScopes:()=>({general:'general'})}
  if(id.endsWith('saved-collaboration-state.js'))return savedCollaborationState
  if(id.endsWith('saved-collaboration-drafts.js'))return {savedCollaborationDrafts:options?.draftStore??createSavedCollaborationDraftStore()}
  if(id.endsWith('team-presentation.js'))return {twinDisplayName:(name:string)=>name}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t,time:(value:string)=>value,date:(value:string)=>value.slice(0,10),dateTime:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:options?.scheduleRefresh??(()=>()=>{})}
  // 群内直接回应一期 T14 接线后 SavedCollaborationPage 多了这两处依赖；本文件不测表情与折叠行，一律给空实现。
  if(id.endsWith('GroupReactionBar.js'))return {GroupReactionBar:()=>null,GroupEmojiPicker:()=>null}
  if(id.endsWith('group-routing-view.js'))return {groupRoutingPending:()=>[]}
  // DSH 平台模块，Node 下装不起来，给透传桩（见 saved-message-markdown-stubs.ts）。
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return markdownPrimitivesStub
  // 本夹具未接工作关联端口；新组件边界另有源渲染与浏览器用例，不应进入此旧消息测试。
  if(id==='./GroupLinkedWork.js')return {GroupLinkedWork:()=>{throw Error('未接工作关联端口的消息夹具不应渲染关联组件')}}
  // 此夹具没有模板资料端口；保留真实引用合并，意外渲染资料组件时直接失败。
  if(id==='./industry-team-materials.js')return industryTeamMaterials
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
 const flush=async()=>{for(let round=0;round<8;round++){await Promise.resolve();render()}return tree}
 /** 展开元素树：函数组件当场调用求值（本文件内子组件都不持有自身状态），宿主元素保留以便断言。 */
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(node.props.hidden)return []
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

const byAria=(label:string)=>(el:React.ReactElement<Record<string,any>>)=>el.props['aria-label']===label

test('刷新重挂从当前群的导航偏好恢复概况，另一群不能继承该面板',async()=>{
 const rows=new Map([[`teloa.group-panel/v1/${groupId}`,JSON.stringify({schema:'teloa.group-panel/v1',kind:'overview',tab:'work'})]])
 const preferences={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const secondId='99999999-9999-4999-8999-999999999999',api=makeApi()
 api.get=async id=>({group:{...group,id},members:[{...member,groupId:id}]})
 api.messages=async()=>({items:[]})
 const app=mount({visible:true,api,preferences,target:{groupId,rootId:''},roles:[],profileName:'测试者'})
 await app.flush()
 const overview=(el:React.ReactElement<Record<string,any>>)=>el.type==='aside'&&el.props['aria-label']==='overview.title'
 assert.equal(app.findAll(overview).length,1,'当前群已展开的概况应恢复')
 app.setProps({target:{groupId:secondId,rootId:''}})
 await app.flush()
 assert.equal(app.findAll(overview).length,0,'未保存展开偏好的另一群仍保持关闭')
})

test('群面板的显式关闭保存为本人关闭偏好，恢复偏好不抢占来源话题',async()=>{
 const rows=new Map<string,string>(),preferences={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const props:Props={visible:true,api:makeApi(),preferences,target:{groupId,rootId:''},roles:[],profileName:'测试者'}
 const app=mount(props)
 await app.flush()
 app.find(byAria('overview.title')).props.onClick()
 assert.deepEqual(JSON.parse(rows.get(`teloa.group-panel/v1/${groupId}`)!),{schema:'teloa.group-panel/v1',kind:'overview',tab:'work'})
 const fromTopic=mount({...props,target:{groupId,rootId}})
 await fromTopic.flush()
 assert.equal(fromTopic.findAll(el=>el.type==='aside'&&el.props['aria-label']==='collaboration.panel.topic').length,1)
 const previousFrame=(globalThis as Record<string,unknown>).requestAnimationFrame
 ;(globalThis as Record<string,unknown>).requestAnimationFrame=(run:()=>void)=>{run();return 1}
 try{app.find(byAria('collaboration.panel.close')).props.onClick()}finally{(globalThis as Record<string,unknown>).requestAnimationFrame=previousFrame}
 assert.deepEqual([...rows.keys()],[`teloa.group-panel/v1/${groupId}`])
 assert.deepEqual(JSON.parse(rows.get(`teloa.group-panel/v1/${groupId}`)!),{schema:'teloa.group-panel/v1',kind:'closed',tab:'work'})
 const reloaded=mount(props)
 await reloaded.flush()
 assert.equal(reloaded.findAll(el=>el.type==='aside'&&['overview.title','collaboration.panel.topic'].includes(el.props['aria-label'])).length,0)
})

test('宽屏无偏好默认进入工作概览；本人关闭、已选资料和窄窗分别保持，话题不改写偏好',async()=>{
 const rows=new Map<string,string>(),preferences={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const host=globalThis as Record<string,unknown>,previousWindow=host.window,previousFrame=host.requestAnimationFrame
 let width=1600
 host.window={matchMedia:(query:string)=>({matches:query.includes('min-width')?width>=1381:width<=740})}
 host.requestAnimationFrame=(run:()=>void)=>{run();return 1}
 const key=`teloa.group-panel/v1/${groupId}`,props:Props={visible:true,api:makeApi(),preferences,target:{groupId,rootId:''},roles:[],profileName:'测试者'}
 const panel=(label:string)=>(el:React.ReactElement<Record<string,any>>)=>el.type==='aside'&&el.props['aria-label']===label
 const sidePanel=(el:React.ReactElement<Record<string,any>>)=>el.type==='aside'&&['overview.title','collaboration.view.materials','group.panel.members','collaboration.panel.topic'].includes(el.props['aria-label'])
 try{
  const first=mount(props)
  await first.flush()
  assert.equal(first.findAll(panel('overview.title')).length,1,'宽屏且此前无偏好时进入工作概览')
  assert.equal(rows.size,0,'默认展开不伪造本人偏好')
  first.find(byAria('collaboration.panel.close')).props.onClick()
  assert.deepEqual(JSON.parse(rows.get(key)!),{schema:'teloa.group-panel/v1',kind:'closed',tab:'work'})
  const closed=mount(props)
  await closed.flush()
  assert.equal(closed.findAll(sidePanel).length,0,'本人关闭后宽屏也不再自动展开')
  rows.set(key,JSON.stringify({schema:'teloa.group-panel/v1',kind:'materials',tab:'work'}))
  const materials=mount(props)
  await materials.flush()
  assert.equal(materials.findAll(panel('collaboration.view.materials')).length,1,'已保存的资料选择优先于默认概览')
  width=700
  const narrow=mount(props)
  await narrow.flush()
  assert.equal(narrow.findAll(sidePanel).length,0,'窄窗不自动盖住讨论')
  assert.deepEqual(JSON.parse(rows.get(key)!),{schema:'teloa.group-panel/v1',kind:'materials',tab:'work'},'窄窗不改写本人偏好')
  width=1600
  const topic=mount({...props,target:{groupId,rootId}})
  await topic.flush()
  assert.equal(topic.findAll(panel('collaboration.panel.topic')).length,1)
  assert.deepEqual(JSON.parse(rows.get(key)!),{schema:'teloa.group-panel/v1',kind:'materials',tab:'work'},'打开来源话题不清除面板偏好')
 }finally{host.window=previousWindow;host.requestAnimationFrame=previousFrame}
})

test('A 群设置经隐藏再切 B 群，不混入 B 权限渠道且原群草稿保留',async()=>{
 const secondId='99999999-9999-4999-8999-999999999999'
 const second={...group,id:secondId,name:'B 协作群'}
 const api=makeApi(),writes:string[]=[]
 api.get=async id=>({group:id===groupId?group:second,members:[{...member,groupId:id}]})
 api.messages=async()=>({items:[]})
 api.change=async(id,_version,fields)=>{writes.push(id);return {group:changedGroup(id===groupId?group:second,fields),members:[{...member,groupId:id}]}}
 const app=mount({visible:true,api,target:{groupId,rootId:''},roles:[],profileName:'测试者'})
 await app.flush()
 // 读取真实父组件树，避免手工钩子夹具把各子组件的钩子槽混在一起。
 const elements=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(elements)
  if(!React.isValidElement<Record<string,any>>(node))return []
  return [node,...elements(node.props.children)]
 }
 const tree=()=>elements(app.render())
 const settings=()=>tree().find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.settings.aria')!
 const form=()=>tree().find(el=>typeof el.type==='function'&&el.type.name==='SavedGroupForm')!
 const composer=()=>tree().find(el=>typeof el.type==='function'&&el.type.name==='SavedComposer')!
 composer().props.setText('A 群未发送草稿')
 settings().props.onClick()
 assert.equal(form().props.open,true)
 assert.equal(form().props.form.snapshot.group.id,groupId)
 assert.equal(form().props.channels.props.groupId,groupId)
 app.setProps({visible:false})
 app.setProps({visible:true,target:{groupId:secondId,rootId:''}})
 await app.flush()
 assert.equal(form().props.form.snapshot.group.id,groupId,'保留 A 的原编辑对象')
 assert.equal(form().props.open,false,'B 群不能重开 A 的设置抽屉')
 assert.equal(form().props.permissions,undefined,'A 设置不能接入 B 的授权面')
 assert.ok(!form().props.channels,'A 设置不能读取 B 的渠道')
 assert.equal(composer().props.text,'','B 不继承 A 消息草稿')
 settings().props.onClick()
 assert.equal(form().props.open,true)
 assert.equal(form().props.form.snapshot.group.id,secondId)
 assert.equal(form().props.channels.props.groupId,secondId)
 assert.ok(form().props.permissions)
 await form().props.save({name:'B 群新名称',announcement:'',rules:second.rules,memberRoleIds:[],pinned:false,archived:false})
 await app.flush()
 assert.deepEqual(writes,[secondId],'B 的设置只保存 B 对象')
 app.setProps({target:{groupId,rootId:''}})
 await app.flush()
 assert.equal(composer().props.text,'A 群未发送草稿')
})

test('返回来源话题：话题草稿在组件重新载入同一话题后必须保留',async()=>{
 const api=makeApi()
 const directory:SavedConversationDirectory={refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}
 const app=mount({visible:true,api,directory,target:{groupId,rootId:''},roles:[],profileName:'测试者'})
 await app.flush()

 // 点开根消息的「在话题中回复」，进入话题面板。
 const openTopicButton=app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.reply.action')
 openTopicButton.props.onClick()
 await app.flush()

 // 话题面板里的composer 与主列表 composer 共用 aria-label，话题面板的是最后一个。
 const topicComposerBefore=app.findAll(byAria('collaboration.composer.aria')).at(-1)!
 assert.equal(topicComposerBefore.props.value,'')
 const draftText='尚未发送的话题草稿-1'
 topicComposerBefore.props.onChange({target:{value:draftText}})
 app.render()
 const topicComposerAfterTyping=app.findAll(byAria('collaboration.composer.aria')).at(-1)!
 assert.equal(topicComposerAfterTyping.props.value,draftText,'草稿必须先写入组件状态')

 // 模拟任务详情页「返回来源话题」：外壳把 groupTarget.rootId 从初始的 '' 换成真实话题根 id，
 // 触发 SavedCollaborationPage 里依赖 target 的 useEffect 重新 loadGroup 同一话题。
 app.setProps({visible:false})
 app.setProps({target:{groupId,rootId},visible:true})
 await app.flush()

 const topicComposerAfterReturn=app.findAll(byAria('collaboration.composer.aria')).at(-1)!
 assert.equal(topicComposerAfterReturn.props.value,draftText,'返回来源话题后草稿丢失')
})

test('返回来源话题（整段卸载再重挂）：SavedCollaborationPage 被真实卸载后以相同 groupId/rootId 重挂，话题草稿仍须保留',async()=>{
 const api=makeApi()
 const directory:SavedConversationDirectory={refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}
 // 用同一份草稿存储贯穿两次 mount：生产环境里这份存储只随页面生命周期创建一次，
 // 组件树反复卸载/重挂不会重新创建它；这里显式共享同一实例来复现「切到同事视图」那次真实卸载。
 const draftStore=createSavedCollaborationDraftStore()

 const firstMount=mount({visible:true,api,directory,target:{groupId,rootId:''},roles:[],profileName:'测试者'},{draftStore})
 await firstMount.flush()
 const openTopicButton=firstMount.find(el=>el.type==='button'&&firstMount.contentOf(el)==='collaboration.reply.action')
 openTopicButton.props.onClick()
 await firstMount.flush()
 const topicComposerBefore=firstMount.findAll(byAria('collaboration.composer.aria')).at(-1)!
 const draftText='尚未发送的话题草稿-2'
 topicComposerBefore.props.onChange({target:{value:draftText}})
 firstMount.render()
 const topicComposerAfterTyping=firstMount.findAll(byAria('collaboration.composer.aria')).at(-1)!
 assert.equal(topicComposerAfterTyping.props.value,draftText,'草稿必须先写入第一次挂载的组件状态')

 // 「切到左栏『同事』」在真实应用里会把 CollaborationPage/SavedCollaborationPage 整段卸载；
 // 这里不复用 firstMount 的任何状态，直接以「返回来源话题」会传入的 target（groupId+rootId 均已知）
 // 重新 mount 一个全新的组件实例，模拟从任务详情点「返回来源话题」时的真实重挂路径。
 const secondMount=mount({visible:true,api,directory,target:{groupId,rootId},roles:[],profileName:'测试者'},{draftStore})
 await secondMount.flush()
 const topicComposerAfterRemount=secondMount.findAll(byAria('collaboration.composer.aria')).at(-1)!
 assert.equal(topicComposerAfterRemount.props.value,draftText,'组件整段卸载再重挂后，话题草稿必须保留')
})

/**
 * 第四类草稿（待发送附件）直接对存储做单元验证：上传中／已上传待发送的附件是跨视图存活的状态，
 * 不得挂 useState（本文件顶部注释已解释「返回来源话题」会把 SavedCollaborationPage 整段卸载重挂）。
 * 这里不经过组件渲染，直接验证 saved-collaboration-drafts.ts 的第四类草稿口径与提及同形。
 */
const groupOther='99999999-9999-4999-8999-999999999999'
const uploadingAttachment:PendingAttachment={key:'draft-1',name:'现场截图.png',mime:'image/png',state:'uploading',requestId:'88888888-8888-4888-8888-888888888888'}

test('附件草稿：整段卸载重挂（读同一存储、同一群）后仍在',()=>{
 const draftStore=createSavedCollaborationDraftStore()
 draftStore.writeGroupAttachmentDrafts(groupId,'main',[uploadingAttachment])
 // 「返回来源话题」重挂后仍是同一个群：readGroupDraftEntry 用同一 groupId 重读，不应清空附件草稿。
 const reread=draftStore.readGroupDraftEntry(groupId)
 assert.deepEqual(reread.attachmentDrafts.main,[uploadingAttachment])
})

test('附件草稿：往返切群仍保留原群附件标签，不遗留不可见引用',()=>{
 const draftStore=createSavedCollaborationDraftStore()
 draftStore.writeGroupAttachmentDrafts(groupOther,'main',[uploadingAttachment])
 draftStore.readGroupDraftEntry(groupId)
 const switched=draftStore.readGroupDraftEntry(groupOther)
 assert.deepEqual(switched.attachmentDrafts.main,[uploadingAttachment])
 assert.deepEqual(draftStore.readGroupDraftEntry(groupId).attachmentDrafts,{})
})

test('附件草稿：发送成功后随正文与引用一并清空',()=>{
 const draftStore=createSavedCollaborationDraftStore()
 draftStore.writeGroupDraftText(groupId,'main','已发送的正文')
 draftStore.writeGroupAttachmentDrafts(groupId,'main',[uploadingAttachment])
 draftStore.clearGroupSentDraft(groupId,'main')
 const after=draftStore.readGroupDraftEntry(groupId)
 assert.deepEqual(after.attachmentDrafts.main,[])
 assert.equal(after.drafts.main,'')
})

test('发送回包较慢时，后续输入不能被上一条消息清空，跨挂载仍保留',async()=>{
 let finishSend!:(message:GroupMessage)=>void
 const api=makeApi()
 api.send=()=>new Promise(resolve=>{finishSend=resolve})
 const draftStore=createSavedCollaborationDraftStore()
 const props={visible:true,api,target:{groupId,rootId},roles:[],profileName:'测试者'}
 const app=mount(props,{draftStore});await app.flush()
 const composer=()=>app.findAll(byAria('collaboration.composer.aria')).at(-1)!
 composer().props.onChange({target:{value:'第一条消息'}});app.render()
 const sendForm=app.findAll(el=>el.type==='form').at(-1)!
 sendForm.props.onSubmit({preventDefault(){}});await app.flush()
 composer().props.onChange({target:{value:'下一条尚未发送的草稿'}});app.render()
 finishSend(replyMessage);await app.flush();await app.flush()
 assert.equal(composer().props.value,'下一条尚未发送的草稿')
 const remounted=mount(props,{draftStore});await remounted.flush()
 assert.equal(remounted.findAll(byAria('collaboration.composer.aria')).at(-1)!.props.value,'下一条尚未发送的草稿')
})


test('发送期间仅附件改变也保留整份草稿，未编辑的发送仍清空',()=>{
 const store=createSavedCollaborationDraftStore()
 store.writeGroupDraftText(groupId,'main','正文')
 const sent=store.readGroupDraftEntry(groupId)
 store.writeGroupAttachmentDrafts(groupId,'main',[uploadingAttachment])
 assert.equal(store.clearGroupSentDraft(groupId,'main',sent),false)
 const next=store.readGroupDraftEntry(groupId)
 assert.equal(next.drafts.main,'正文')
 assert.deepEqual(next.attachmentDrafts.main,[uploadingAttachment])
 assert.equal(store.clearGroupSentDraft(groupId,'main',next),true)
 assert.equal(store.readGroupDraftEntry(groupId).drafts.main,'')
})

test('发出消息后切到另一群，迟到回执不清空新群草稿或切回原群',async()=>{
 let finish!:(message:GroupMessage)=>void
 const api=makeApi(),second={...group,id:groupOther,name:'另一群'}
 api.get=async id=>({group:id===groupOther?second:group,members:[]})
 api.messages=async()=>({items:[]})
 api.send=()=>new Promise(resolve=>{finish=resolve})
 const store=createSavedCollaborationDraftStore(),app=mount({visible:true,api,target:{groupId,rootId:''},roles:[],profileName:'测试者'},{draftStore:store})
 await app.flush()
 const composer=()=>app.findAll(byAria('collaboration.composer.aria'))[0]!
 composer().props.onChange({target:{value:'原群已发送'}});app.render()
 app.findAll(el=>el.type==='form')[0]!.props.onSubmit({preventDefault(){}});await app.flush()
 app.setProps({target:{groupId:groupOther,rootId:''}});await app.flush()
 composer().props.onChange({target:{value:'另一群尚未发送'}});app.render()
 finish({...rootMessage,text:'原群已发送'});await app.flush();await app.flush()
 assert.equal(composer().props.value,'另一群尚未发送')
 assert.ok(app.findAll(el=>el.type==='h1'&&app.contentOf(el)==='另一群').length)
})

test('核对失败发送成功后只清理已核对草稿，保留其他话题',async()=>{
 const store=createSavedCollaborationDraftStore(),api=makeApi()
 store.writeGroupDraftText(groupId,'main','留在群内的草稿')
 store.writeGroupDraftText(groupId,rootId,'已核对的回复')
 api.pending=()=>({kind:'send',request:{requestId:replyId,groupId,expectedVersion:1,rootId,text:'已核对的回复'}})
 api.recover=async()=>({...replyMessage,text:'已核对的回复'})
 const app=mount({visible:true,api,target:{groupId,rootId},roles:[],profileName:'测试者'},{draftStore:store});await app.flush()
 const button=app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.action.recover')
 await button.props.onClick();await app.flush()
 assert.equal(store.readGroupDraftEntry(groupId).drafts[rootId],'')
 assert.equal(store.readGroupDraftEntry(groupId).drafts.main,'留在群内的草稿')
})

test('恢复旧发送前新添的上传中附件必须保留',async()=>{
 const store=createSavedCollaborationDraftStore(),api=makeApi()
 store.writeGroupDraftText(groupId,'main','已发送正文')
 store.writeGroupAttachmentDrafts(groupId,'main',[uploadingAttachment])
 api.pending=()=>({kind:'send',request:{requestId:replyId,groupId,expectedVersion:1,text:'已发送正文'}})
 api.recover=async()=>({...rootMessage,text:'已发送正文'})
 const app=mount({visible:true,api,target:{groupId,rootId:''},roles:[],profileName:'测试者'},{draftStore:store});await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.action.recover').props.onClick();await app.flush()
 assert.equal(store.readGroupDraftEntry(groupId).attachmentDrafts.main?.length,1)
})


test('群设置打开后轮询读到新版本，保存仍使用编辑基线并保留冲突草稿',async()=>{
 const api=makeApi()
 let latest:GroupSnapshot={...snapshot,group:{...snapshot.group,announcement:'原公告'}}
 let poll:(()=>Promise<void>)|undefined
 let submitted:{id:string;expectedVersion:number;fields:unknown}|undefined
 api.get=async()=>latest
 api.change=async(id,expectedVersion,fields)=>{
  submitted={id,expectedVersion,fields}
  if(expectedVersion!==latest.group.version)throw Object.assign(Error('群设置版本已变化'),{code:'teloa/version-conflict'})
  latest={...latest,group:{...changedGroup(latest.group,fields),version:expectedVersion+1}}
  return latest
 }
 const app=mount({visible:true,api,target:{groupId,rootId:''},roles:[],profileName:'测试者'},
  {scheduleRefresh:run=>{poll=run;return()=>{}}})
 await app.flush()
 const settingsAvatar=app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.settings.aria'&&el.props.role!=='menuitem')
 const settingsMenu=app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.settings.aria'&&el.props.role==='menuitem')
 settingsAvatar.props.onClick()
 // 只读父组件产生的表单 props，不展开子组件钩子，确保执行的是父级真实保存闭包。
 const form=()=>{
  const collect=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
   if(Array.isArray(node))return node.flatMap(collect)
   if(!React.isValidElement<Record<string,any>>(node))return []
   if(typeof node.type==='function'&&node.type.name==='SavedGroupForm')return [node]
   return collect(node.props.children)
  }
  const matches=collect(app.render())
  assert.equal(matches.length,1,'冲突后应保留原群设置表单')
  return matches[0]!
 }
 assert.equal(form().props.form.snapshot.group.version,1)
 form().props.close();app.render();assert.equal(form().props.open,false,'头像入口关闭只收起原设置草稿')
 settingsMenu.props.onClick();app.render()
 assert.equal(form().props.open,true,'更多菜单仍可重开同一群设置')
 assert.equal(form().props.form.snapshot.group.id,groupId)
 assert.equal(form().props.form.snapshot.group.version,1,'两个入口复用同一编辑基线')
 latest={...latest,group:{...latest.group,version:2,announcement:'另一端保存的新公告',rules:{...latest.group.rules,mentionAllAllowed:false}}}
 assert.ok(poll)
 await poll();await app.flush()
 const baseline=form().props.form.snapshot as GroupSnapshot
 assert.equal(baseline.group.version,1,'轮询不得替换编辑基线')
 await form().props.save({name:'本次只改群名',announcement:baseline.group.announcement,rules:baseline.group.rules,memberRoleIds:[],pinned:baseline.group.pinned,archived:baseline.group.archived})
 await app.flush()
 assert.equal(submitted?.id,groupId)
 assert.equal(submitted?.expectedVersion,1,'必须提交打开表单时的版本，让服务端识别并发修改')
 assert.equal(latest.group.version,2)
 assert.equal(latest.group.announcement,'另一端保存的新公告','冲突不得覆盖他端公告')
 assert.equal(latest.group.rules.mentionAllAllowed,false,'冲突不得覆盖他端群规则')
 assert.match(form().props.error,/群设置版本已变化/)
 assert.equal(form().props.form.snapshot.group.version,1)
})
// 附加到 saved-collaboration-topic-draft.test.ts；复用该文件现有 mount / makeApi 等夹具。
// 这两条对修复前真实组件均已内存复现，下列断言写的是修复后期望。

test('跨群打开话题时旧群迟到读取不得覆盖当前话题',async()=>{
 let resolveOld!:(value:{items:GroupMessage[]})=>void
 const otherRoot='44444444-4444-4444-8444-444444444444'
 const second={...group,id:groupOther,name:'第二群'}
 const secondRoot={...rootMessage,id:otherRoot,groupId:groupOther,text:'第二群的话题'}
 const api=makeApi()
 api.get=async id=>({group:id===groupId?group:second,members:[]})
 api.messages=async(id,root)=>{
  if(id===groupId&&root)return await new Promise(resolve=>{resolveOld=resolve})
  return {items:[id===groupId?rootMessage:secondRoot]}
 }
 const app=mount({visible:true,api,target:{groupId,rootId},roles:[],profileName:'测试者'})
 await app.flush()
 app.setProps({target:{groupId:groupOther,rootId:otherRoot}})
 await app.flush()
 assert.equal(app.findAll(byAria('collaboration.composer.aria')).length,2)
 resolveOld({items:[rootMessage]})
 await app.flush()
 assert.equal(app.contentOf(app.find(el=>el.type==='h1')),'第二群')
 assert.equal(app.findAll(byAria('collaboration.composer.aria')).length,2,'旧群读取不得让新群话题编辑器消失')
 const panel=app.contentOf(app.find(byAria('collaboration.panel.topic')))
 assert.match(panel,/第二群的话题/)
 assert.doesNotMatch(panel,/请核对这批资料并保留来源/)
})

test('上传中移除附件后迟到上传回执不得生成隐藏引用',async()=>{
 let resolveUpload!:(value:{attachmentId:string;version:number;bytes:number})=>void
 const api=makeApi(),store=createSavedCollaborationDraftStore()
 const attachments={list:async()=>[],upload:()=>new Promise(resolve=>{resolveUpload=resolve})}
 const props={visible:true,api,attachments,target:{groupId,rootId:''},roles:[],profileName:'测试者'}
 const app=mount(props,{draftStore:store})
 await app.flush()
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[new File(['hello'],'取消上传.txt',{type:'text/plain'})],value:'x'}})
 await app.flush()
 app.find(byAria('collaboration.attachment.remove:'+JSON.stringify({name:'取消上传.txt'}))).props.onClick()
 await app.flush()
 resolveUpload({attachmentId:'55555555-5555-4555-8555-555555555555',version:1,bytes:5})
 await app.flush()
 const draft=store.readGroupDraftEntry(groupId)
 assert.deepEqual(draft.attachmentDrafts.main,[])
 assert.deepEqual(draft.referenceDrafts.main??[],[],'附件已移除，迟到回执不能再添不可见的待发送引用')
})

test('同群切到另一话题后旧发送回执不得按旧闭包刷新话题',async()=>{
 const api=makeApi(),store=createSavedCollaborationDraftStore()
 const secondRoot='44444444-4444-4444-8444-444444444444'
 const second={...rootMessage,id:secondRoot,text:'新话题正文'}
 let finishSend!:(message:GroupMessage)=>void
 api.messages=async(_id,root)=>({items:root===undefined?[rootMessage,second]:root===rootId?[rootMessage,replyMessage]:[second]})
 api.send=()=>new Promise(resolve=>{finishSend=resolve})
 const app=mount({visible:true,api,target:{groupId,rootId},roles:[],profileName:'测试者'},{draftStore:store})
 await app.flush()
 app.findAll(byAria('collaboration.composer.aria')).at(-1)!.props.onChange({target:{value:'旧话题回复'}})
 app.render()
 app.findAll(el=>el.type==='form').at(-1)!.props.onSubmit({preventDefault(){}})
 await app.flush()
 app.setProps({target:{groupId,rootId:secondRoot}})
 await app.flush()
 finishSend({...replyMessage,text:'旧话题回复'})
 await app.flush();await app.flush()
 const panel=app.contentOf(app.find(byAria('collaboration.panel.topic')))
 assert.match(panel,/新话题正文/)
 assert.doesNotMatch(panel,/请核对这批资料并保留来源/)
 assert.equal(app.findAll(byAria('collaboration.composer.aria')).length,2,'旧发送完成不得让当前话题编辑器消失')
})


const rawComponent=(tree:React.ReactNode,name:string):React.ReactElement<Record<string,any>>=>{
 const collect=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(collect)
  if(!React.isValidElement<Record<string,any>>(node))return []
  return typeof node.type==='function'&&node.type.name===name?[node]:collect(node.props.children)
 }
 const matches=collect(tree);assert.equal(matches.length,1);return matches[0]!
}
const savedTaskRecord={task:{id:'saved-group-task',ownerId:'self',groupId,title:'原群任务',state:'ready',version:1},source:{taskId:'saved-group-task',groupId,messageId:rootId,rootId}} as unknown as import('../src/client/group-api.js').GroupTaskRecord

test('群创建任务的迟到回执立即合并原Task，不随当前群切换改写归属',async()=>{
 const api=makeApi(),received:unknown[]=[],work={tasks:[],openTask:()=>{},openRole:()=>{},taskSaved:(task:unknown)=>received.push(task)}
 let resolveTask:((value:typeof savedTaskRecord)=>void)|undefined
 api.createTask=async()=>await new Promise(resolve=>{resolveTask=resolve})
 const app=mount({visible:true,api,work,target:{groupId,rootId:''},roles:[],profileName:'测试者'})
 await app.flush()
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.task.create').props.onClick()
 const form=rawComponent(app.render(),'SavedGroupTaskForm')
 form.props.create('仅登记来源')
 app.setProps({visible:false,target:null})
 resolveTask!(savedTaskRecord);await app.flush()
 assert.deepEqual(received,[savedTaskRecord.task])
 assert.equal((received[0] as any).groupId,groupId)
})

test('恢复群任务创建回执也合并原Task，不重复创建任务或触发运行',async()=>{
 const api=makeApi(),received:unknown[]=[]
 api.pending=()=>({kind:'task',request:{groupId}} as ReturnType<GroupApi['pending']>)
 let recovered=0
 api.recover=async()=>{recovered++;return savedTaskRecord}
 const work={tasks:[],openTask:()=>{},openRole:()=>{},taskSaved:(task:unknown)=>received.push(task)}
 const app=mount({visible:true,api,work,target:{groupId,rootId:''},roles:[],profileName:'测试者'})
 await app.flush()
 rawComponent(app.render(),'SavedComposer').props.recoverPending()
 await app.flush()
 assert.equal(recovered,1);assert.deepEqual(received,[savedTaskRecord.task])
})

test('话题输入框里选的资料只进该话题的引用草稿，主输入框与其他话题不带入',async()=>{
 const resourceId='77777777-7777-4777-8777-777777777777'
 const draftStore=createSavedCollaborationDraftStore()
 const api=makeApi([{id:resourceId,groupId,ownerId:'self',version:2,title:'方案资料',withdrawnAt:null,createdAt:stamp,updatedAt:stamp}])
 const directory:SavedConversationDirectory={refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}
 const app=mount({visible:true,api,directory,target:{groupId,rootId:''},roles:[],profileName:'测试者'},{draftStore})
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.reply.action').props.onClick()
 await app.flush()
 const topicComposer=app.findAll(byAria('collaboration.composer.aria')).at(-1)!
 topicComposer.props.onChange({target:{value:'@方',selectionStart:2}});app.render()
 const option=app.find(el=>el.type==='li'&&el.props.role==='option'&&String(el.props.id)==='resource-'+rootId+'-'+resourceId)
 option.props.onMouseDown({preventDefault:()=>{}});app.render()
 const entry=draftStore.readGroupDraftEntry(groupId)
 assert.deepEqual(entry.referenceDrafts[rootId],[{kind:'group-resource',id:resourceId,version:2}],'引用写入当前话题的草稿')
 assert.deepEqual(entry.referenceDrafts.main??[],[],'主输入框不带入话题里选的资料')
 const chips=app.findAll(el=>el.type==='span'&&el.props.className==='attachmentChip')
 assert.equal(chips.length,1,'只有话题输入框显示这枚标签')
 assert.equal(app.findAll(byAria('collaboration.composer.aria')).at(-1)!.props.value,'','话题正文里的 @过滤词被去掉')
 assert.equal(app.findAll(byAria('collaboration.composer.aria'))[0]!.props.value,'','主输入框正文不受影响')
 app.setProps({visible:false});app.setProps({target:{groupId,rootId},visible:true})
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='span'&&el.props.className==='attachmentChip').length,1,'返回来源话题后引用草稿仍在')
})
