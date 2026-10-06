import {applicationCapabilityModule} from './application-capability-fixture.ts'
import * as knowledgeMarkdown from '../src/client/knowledge-markdown-core.ts'
import {staffAvatarComponent} from './staff-avatar-component.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {contentOf,markdownPrimitivesStub,testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {Group,GroupMember,GroupMessage} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore,type SavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import type {PendingAttachment} from '../src/client/group-attachment-api.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {SavedConversationDirectory} from '../src/client/SavedCollaborationPage.js'

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
const snapshot:GroupSnapshot={group,members:[member]}
const rootMessage:GroupMessage={id:rootId,groupId,rootId:null,authorId:'self',text:'请核对这批资料并保留来源',references:[],mentions:[],createdAt:stamp}
const replyMessage:GroupMessage={id:replyId,groupId,rootId,authorId:'self',text:'形成可复核工作结论',references:[],mentions:[],createdAt:stamp}

function makeApi():GroupApi{
 return {
  get:async(id:string)=>{assert.equal(id,groupId);return snapshot},
  messages:async(id:string,forRoot?:string)=>{
   assert.equal(id,groupId)
   if(forRoot===undefined)return {items:[rootMessage]}
   if(forRoot===rootId)return {items:[rootMessage,replyMessage]}
   throw Error('未预期的话题根：'+forRoot)
  },
  resources:async()=>({items:[]}),
  agentGrant:async()=>({groupVersion:1,roleVersion:1,grant:null,status:'not-granted'}),
  list:async()=>({items:[group]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
 } as unknown as GroupApi
}

type Props={visible:boolean;api:GroupApi;directory?:SavedConversationDirectory;target:{groupId:string;rootId:string}|null;roles:unknown[];profileName:string}

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
  const capability=applicationCapabilityModule(id);if(capability!==undefined)return capability
  if(id==='react')return hooks
  if(id==='./StaffAvatar.js')return staffAvatarComponent
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
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t,time:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:options?.scheduleRefresh??(()=>()=>{})}
  // 群内直接回应一期 T14 接线后 SavedCollaborationPage 多了这两处依赖；本文件不测表情与折叠行，一律给空实现。
  if(id.endsWith('GroupReactionBar.js'))return {GroupReactionBar:()=>null,GroupEmojiPicker:()=>null}
  if(id.endsWith('group-routing-view.js'))return {groupRoutingPending:()=>[]}
  // DSH 平台模块，Node 下装不起来，给透传桩（见 saved-message-markdown-stubs.ts）。
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return markdownPrimitivesStub
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
  latest={...latest,group:{...latest.group,...fields,version:expectedVersion+1}}
  return latest
 }
 const app=mount({visible:true,api,target:{groupId,rootId:''},roles:[],profileName:'测试者'},
  {scheduleRefresh:run=>{poll=run;return()=>{}}})
 await app.flush()
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.settings.aria').props.onClick()
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
