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
import type {Group,GroupAgentGrant,GroupAttachment,GroupMember,GroupMention,GroupMessage,GroupReactionEmoji,MessageReference} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {groupMentionQuery} from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {GroupAttachmentApi} from '../src/client/group-attachment-api.js'
import type {SavedConversationDirectory} from '../src/client/SavedCollaborationPage.js'

/**
 * 群内直接回应与表情一期 功能验证（2026-09-21）：SavedComposer 的 Slack 式输入框——工具栏五件
 * （表情/@/回形针/引用资料/发送）、Enter 发送、Shift+Enter 换行、isComposing 与既有 @ 候选浮层
 * 分支不受影响、表情浮层打开时 Enter 归浮层。真实运行 SavedCollaborationPage.tsx 的组件函数与
 * useEffect（手法与 group-mention.test.ts 一致），不经过 jsdom。GroupEmojiPicker（T12 产物）
 * 用与其 props 签名一致的轻量替身，只验证 SavedComposer 自己这一段的接线，不重复 T12 自己的浮层单测。
 */

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

const stamp='2026-09-21T01:00:00.000Z'
const groupId='11111111-1111-4111-8111-111111111111'
const employeeAId='22222222-2222-4222-8222-222222222222'
const employeeDId='33333333-3333-4333-8333-333333333333'
const resourceId='44444444-4444-4444-8444-444444444444'

function role(id:string,name:string):PreviewRole{
 return {id,name,kind:'employee',scopes:['general'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
}
const employeeA=role(employeeAId,'员工甲')
const employeeD=role(employeeDId,'员工丁')
const roles:PreviewRole[]=[employeeA,employeeD]

function baseMembers():GroupMember[]{
 return [{groupId,roleId:null,createdAt:stamp},{groupId,roleId:employeeAId,createdAt:stamp},{groupId,roleId:employeeDId,createdAt:stamp}]
}

type ResourceRow={id:string;groupId:string;ownerId:string;version:number;title:string;withdrawnAt:string|null;createdAt:string;updatedAt:string}
type ApiSetup={archived?:boolean;resources?:ResourceRow[];mentionAllAllowed?:boolean}
function makeApi(setup:ApiSetup={}){
 const calls:{endpoint:string;payload:unknown}[]=[]
 const group:Group={id:groupId,ownerId:'self',version:1,name:'资料核对群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:!!setup.mentionAllAllowed},pinned:false,archived:!!setup.archived,createdAt:stamp,updatedAt:stamp}
 const members=baseMembers()
 const snapshot:GroupSnapshot={group,members}
 let counter=0
 const api={
  get:async(id:string)=>{assert.equal(id,groupId);return snapshot},
  messages:async(id:string,forRoot?:string)=>{assert.equal(id,groupId);if(forRoot!==undefined)throw Error('未预期读话题：'+forRoot);return {items:[]}},
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
 } as unknown as GroupApi
 return {api,calls}
}

/** 只用得到 upload 与 list；uploadHangs 真让待发附件卡死在 uploading，供「上传中不得发送」用；files 是群内已共享文件目录。 */
function makeAttachments(setup:{uploadHangs?:boolean;files?:GroupAttachment[]}={}){
 return {
  upload:async(_groupId:string,_expectedVersion:number,file:File,_requestId:string)=>{
   if(setup.uploadHangs)return new Promise<GroupAttachment>(()=>{})
   return {attachmentId:'att-1',ownerId:'self',version:1,kind:'file',mime:file.type,bytes:file.size,sha256:'a'.repeat(64),name:file.name,width:null,height:null,uploadedInGroupId:groupId,state:'active',createdAt:stamp,withdrawnAt:null} satisfies GroupAttachment
  },
  list:async()=>setup.files??[],
  withdraw:async()=>{throw Error('未使用')},
  openReference:async()=>{throw Error('未使用')},
  describeArtifact:async()=>{throw Error('未使用')},
  openArtifactFile:async()=>{throw Error('未使用')},
 } as unknown as GroupAttachmentApi
}
const file=(name:string,type:string,size=1024)=>({name,type,size,arrayBuffer:async()=>new ArrayBuffer(size)} as unknown as File)

type Props={visible:boolean;api:GroupApi;attachments?:GroupAttachmentApi|undefined;directory?:SavedConversationDirectory;target:{groupId:string;rootId:string}|null;roles:PreviewRole[];profileName:string}

/** 表情浮层的轻量替身：props 签名与 T12 的 GroupEmojiPicker 逐字一致，格子用 onMouseDown 照既有先例。 */
function fakeGroupEmojiPicker({onPick,onClose,labelKey}:{onPick:(emoji:GroupReactionEmoji)=>void;onClose:()=>void;labelKey:string}){
 return React.createElement('ul',{role:'listbox','aria-label':labelKey,onBlur:onClose},
  (contract.groupReactionEmojis as readonly GroupReactionEmoji[]).map(emoji=>React.createElement('li',{key:emoji,role:'option',onMouseDown:(event:{preventDefault:()=>void})=>{event.preventDefault();onPick(emoji)}},emoji)))
}

/** 执行真实组件函数与真实 effect 调度；手法与 group-mention.test.ts / group-attachment-view.test.ts 一致。 */
function mount(initial:Props){
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
  if(id==='./GroupChannelBindings.js')return {GroupChannelBindings:()=>null}
  const capability=applicationCapabilityModule(id);if(capability!==undefined)return capability
  if(id==='react')return hooks
  if(id==='./ContextDrawer.js')return {ContextDrawer:({open=true,children,title}:any)=>open?React.createElement('dialog',{'aria-label':title},children):null}
  if(id==='./task-preview.js')return {taskStates:{ready:'status.ready',running:'status.running',paused:'status.paused',waiting:'status.waiting',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'}}
  if(id==='./StaffAvatar.js'||id==='./EmployeeAvatar.js'||id==='./TwinAvatar.js')return staffAvatarComponent
  if(id==='./personal-profile.js')return personalProfileForGroup
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
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
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t,time:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:()=>()=>{}}
  if(id.endsWith('GroupReactionBar.js'))return {GroupReactionBar:()=>null,GroupEmojiPicker:fakeGroupEmojiPicker}
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
 const flush=async()=>{for(let round=0;round<8;round++){await new Promise(resolve=>setImmediate(resolve));render()}return tree}
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 return {
  render,flush,contentOf,
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
 }
}

type App=ReturnType<typeof mount>
const directory=():SavedConversationDirectory=>({refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}})
const textareaOf=(app:App)=>app.find(el=>el.type==='textarea'&&el.props['aria-label']==='collaboration.composer.aria')
const draftText=(app:App)=>String(textareaOf(app).props.value)
const typeText=(app:App,value:string)=>{textareaOf(app).props.onChange({target:{value,selectionStart:value.length}});app.render()}
const byLabel=(app:App,label:string)=>app.find(el=>el.type==='button'&&el.props['aria-label']===label)
type KeyOpts={shiftKey?:boolean;altKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;isComposing?:boolean}
const pressEnter=(app:App,opts:KeyOpts={})=>{
 textareaOf(app).props.onKeyDown({key:'Enter',shiftKey:!!opts.shiftKey,altKey:!!opts.altKey,ctrlKey:!!opts.ctrlKey,metaKey:!!opts.metaKey,preventDefault:()=>{},stopPropagation:()=>{},nativeEvent:{isComposing:!!opts.isComposing}})
 app.render()
}
const sentPayloads=(calls:{endpoint:string;payload:unknown}[])=>calls.filter(call=>call.endpoint==='groups/messages/send')

test('图片发送等待回执时显示忙碌状态，连续提交不会重复发送',async()=>{
 const {api,calls}=makeApi(),originalSend=api.send
 let finish!:()=>void
 const gate=new Promise<void>(resolve=>{finish=resolve})
 let attempts=0
 api.send=async(...args)=>{attempts++;await gate;return originalSend(...args)}
 const app=mount({visible:true,api,attachments:makeAttachments(),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'这是什么图片')
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('图片.png','image/png')],value:''}})
 await app.flush()
 const form=()=>app.find(el=>el.type==='form'&&String(el.props.className).includes('composer'))
 form().props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 assert.equal(form().props['aria-busy'],true)
 assert.equal(byLabel(app,'collaboration.composer.send').props.disabled,true)
 form().props.onSubmit({preventDefault:()=>{}})
 pressEnter(app)
 assert.equal(attempts,1)
 assert.equal(draftText(app),'这是什么图片')
 finish();await app.flush()
 assert.equal(sentPayloads(calls).length,1)
 assert.equal(draftText(app),'')
 assert.equal(app.findAll(el=>el.props.className==='attachmentChip').length,0)
})

test('图片发送失败时在输入框内显示原因和核对入口，恢复原请求后清理已发送草稿',async()=>{
 const {api}=makeApi(),originalSend=api.send
 let pending:ReturnType<GroupApi['pending']>,recoveries=0
 api.send=async(g,v,text,root,references)=>{
  pending={kind:'send',request:{requestId:resourceId,groupId:g,expectedVersion:v,text,...(root?{rootId:root}:{}),...(references?{references}:{})}}
  throw Error('连接中断，请核对发送结果')
 }
 api.pending=()=>pending
 api.recover=async()=>{recoveries++;const request=pending!.request as contract.GroupSendInput;const result=await originalSend(request.groupId,request.expectedVersion,request.text,request.rootId,request.references);pending=undefined;return result}
 const app=mount({visible:true,api,attachments:makeAttachments(),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'这是什么图片')
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('图片.png','image/png')],value:''}})
 await app.flush()
 const form=()=>app.find(el=>el.type==='form'&&String(el.props.className).includes('composer'))
 form().props.onSubmit({preventDefault:()=>{}});await app.flush()
 assert.match(app.contentOf(form()),/连接中断，请核对发送结果/)
 assert.match(app.contentOf(form()),/collaboration.action.recover/)
 assert.equal(draftText(app),'这是什么图片')
 assert.equal(byLabel(app,'collaboration.composer.send').props.disabled,true)
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.action.recover').props.onClick()
 await app.flush()
 assert.equal(recoveries,1)
 assert.equal(draftText(app),'')
 assert.equal(app.findAll(el=>el.props.className==='attachmentChip').length,0)
 assert.doesNotMatch(app.contentOf(form()),/连接中断/)
})

test('没有候选浮层时 Enter 发送',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'你好')
 pressEnter(app)
 await app.flush()
 assert.equal(sentPayloads(calls).length,1)
})

test('Shift+Enter 换行、不发送；Alt/Ctrl/Meta+Enter 也不发送',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'你好')
 for(const opts of [{shiftKey:true},{altKey:true},{ctrlKey:true},{metaKey:true}]){
  pressEnter(app,opts)
  await app.flush()
 }
 assert.equal(sentPayloads(calls).length,0)
})

test('中文输入法确认候选词的回车不发送',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'nihao')
 pressEnter(app,{isComposing:true})
 await app.flush()
 assert.equal(sentPayloads(calls).length,0)
})

test('@ 候选浮层打开时 Enter 选中候选、不发送（既有分支未被破坏）',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@员工')
 assert.ok(app.find(el=>el.type==='ul'&&el.props.role==='listbox'&&el.props['aria-label']==='group.mention.pick'))
 pressEnter(app)
 await app.flush()
 assert.equal(sentPayloads(calls).length,0)
 assert.equal(draftText(app),'@员工甲 ','既有「Enter 选中候选」分支必须一字不动地继续生效')
})

test('@全员之后 Enter 走 sendAll()：发出去并出现全员提示，不是普通发送',async()=>{
 const {api,calls}=makeApi({mentionAllAllowed:true})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 // 候选里只有「全员」这一项能命中这个前缀：t() 在测试里回的是键名本身。
 typeText(app,'@group')
 pressEnter(app)
 await app.flush()
 assert.equal(draftText(app),'@group.mention.allName ')
 pressEnter(app)
 await app.flush()
 assert.equal(sentPayloads(calls).length,1)
 assert.ok(app.find(el=>el.props.role==='status'&&app.contentOf(el)==='group.mention.allNotice'),'Enter 发出的那条必须落全员提示')
})

test('表情浮层打开时 Enter 归浮层、不发送',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'你好')
 byLabel(app,'collaboration.composer.emoji').props.onClick({currentTarget:{}})
 app.render()
 assert.ok(app.find(el=>el.type==='ul'&&el.props.role==='listbox'&&el.props['aria-label']==='collaboration.composer.emoji'))
 pressEnter(app)
 await app.flush()
 assert.equal(sentPayloads(calls).length,0)
})

test('正文为空、上传中、群归档三种情形下 Enter 都不发送（与发送按钮 disabled 条件逐字一致）',async()=>{
 const empty=makeApi()
 const emptyApp=mount({visible:true,api:empty.api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await emptyApp.flush()
 typeText(emptyApp,'   ')
 pressEnter(emptyApp)
 await emptyApp.flush()
 assert.equal(sentPayloads(empty.calls).length,0,'正文全是空白不得发送')

 const uploading=makeApi()
 const uploadingApp=mount({visible:true,api:uploading.api,attachments:makeAttachments({uploadHangs:true}),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await uploadingApp.flush()
 typeText(uploadingApp,'你好')
 uploadingApp.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('说明.md','text/markdown')],value:''}})
 uploadingApp.render()
 assert.ok(uploadingApp.find(el=>el.props.role==='status'&&uploadingApp.contentOf(el)==='collaboration.attachment.pending:{"count":1}'),'待发附件确实卡在 uploading')
 pressEnter(uploadingApp)
 await uploadingApp.flush()
 assert.equal(sentPayloads(uploading.calls).length,0,'附件上传中不得发送')

 const archived=makeApi({archived:true})
 const archivedApp=mount({visible:true,api:archived.api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await archivedApp.flush()
 pressEnter(archivedApp)
 await archivedApp.flush()
 assert.equal(sentPayloads(archived.calls).length,0,'群已归档不得发送')
})

test('工具栏五件齐全且各有 aria-label',async()=>{
 const {api}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'},)
 await app.flush()
 for(const label of ['collaboration.composer.emoji','collaboration.composer.mention','collaboration.composer.references','collaboration.composer.send'])assert.ok(byLabel(app,label))
})

test('工具栏含附件入口时同样各有 aria-label（回形针走既有 collaboration.attachment.add 词条）',async()=>{
 const {api}=makeApi()
 const app=mount({visible:true,api,attachments:makeAttachments(),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 for(const label of ['collaboration.composer.emoji','collaboration.composer.mention','collaboration.attachment.add','collaboration.composer.references','collaboration.composer.send'])assert.ok(byLabel(app,label))
})

test('点 @ 按钮在光标处插入 @ 并弹出候选浮层；前面已有空白时不再补空格',async()=>{
 const {api}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'你好')
 byLabel(app,'collaboration.composer.mention').props.onClick()
 app.render()
 assert.equal(draftText(app),'你好 @')
 assert.ok(app.find(el=>el.type==='ul'&&el.props.role==='listbox'&&el.props['aria-label']==='group.mention.pick'))
 typeText(app,'你好 ')
 byLabel(app,'collaboration.composer.mention').props.onClick()
 app.render()
 assert.equal(draftText(app),'你好 @')
})

test('插入表情写进正文，不产生表情回应请求',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 byLabel(app,'collaboration.composer.emoji').props.onClick({currentTarget:{}})
 app.render()
 const firstOption=app.find(el=>el.props.role==='option'&&app.contentOf(el)===contract.groupReactionEmojis[0])
 firstOption.props.onMouseDown({preventDefault:()=>{}})
 app.render()
 assert.equal(draftText(app),contract.groupReactionEmojis[0])
 assert.equal(calls.length,0,'插入表情只改正文，不发任何网络请求')
})

test('格式工具复用 Markdown 编辑，工具栏可收起，格式修改不发送消息',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.findAll(el=>el.props.role==='toolbar').length,0,'默认输入保持简洁，格式栏按需展开')
 byLabel(app,'knowledge.ui.073').props.onClick();app.render()
 assert.ok(app.find(el=>el.props.role==='toolbar'))
 byLabel(app,'knowledge.ui.060').props.onClick();app.render()
 assert.equal(draftText(app),'**knowledge.markdown.placeholder.text**')
 assert.equal(calls.length,0)
 byLabel(app,'knowledge.ui.073').props.onClick();app.render()
 assert.equal(app.findAll(el=>el.props.role==='toolbar').length,0)
 assert.equal(draftText(app),'**knowledge.markdown.placeholder.text**','收起格式工具不能丢草稿')
})

// 群引用资料改走会话式候选（2026-10-14）：引用图标打开输入框上方的资料候选，不再是带搜索框与切换按钮的确认浮层。
const resourceRow=(version=1):ResourceRow=>({id:resourceId,groupId,ownerId:'self',version,title:'资料标题',withdrawnAt:null,createdAt:stamp,updatedAt:stamp})
const listboxes=(app:App)=>app.findAll(el=>el.type==='ul'&&el.props.role==='listbox')
const resourceOptions=(app:App)=>app.findAll(el=>el.type==='li'&&el.props.role==='option'&&String(el.props.id).startsWith('resource-'))
const referenceChipOf=(app:App,title:string)=>app.findAll(el=>el.type==='span'&&el.props.className==='attachmentChip'&&app.contentOf(el).startsWith(title))
const pickOption=(app:App,option:React.ReactElement<Record<string,any>>)=>{option.props.onMouseDown({preventDefault:()=>{}});app.render()}

test('引用资料图标打开输入框上方的资料候选：选一次即带入标签、关闭候选并回到输入框，不再有确认表单',async()=>{
 const {api,calls}=makeApi({resources:[resourceRow(3)]})
 const app=mount({visible:true,api,attachments:makeAttachments(),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 assert.equal(listboxes(app).length,0,'默认收起')
 assert.equal(byLabel(app,'collaboration.composer.references').props['aria-expanded'],false)
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 assert.equal(app.findAll(el=>el.props.role==='dialog').length,0,'不再弹确认浮层')
 assert.equal(app.findAll(el=>el.type==='input'&&el.props['aria-label']==='homeResource.search').length,0,'不再有浮层内搜索框')
 assert.equal(app.findAll(el=>el.type==='button'&&'aria-pressed' in el.props&&String(el.props.title??'').includes('资料标题')).length,0,'不再有切换式引用按钮')
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(listbox.props['aria-label'],'collaboration.composer.references')
 assert.equal(byLabel(app,'collaboration.composer.references').props['aria-expanded'],true)
 const [option]=resourceOptions(app)
 assert.ok(option&&app.contentOf(option).startsWith('资料标题'))
 assert.ok(app.contentOf(option!).includes('collaboration.resources.versionLabel:{"version":3}'),'候选标明固定版本')
 assert.equal(option!.props['aria-disabled'],false)
 assert.equal(textareaOf(app).props['aria-activedescendant'],option!.props.id,'候选打开即由输入框键盘驱动')
 pickOption(app,option!)
 assert.equal(listboxes(app).length,0,'选一次就关闭候选')
 assert.equal(byLabel(app,'collaboration.composer.references').props['aria-expanded'],false)
 assert.equal(referenceChipOf(app,'资料标题').length,1,'选中后标签常驻在待发送区')
 assert.equal(sentPayloads(calls).length,0,'选资料不发送')
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 assert.equal(resourceOptions(app)[0]!.props['aria-disabled'],true,'已引用项禁用，不能从候选撤销')
 pressEnter(app)
 assert.equal(referenceChipOf(app,'资料标题').length,1,'对禁用项回车不撤销')
 assert.equal(sentPayloads(calls).length,0,'候选打开时回车不发送')
 textareaOf(app).props.onKeyDown({key:'Escape',preventDefault:()=>{},stopPropagation:()=>{}});app.render()
 assert.equal(listboxes(app).length,0,'Esc 收起候选')
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.attachment.remove:{"name":"资料标题"}').props.onClick();app.render()
 assert.equal(referenceChipOf(app,'资料标题').length,0,'移除走标签')
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 pickOption(app,resourceOptions(app)[0]!)
 typeText(app,'请核对这份资料。')
 pressEnter(app)
 await app.flush()
 assert.deepEqual((sentPayloads(calls)[0]!.payload as {references?:unknown}).references,[{kind:'group-resource',id:resourceId,version:3}],'发送带 id 与固定版本')
})

test('候选同时列出本群已共享的文件：点选复用原 attachment 引用而不重新上传；别群带入与已撤回的不列；刚上传完成的待发附件不重复出现且候选里视为已引用',async()=>{
 const sharedFile=(attachmentId:string,name:string,patch:Partial<GroupAttachment>={}):GroupAttachment=>({attachmentId,ownerId:'self',version:1,kind:'file',mime:'application/pdf',bytes:2048,sha256:'b'.repeat(64),name,width:null,height:null,uploadedInGroupId:groupId,state:'active',createdAt:stamp,withdrawnAt:null,...patch})
 const files=[sharedFile('att-shared','合同扫描件.pdf'),sharedFile('att-foreign','别群带入.pdf',{uploadedInGroupId:'55555555-5555-4555-8555-555555555555'}),sharedFile('att-gone','已撤回.pdf',{state:'withdrawn',withdrawnAt:stamp}),sharedFile('att-1','回形针.png',{kind:'image',mime:'image/png'})]
 const uploads:string[]=[]
 const attachments=makeAttachments({files})
 const originalUpload=attachments.upload
 ;(attachments as unknown as {upload:typeof originalUpload}).upload=async(...args:Parameters<typeof originalUpload>)=>{uploads.push(args[2].name);return originalUpload(...args)}
 const {api,calls}=makeApi({resources:[resourceRow()]})
 const app=mount({visible:true,api,attachments,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 const sections=app.findAll(el=>el.type==='li'&&el.props.role==='presentation').map(el=>app.contentOf(el))
 assert.deepEqual(sections,['group.mention.sectionResources','group.mention.sectionFiles'],'资料与文件分组列出')
 const fileOptions=()=>app.findAll(el=>el.type==='li'&&el.props.role==='option'&&String(el.props.id).startsWith('file-'))
 assert.deepEqual(fileOptions().map(el=>app.contentOf(el)),['合同扫描件.pdf','回形针.png'],'只列本群上传且仍有效的文件')
 pickOption(app,fileOptions()[0]!)
 assert.equal(listboxes(app).length,0)
 assert.equal(referenceChipOf(app,'合同扫描件.pdf').length,1,'已共享文件以原件名称出标签')
 assert.deepEqual(uploads,[],'点选已共享文件不重新上传')
 assert.equal(app.findAll(el=>el.props.role==='status'&&String(app.contentOf(el)).startsWith('collaboration.attachment.pending')).length,0,'不进入待发送上传区')
 // 新上传仍走原回形针入口；上传完成后同一原件在候选里视为已引用，标签只出现一次。
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('回形针.png','image/png')],value:''}})
 app.render();await app.flush()
 assert.deepEqual(uploads,['回形针.png'])
 assert.equal(app.findAll(el=>el.type==='span'&&el.props.className==='attachmentChip'&&app.contentOf(el).startsWith('回形针.png')).length,1,'刚上传的附件只有待发送行一枚标签')
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 assert.deepEqual(fileOptions().map(el=>[app.contentOf(el).startsWith('回形针.png')||app.contentOf(el).startsWith('合同扫描件.pdf'),el.props['aria-disabled']]),[[true,true],[true,true]],'已引用的两份原件都禁用')
 textareaOf(app).props.onKeyDown({key:'Escape',preventDefault:()=>{},stopPropagation:()=>{}});app.render()
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.attachment.remove:{"name":"合同扫描件.pdf"}').props.onClick();app.render()
 assert.equal(referenceChipOf(app,'合同扫描件.pdf').length,0,'已共享文件的引用移除走标签')
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 pickOption(app,fileOptions()[0]!)
 typeText(app,'请看合同与截图。')
 pressEnter(app);await app.flush()
 assert.deepEqual((sentPayloads(calls)[0]!.payload as {references?:unknown}).references,[{kind:'attachment',id:'att-1',version:1},{kind:'attachment',id:'att-shared',version:1}],'发送复用原 attachment id 与固定版本')
})

test('本群没有资料也没有文件时，图标打开的空态候选 Esc 能关闭、回车不发送；关闭后回车才发送',async()=>{
 const {api,calls}=makeApi()
 const app=mount({visible:true,api,attachments:makeAttachments(),directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'先写好正文')
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 assert.equal(listboxes(app).length,1,'空态也以同一候选呈现')
 assert.ok(app.find(el=>el.type==='li'&&el.props.role==='presentation'&&app.contentOf(el)==='collaboration.attachment.sectionEmpty'))
 pressEnter(app)
 assert.equal(sentPayloads(calls).length,0,'候选开着（即使为空）回车不发送')
 textareaOf(app).props.onKeyDown({key:'Escape',preventDefault:()=>{},stopPropagation:()=>{}});app.render()
 assert.equal(listboxes(app).length,0,'空态候选 Esc 必须能关')
 assert.equal(byLabel(app,'collaboration.composer.references').props['aria-expanded'],false)
 pressEnter(app);await app.flush()
 assert.equal(sentPayloads(calls).length,1,'关闭后回车恢复发送')
})

test('资料撤回后仍保留固定引用标签并可移除，不留下不可见的待发引用',async()=>{
 const resource=resourceRow(3),{api,calls}=makeApi({resources:[resource]})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 pickOption(app,resourceOptions(app)[0]!)
 resource.withdrawnAt=stamp
 typeText(app,'待发送的草稿')
 assert.equal(referenceChipOf(app,'group.mention.sectionResources').length,1,'名称不可读时仍显示类型标签')
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.attachment.remove:{"name":"group.mention.sectionResources"}').props.onClick();app.render()
 assert.equal(referenceChipOf(app,'group.mention.sectionResources').length,0)
 assert.equal(draftText(app),'待发送的草稿')
 assert.equal(sentPayloads(calls).length,0)
 pressEnter(app)
 await app.flush()
 assert.deepEqual((sentPayloads(calls)[0]!.payload as {references?:unknown}).references,[],'移除后真实发送不含不可读引用')
})

test('没有附件接口时，已选引用的标签仍可见、可移除',async()=>{
 const {api}=makeApi({resources:[resourceRow()]})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 byLabel(app,'collaboration.composer.references').props.onClick();app.render()
 pickOption(app,resourceOptions(app)[0]!)
 assert.equal(referenceChipOf(app,'资料标题').length,1)
 app.find(el=>el.type==='button'&&el.props['aria-label']==='collaboration.attachment.remove:{"name":"资料标题"}').props.onClick();app.render()
 assert.equal(referenceChipOf(app,'资料标题').length,0)
})

test('正文 @ 列出资料时，中文输入法确认候选词的回车既不选资料也不发送；普通回车选中资料且不发送',async()=>{
 const {api,calls}=makeApi({resources:[resourceRow()]})
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 typeText(app,'@资')
 assert.equal(resourceOptions(app).length,1)
 pressEnter(app,{isComposing:true})
 assert.equal(referenceChipOf(app,'资料标题').length,0,'输入法确认不算选中')
 assert.equal(resourceOptions(app).length,1,'输入法确认不关闭候选')
 assert.equal(sentPayloads(calls).length,0)
 pressEnter(app)
 assert.equal(referenceChipOf(app,'资料标题').length,1)
 assert.equal(draftText(app),'','选中后去掉 @过滤词')
 assert.equal(sentPayloads(calls).length,0,'选资料的回车不是发送')
})

test('拖放与粘贴三条入口仍进同一个 pick（既有行为未被破坏）',async()=>{
 const {api}=makeApi()
 const attachmentCalls:string[]=[]
 const attachments=makeAttachments()
 const original=attachments.upload
 ;(attachments as unknown as {upload:typeof original}).upload=async(...args:Parameters<typeof original>)=>{attachmentCalls.push(args[2].name);return original(...args)}
 const app=mount({visible:true,api,attachments,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 const form=app.find(el=>el.type==='form'&&el.props.className==='composer')
 form.props.onDrop({preventDefault:()=>{},dataTransfer:{files:[file('拖放.png','image/png')]}})
 app.render()
 form.props.onPaste({preventDefault:()=>{},clipboardData:{files:[file('粘贴.png','image/png')]}})
 app.render()
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('回形针.png','image/png')],value:''}})
 app.render()
 await app.flush()
 assert.deepEqual(attachmentCalls,['拖放.png','粘贴.png','回形针.png'])
})

test('回车提示只在聚焦且正文非空时出现，且是 role=status',async()=>{
 const {api}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target:{groupId,rootId:''},roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.findAll(el=>el.props.role==='status'&&app.contentOf(el)==='collaboration.composer.enterHint').length,0,'没聚焦时不出现')
 textareaOf(app).props.onFocus()
 app.render()
 assert.equal(app.findAll(el=>el.props.role==='status'&&app.contentOf(el)==='collaboration.composer.enterHint').length,0,'聚焦但正文为空时不出现')
 typeText(app,'x')
 assert.ok(app.find(el=>el.props.role==='status'&&app.contentOf(el)==='collaboration.composer.enterHint'))
})
