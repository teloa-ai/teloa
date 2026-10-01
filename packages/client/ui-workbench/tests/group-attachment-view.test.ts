import * as knowledgeMarkdown from '../src/client/knowledge-markdown-core.ts'
import {staffAvatarComponent} from './staff-avatar-component.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {contentOf,markdownPrimitivesStub,testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {Group,GroupAgentGrant,GroupAttachment,GroupMember,GroupMention,GroupMessage,MessageReference} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import {GROUP_ATTACHMENT_MESSAGE_ROWS} from '../src/client/i18n/locales/group-attachment.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {GroupAttachmentApi,OpenedAttachment} from '../src/client/group-attachment-api.js'
import type {SavedConversationDirectory} from '../src/client/SavedCollaborationPage.js'

/**
 * 群附件一期 功能验证（2026-09-21）：输入区三条上传入口、消息里三类引用气泡、侧栏「资料与文件」两分节、
 * 按 kind 分三组的数字员工授权面。真实运行 SavedCollaborationPage.tsx 的组件函数与 useEffect
 * （手法与 group-mention.test.ts 一致），不经过 jsdom。
 */

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

/** 本次进程里创建与释放的 blob 地址计数：「卸载即 revoke」这条靠它对账。 */
let blobCount=0,revokedUrls:string[]=[]
Reflect.set(URL,'createObjectURL',()=>{blobCount+=1;return 'blob:teloa/'+blobCount})
Reflect.set(URL,'revokeObjectURL',(value:string)=>{revokedUrls.push(value)})

const stamp='2026-09-21T01:00:00.000Z'
const groupId='11111111-1111-4111-8111-111111111111'
const employeeAId='22222222-2222-4222-8222-222222222222'
const imageId='33333333-3333-4333-8333-333333333333'
const docId='44444444-4444-4444-8444-444444444444'
const goneId='55555555-5555-4555-8555-555555555555'
const artifactId='66666666-6666-4666-8666-666666666666'
const resourceId='77777777-7777-4777-8777-777777777777'
const otherGroupId='88888888-8888-4888-8888-888888888888'
const otherImageId='99999999-9999-4999-8999-999999999999'

/** 词条按 zh-CN 逐字取用，撤回确认这类「逐字」断言要的就是真译文而不是键名。 */
const attachmentText=new Map<string,string>(GROUP_ATTACHMENT_MESSAGE_ROWS.map(row=>[row[0],row[1]] as [string,string]))
const t=(key:string,params?:Record<string,string|number>)=>{
 const text=attachmentText.get(key)
 if(text===undefined)return params?key+':'+JSON.stringify(params):key
 return text.replace(/\{(\w+)\}/g,(whole,name:string)=>params&&name in params?String(params[name]):whole)
}

function role(id:string,name:string):PreviewRole{
 return {id,name,kind:'employee',scopes:['general'],state:'active',version:1,duty:'资料核对',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]}
}
const employeeA=role(employeeAId,'员工甲')
const roles:PreviewRole[]=[employeeA]
const group:Group={id:groupId,ownerId:'self',version:3,name:'资料核对群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:stamp,updatedAt:stamp}
const members:GroupMember[]=[{groupId,roleId:null,createdAt:stamp},{groupId,roleId:employeeAId,createdAt:stamp}]

const attachment=(over:Partial<GroupAttachment>):GroupAttachment=>({attachmentId:imageId,ownerId:'self',version:1,kind:'image',mime:'image/png',bytes:2048,sha256:'a'.repeat(64),name:'图.png',width:40,height:20,uploadedInGroupId:groupId,state:'active',createdAt:stamp,withdrawnAt:null,...over})
const selfMessage=(id:string,text:string,references:MessageReference[]):GroupMessage=>({id,groupId,rootId:null,authorId:'self',text,references,mentions:[],createdAt:stamp})
const employeeMessage=(id:string,references:MessageReference[]):GroupMessage=>({id,groupId,rootId:null,authorId:employeeAId,runId:'run-1',text:'已完成核对。',references,createdAt:stamp} as unknown as GroupMessage)

type ApiSetup={messages?:GroupMessage[];resources?:{id:string;groupId:string;version:number;title:string;withdrawnAt:string|null;createdAt:string;updatedAt:string}[];grantResources?:MessageReference[]}
function makeApi(setup:ApiSetup={}){
 const calls:{endpoint:string;payload:unknown}[]=[]
 const snapshot:GroupSnapshot={group,members}
 const api={
  get:async()=>snapshot,
  messages:async(_id:string,forRoot?:string)=>({items:forRoot?[]:setup.messages??[]}),
  resources:async()=>({items:setup.resources??[]}),
  agentGrant:async(_groupId:string,roleId:string)=>({groupVersion:3,roleVersion:1,grant:{groupId,roleId,groupVersion:3,roleVersion:1,grantVersion:1,state:'active' as const,resources:setup.grantResources??[],canPost:true,canAutoRun:false,createdAt:stamp} satisfies GroupAgentGrant,status:'active' as const}),
  list:async()=>({items:[group]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
  send:async(_groupId:string,_expectedVersion:number,text:string,rootId?:string,references?:MessageReference[],mentions?:GroupMention[])=>{
   calls.push({endpoint:'groups/messages/send',payload:{text,rootId,references,mentions}})
   return selfMessage('sent-1',text,references??[])
  },
  changeAgentGrant:async(_groupId:string,roleId:string,_groupVersion:number,_roleVersion:number,action:'save'|'revoke',resources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>{
   calls.push({endpoint:'groups/agent-grants/change',payload:{roleId,action,resources,canPost,canAutoRun}})
   return {groupId,roleId,groupVersion:3,roleVersion:1,grantVersion:2,state:action==='save'?'active' as const:'revoked' as const,resources,canPost,canAutoRun,createdAt:stamp}
  },
 } as unknown as GroupApi
 return {api,calls}
}

/** 切群那条断言要两个真群：api.get/messages 都按 id 分流，别的测试继续用单群的 makeApi。 */
function makeTwoGroupApi(){
 const second:Group={...group,id:otherGroupId,name:'另一个群'}
 const snapshots:Record<string,GroupSnapshot>={
  [groupId]:{group,members},
  [otherGroupId]:{group:second,members:[{groupId:otherGroupId,roleId:null,createdAt:stamp},{groupId:otherGroupId,roleId:employeeAId,createdAt:stamp}]},
 }
 const byGroup:Record<string,GroupMessage[]>={
  [groupId]:[selfMessage('g1','两份',[{kind:'attachment',id:imageId,version:1},{kind:'attachment',id:docId,version:1}])],
  [otherGroupId]:[{...selfMessage('g2','一份',[{kind:'attachment',id:otherImageId,version:1}]),groupId:otherGroupId}],
 }
 const api={
  get:async(id:string)=>snapshots[id]!,
  messages:async(id:string,forRoot?:string)=>({items:forRoot?[]:byGroup[id]??[]}),
  resources:async()=>({items:[]}),
  agentGrant:async(_groupId:string,roleId:string)=>({groupVersion:3,roleVersion:1,grant:{groupId,roleId,groupVersion:3,roleVersion:1,grantVersion:1,state:'active' as const,resources:[],canPost:true,canAutoRun:false,createdAt:stamp} satisfies GroupAgentGrant,status:'active' as const}),
  list:async()=>({items:[group,second]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
 } as unknown as GroupApi
 return {api}
}

type OpenedRow={mime:string;name:string}|'fail'
type AttachmentSetup={files?:GroupAttachment[];opened?:Record<string,OpenedRow>;uploadFails?:boolean;uploadHangs?:boolean;artifactFiles?:Record<string,{title:string;snapshotIds:string[]}>;artifactFileBytes?:Record<string,OpenedRow>}
function makeAttachments(setup:AttachmentSetup={}){
 const calls:{endpoint:string;payload:unknown}[]=[]
 let uploadFails=!!setup.uploadFails
 const api:GroupAttachmentApi={
  upload:async(uploadGroupId:string,expectedVersion:number,file:File,requestId:string)=>{
   calls.push({endpoint:'groups/attachments/upload',payload:{groupId:uploadGroupId,expectedVersion,mime:file.type,name:file.name,requestId}})
   if(setup.uploadHangs)return new Promise<GroupAttachment>(()=>{})
   if(uploadFails)throw Error('上传失败。')
   return attachment({attachmentId:docId,kind:'file',mime:file.type,name:file.name,bytes:file.size,width:null,height:null})
  },
  list:async()=>setup.files??[],
  withdraw:async(attachmentId:string,requestId:string)=>{
   calls.push({endpoint:'groups/attachments/withdraw',payload:{attachmentId,requestId}})
   return attachment({attachmentId,state:'withdrawn',withdrawnAt:stamp})
  },
  openReference:async(reference:MessageReference,forGroupId?:string)=>{
   calls.push({endpoint:'openReference',payload:{kind:reference.kind,id:reference.id,version:reference.version,groupId:forGroupId}})
   const row=setup.opened?.[reference.id]
   if(!row||row==='fail')throw Error('引用不可用。')
   const blobUrl=URL.createObjectURL(new Blob([]))
   return {blobUrl,revoke:()=>URL.revokeObjectURL(blobUrl),name:row.name,mime:row.mime} satisfies OpenedAttachment
  },
  // 每个成果固定只关联一个虚构 snapshotId（reference.id+':snap'），够测单文件成果卡沿用旧「无需点开即可见」体验；
  // 多文件场景在专门的测试里另建 setup.artifactFiles 自定义文件清单。
  describeArtifact:async(reference:{kind:'artifact';id:string;version:number})=>{
   calls.push({endpoint:'describeArtifact',payload:{id:reference.id,version:reference.version}})
   const files=setup.artifactFiles?.[reference.id]
   if(files)return {title:files.title,version:reference.version,files:files.snapshotIds.map(snapshotId=>({snapshotId}))}
   const row=setup.opened?.[reference.id]
   if(!row||row==='fail')throw Error('成果不可用。')
   return {title:row.name,version:reference.version,files:[{snapshotId:reference.id+':snap'}]}
  },
  openArtifactFile:async(reference:{kind:'artifact';id:string;version:number},snapshotId:string)=>{
   calls.push({endpoint:'openArtifactFile',payload:{id:reference.id,version:reference.version,snapshotId}})
   const row=setup.artifactFileBytes?.[snapshotId]??setup.opened?.[reference.id]
   if(!row||row==='fail')throw Error('成果文件不可用。')
   const blobUrl=URL.createObjectURL(new Blob([]))
   return {blobUrl,revoke:()=>URL.revokeObjectURL(blobUrl),name:row.name,mime:row.mime} satisfies OpenedAttachment
  },
 } as unknown as GroupAttachmentApi
 return {attachments:api,calls,failUploads:(value:boolean)=>{uploadFails=value}}
}

type Props={visible:boolean;api:GroupApi;attachments?:GroupAttachmentApi;openArtifact?:(artifactId:string)=>void;directory?:SavedConversationDirectory;target:{groupId:string;rootId:string}|null;roles:PreviewRole[];profileName:string}

/** 执行真实组件函数与真实 effect 调度；只有顶层组件手动调用，嵌套子组件在展开时按普通函数调用。 */
function mount(initial:Props,stubs:{openDialog?:(node:unknown,focus:unknown)=>void;returnPanelFocus?:(opener:unknown)=>void;drafts?:ReturnType<typeof createSavedCollaborationDraftStore>}={}){
 let props=initial
 const slots:unknown[]=[]
 let cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 const effects=new Map<number,Effect>()
 let pending:Array<()=>void>=[]
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
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='./StaffAvatar.js')return staffAvatarComponent
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('knowledge-markdown-core.js'))return knowledgeMarkdown
  if(id.endsWith('ComposerPopover.js'))return {ComposerPopover:({children,label}:{children:React.ReactNode;label:string})=>React.createElement('div',{role:'dialog','aria-label':label},children)}
  if(id.endsWith('dialog-focus.js'))return {openDialog:(node:unknown,focus:unknown)=>{stubs.openDialog?.(node,focus);return ()=>{}}}
  if(id.endsWith('directory-focus.js'))return {closeDirectoryDetailOnEscape:()=>{}}
  if(id.endsWith('panel-focus.js'))return {returnPanelFocus:(opener:unknown)=>{stubs.returnPanelFocus?.(opener)}}
  if(id.endsWith('business-scope-context.js'))return {useBusinessScopes:()=>({general:'通用'})}
  if(id.endsWith('saved-collaboration-state.js'))return savedCollaborationState
  if(id.endsWith('saved-collaboration-drafts.js'))return {savedCollaborationDrafts:stubs.drafts??createSavedCollaborationDraftStore()}
  if(id.endsWith('team-presentation.js'))return {twinDisplayName:(name:string)=>name}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t,time:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:()=>()=>{}}
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
   assert.ok(guard++<30,'组件不应无限重渲染')
   dirty=false;cursor=0;pending=[]
   tree=Component(props)
   for(const run of pending)run()
  }while(dirty)
  return tree
 }
 const flush=async()=>{for(let round=0;round<16;round++){await Promise.resolve();render()}return tree}
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 return {
  render,flush,contentOf,
  all:()=>expand(render()),
  setProps:(patch:Partial<Props>)=>{props={...props,...patch};render()},
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
  unmount:()=>{for(const effect of effects.values())effect.cleanup?.();effects.clear()},
 }
}

type App=ReturnType<typeof mount>
const directory=():SavedConversationDirectory=>({refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}})
const target={groupId,rootId:''}
const file=(name:string,type:string,size=1024)=>({name,type,size,arrayBuffer:async()=>new ArrayBuffer(size)} as unknown as File)
const byAria=(app:App,label:string)=>(el:React.ReactElement<Record<string,any>>)=>el.props['aria-label']===label
const composer=(app:App)=>app.find(el=>el.type==='form'&&String(el.props.className).startsWith('composer'))
const sendButton=(app:App)=>app.find(el=>el.type==='button'&&el.props.type==='submit'&&el.props['aria-label']==='collaboration.composer.send')
const textareaOf=(app:App)=>app.find(el=>el.type==='textarea'&&el.props['aria-label']==='collaboration.composer.aria')
const openInfoPanel=(app:App)=>{app.find(byAria(app,'collaboration.action.resources')).props.onClick();app.render()}

test('回形针按钮的 aria-label 走词条，拖放与粘贴各触发一次同样的上传',async()=>{
 const {api}=makeApi()
 const {attachments,calls}=makeAttachments()
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.find(byAria(app,t('collaboration.attachment.add'))).type,'button','附件按钮必须是按钮且带词条 aria-label')
 const input=app.find(el=>el.type==='input'&&el.props.type==='file')
 input.props.onChange({target:{files:[file('图.png','image/png')],value:'x'}})
 await app.flush()
 composer(app).props.onDragEnter({preventDefault:()=>{}})
 composer(app).props.onDrop({preventDefault:()=>{},dataTransfer:{files:[file('说明.md','text/markdown')]}})
 await app.flush()
 composer(app).props.onPaste({preventDefault:()=>{},clipboardData:{files:[file('贴图.png','image/png')]}})
 await app.flush()
 const uploads=calls.filter(call=>call.endpoint==='groups/attachments/upload')
 assert.deepEqual(uploads.map(call=>(call.payload as {name:string}).name),['图.png','说明.md','贴图.png'],'三条入口各触发一次上传')
 assert.deepEqual(Object.keys(uploads[0]!.payload as object).sort(),['expectedVersion','groupId','mime','name','requestId'],'只提交契约白名单字段')
 assert.equal((uploads[0]!.payload as {expectedVersion:number}).expectedVersion,3,'上传带当前群版本')
})

test('拖放高亮与提示只在拖进来时出现',async()=>{
 const {api}=makeApi()
 const {attachments}=makeAttachments()
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.dropHint')).length,0)
 composer(app).props.onDragEnter({preventDefault:()=>{}})
 app.render()
 assert.ok(String(composer(app).props.className).includes('composerDropping'),'拖进来时 composer 要带高亮类')
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.dropHint')).length>0)
 // 拖过子元素时浏览器会连发 dragenter/dragleave；进入计数没归零之前高亮与提示都不许抖。
 composer(app).props.onDragEnter({preventDefault:()=>{}})
 composer(app).props.onDragLeave()
 app.render()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.dropHint')).length>0,'进入计数未归零时提示不该消失')
 composer(app).props.onDragLeave()
 app.render()
 assert.equal(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.dropHint')).length,0)
})

test('没接附件面时拖放监听仍在，并恒定挡住浏览器自己打开文件',async()=>{
 const {api}=makeApi()
 const app=mount({visible:true,api,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='input'&&el.props.type==='file').length,0,'没接附件面时不出现文件选择器')
 let preventedOver=0,preventedDrop=0
 composer(app).props.onDragOver({preventDefault:()=>{preventedOver+=1}})
 composer(app).props.onDrop({preventDefault:()=>{preventedDrop+=1},dataTransfer:{files:[file('说明.md','text/markdown')]}})
 app.render()
 assert.equal(preventedOver,1,'dragover 恒定 preventDefault')
 assert.equal(preventedDrop,1,'drop 恒定 preventDefault，文件拖进来也不该让浏览器导航走')
 assert.equal(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.dropHint')).length,0,'没接附件面时不给拖放提示')
})

test('上传中禁用发送按钮，失败行给 role=alert 并用同一个 requestId 重试',async()=>{
 const {api}=makeApi()
 const {attachments,calls,failUploads}=makeAttachments({uploadFails:true})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 textareaOf(app).props.onChange({target:{value:'看这个'}})
 app.render()
 assert.equal(sendButton(app).props.disabled,false)
 app.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('说明.md','text/markdown')],value:''}})
 assert.equal(sendButton(app).props.disabled,true,'上传未完成时不许发送')
 await app.flush()
 const failed=app.find(el=>el.props.role==='alert'&&app.contentOf(el).includes('说明.md'))
 assert.ok(app.contentOf(failed).includes(t('collaboration.attachment.retry')),'失败行要给重试入口')
 failUploads(false)
 app.find(el=>el.type==='button'&&app.contentOf(el)===t('collaboration.attachment.retry')).props.onClick()
 await app.flush()
 const uploads=calls.filter(call=>call.endpoint==='groups/attachments/upload')
 assert.equal(uploads.length,2,'重试是第二次上传')
 assert.equal((uploads[0]!.payload as {requestId:string}).requestId,(uploads[1]!.payload as {requestId:string}).requestId,'重试必须原样重用同一个 requestId')
 assert.equal(sendButton(app).props.disabled,false,'重试成功后恢复可发送')
})

test('超限、类型不符与扩展名不符各给对应词条，且不发起上传',async()=>{
 const {api}=makeApi()
 const {attachments,calls}=makeAttachments()
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 const input=()=>app.find(el=>el.type==='input'&&el.props.type==='file')
 input().props.onChange({target:{files:[file('大图.png','image/png',9*1024*1024)],value:''}})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.imageTooLarge')).length>0,'9 MiB 图片提示图片档上限')
 input().props.onChange({target:{files:[file('大文件.pdf','application/pdf',17*1024*1024)],value:''}})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.fileTooLarge')).length>0,'17 MiB PDF 提示文件档上限')
 input().props.onChange({target:{files:[file('动图.gif','image/gif',contract.groupAttachmentFileMaxBytes+1)],value:''}})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.fileTooLarge')).length>0,'GIF 走文件档')
 input().props.onChange({target:{files:[file('脚本.svg','image/svg+xml')],value:''}})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.unsupported')).length>0)
 input().props.onChange({target:{files:[file('图.jpg','image/png')],value:''}})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.nameMismatch')).length>0)
 assert.equal(calls.filter(call=>call.endpoint==='groups/attachments/upload').length,0,'一条都不该上网')
})

test('单件上限按类型：9 MiB PDF 与恰好文件档上限的 PDF、恰好图片档上限的 PNG 照常上传',async()=>{
 const {api}=makeApi()
 const {attachments,calls}=makeAttachments()
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 const input=()=>app.find(el=>el.type==='input'&&el.props.type==='file')
 input().props.onChange({target:{files:[file('报告.pdf','application/pdf',9*1024*1024),file('满额.pdf','application/pdf',contract.groupAttachmentFileMaxBytes),file('满额.png','image/png',contract.groupAttachmentImageMaxBytes)],value:''}})
 await app.flush()
 assert.deepEqual(calls.filter(call=>call.endpoint==='groups/attachments/upload').map(call=>(call.payload as {name:string}).name),['报告.pdf','满额.pdf','满额.png'])
 for(const key of ['collaboration.attachment.imageTooLarge','collaboration.attachment.fileTooLarge'])assert.equal(app.findAll(el=>app.contentOf(el)===t(key)).length,0,key)
})

test('超限词条两行：数字与契约上限一致，十语齐全',()=>{
 const rows=new Map<string,readonly string[]>(GROUP_ATTACHMENT_MESSAGE_ROWS.map(row=>[row[0],row]))
 assert.equal(rows.has('collaboration.attachment.tooLarge'),false,'旧的不分类型词条已拆掉')
 for(const [key,limit] of [['collaboration.attachment.imageTooLarge',contract.groupAttachmentImageMaxBytes],['collaboration.attachment.fileTooLarge',contract.groupAttachmentFileMaxBytes]] as const){
  const row=rows.get(key)
  assert.ok(row,key)
  assert.equal(row.length,11,key)
  const mib=String(limit/1024/1024)
  for(const text of row.slice(1))assert.ok(text.includes(mib+' MiB')||text.includes(mib+' Mio'),`${key}: ${text}`)
 }
})

test('三类引用各渲染出对应形态；图片走 blob: 地址，全树零 dangerouslySetInnerHTML',async()=>{
 const {api}=makeApi({messages:[selfMessage('m1','三份材料',[
  {kind:'attachment',id:imageId,version:1},
  {kind:'attachment',id:docId,version:1},
  {kind:'group-resource',id:resourceId,version:2},
 ])]})
 const {attachments}=makeAttachments({files:[attachment({}),attachment({attachmentId:docId,kind:'file',mime:'text/markdown',name:'说明.md',bytes:4096,width:null,height:null})],opened:{[imageId]:{mime:'image/png',name:'图.png'},[docId]:{mime:'text/markdown',name:'说明.md'}}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 const image=app.find(el=>el.type==='img'&&el.props.alt==='图.png')
 assert.ok(String(image.props.src).startsWith('blob:'),'图片只能用 blob: 地址')
 const thumbnailButton=app.find(byAria(app,t('collaboration.attachment.open',{name:'图.png'})))
 assert.equal(thumbnailButton.type,'button','缩略图要可点开大图')
 const download=app.find(el=>el.type==='a'&&el.props.download==='说明.md')
 assert.ok(String(download.props.href).startsWith('blob:'))
 assert.equal(app.findAll(el=>el.type==='img'&&el.props.alt==='说明.md').length,0,'文件卡不内嵌预览')
 assert.ok(app.findAll(el=>app.contentOf(el).includes('4.0 KiB')).length>0,'文件卡给出大小与类型')
 assert.ok(app.findAll(el=>el.type==='p'&&app.contentOf(el).startsWith('collaboration.message.references')).length>0,'群资料引用的呈现照旧')
 assert.equal(app.all().filter(el=>el.props.dangerouslySetInnerHTML!==undefined).length,0,'全树不得有 dangerouslySetInnerHTML')
})

test('成果引用给成果卡与跳转入口；SVG 成果文件只给下载不内嵌',async()=>{
 const opened:Record<string,OpenedRow>={}
 opened[artifactId]={mime:'image/svg+xml',name:'架构图.svg'}
 const {api}=makeApi({messages:[employeeMessage('m2',[{kind:'artifact',id:artifactId,version:2}])]})
 const {attachments,calls}=makeAttachments({opened})
 const jumped:string[]=[]
 const app=mount({visible:true,api,attachments,openArtifact:id=>jumped.push(id),directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el).includes(t('collaboration.reference.artifactCard',{title:'架构图.svg',version:2,count:1}))).length>0,'成果卡逐字走 artifactCard 词条')
 assert.equal(app.findAll(el=>el.type==='img').length,0,'SVG 成果文件一律不内嵌')
 assert.equal(app.find(el=>el.type==='a'&&el.props.download==='架构图.svg').props.download,'架构图.svg','只给下载')
 app.find(el=>el.type==='button'&&app.contentOf(el)===t('collaboration.reference.openArtifact')).props.onClick()
 assert.deepEqual(jumped,[artifactId])
 // 单文件成果卡沿用旧「无需点开即可见」体验：describeArtifact 取标题/文件清单后自动懒取那一个文件的字节，不必等用户展开。
 assert.deepEqual(calls.filter(call=>call.endpoint==='describeArtifact').map(call=>call.payload),[{id:artifactId,version:2}])
 assert.deepEqual(calls.filter(call=>call.endpoint==='openArtifactFile').map(call=>call.payload),[{id:artifactId,version:2,snapshotId:artifactId+':snap'}])
})

test('成果关联多个文件时先只显示标题与文件数，点开才逐个懒取字节；展开前不多打任何字节请求',async()=>{
 const snapshotA='aaaaaaaa-file-1',snapshotB='bbbbbbbb-file-2'
 const {api}=makeApi({messages:[selfMessage('m2b','多文件成果',[{kind:'artifact',id:artifactId,version:3}])]})
 const {attachments,calls}=makeAttachments({
  artifactFiles:{[artifactId]:{title:'调查报告',snapshotIds:[snapshotA,snapshotB]}},
  artifactFileBytes:{[snapshotA]:{mime:'image/png',name:'截图.png'},[snapshotB]:{mime:'text/plain',name:'备注.txt'}},
 })
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el).includes(t('collaboration.reference.artifactCard',{title:'调查报告',version:3,count:2}))).length>0,'成果卡标题与文件数先到位')
 assert.equal(calls.filter(call=>call.endpoint==='openArtifactFile').length,0,'展开前不该有任何文件的字节请求')
 assert.ok(app.findAll(el=>app.contentOf(el)===snapshotA.slice(0,8)).length>0,'未取到字节前文件行先用 snapshotId 前 8 位占位')
 const card=app.find(el=>el.type==='details'&&app.contentOf(el).includes('调查报告'))
 assert.equal(card.props.open,false,'关联多个文件时默认收起')
 card.props.onToggle({target:{open:true}})
 await app.flush()
 assert.deepEqual(calls.filter(call=>call.endpoint==='openArtifactFile').map(call=>call.payload).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),[
  {id:artifactId,version:3,snapshotId:snapshotA},
  {id:artifactId,version:3,snapshotId:snapshotB},
 ].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),'展开后逐个文件都懒取了字节')
 assert.ok(app.find(el=>el.type==='img'&&el.props.alt==='截图.png'),'PNG 文件展开后内嵌缩略图')
 assert.equal(app.find(el=>el.type==='a'&&el.props.download==='备注.txt').props.download,'备注.txt','纯文本文件只给下载')
})

test('三类引用取不到字节时各给对应灰卡，且都没有下载入口',async()=>{
 const {api}=makeApi({messages:[selfMessage('m3','都不可用',[
  {kind:'attachment',id:goneId,version:1},
  {kind:'artifact',id:artifactId,version:1},
 ])]})
 const {attachments}=makeAttachments({opened:{[goneId]:'fail',[artifactId]:'fail'}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.withdrawn')).length>0)
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.reference.artifactUnavailable')).length>0)
 assert.equal(app.findAll(el=>el.type==='a'&&el.props.download!==undefined).length,0,'不可用引用不得给下载')
 assert.equal(app.findAll(el=>el.type==='img').length,0)
})

test('员工消息的引用只读呈现，没有任何加引用或改引用的控件',async()=>{
 const {api}=makeApi({messages:[employeeMessage('m4',[{kind:'attachment',id:imageId,version:1}])]})
 const {attachments}=makeAttachments({opened:{[imageId]:{mime:'image/png',name:'图.png'}}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 const message=app.find(el=>el.type==='article'&&app.contentOf(el).includes('已完成核对。'))
 const controls=[message,...app.all().filter(el=>app.contentOf(el)==='已完成核对。')]
 assert.ok(controls.length>0)
 const labels=app.findAll(el=>['collaboration.resources.reference','collaboration.resources.remove'].includes(app.contentOf(el)))
 assert.equal(labels.length,0,'员工消息一侧不得出现任何加引用/改引用入口')
 assert.equal(app.findAll(el=>el.type==='input'&&el.props.type==='file').length,1,'文件选择器只属于本人输入区')
})

test('大图弹层走既有 openDialog 打开，Esc 关闭后焦点交回 returnPanelFocus',async()=>{
 const {api}=makeApi({messages:[selfMessage('m5','看图',[{kind:'attachment',id:imageId,version:1}])]})
 const {attachments}=makeAttachments({opened:{[imageId]:{mime:'image/png',name:'图.png'}}})
 const dialogCalls:unknown[][]=[],focusCalls:unknown[]=[]
 // 焦点锚点取触发按钮本身（event.currentTarget），不再读 document.activeElement——程序化点击不挪焦点，
 // 靠 activeElement 会把焦点还给 body。
 const opener=new (globalThis as unknown as {HTMLElement:new()=>unknown}).HTMLElement()
 ;(globalThis as unknown as {document:{activeElement:unknown}}).document.activeElement=null
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'},{openDialog:(node,focus)=>dialogCalls.push([node,focus]),returnPanelFocus:value=>focusCalls.push(value)})
 await app.flush()
 app.find(byAria(app,t('collaboration.attachment.open',{name:'图.png'}))).props.onClick({currentTarget:opener})
 await app.flush()
 const dialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']===t('collaboration.attachment.dialogTitle',{name:'图.png'}))
 assert.equal(dialogCalls.length,1,'大图弹层只走既有 openDialog 打开一次')
 assert.ok(app.findAll(byAria(app,t('collaboration.attachment.close'))).length===1,'关闭按钮带词条 aria-label')
 dialog.props.onCancel()
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='dialog'&&el.props['aria-label']===t('collaboration.attachment.dialogTitle',{name:'图.png'})).length,0,'Esc 后弹层关闭')
 assert.deepEqual(focusCalls,[opener],'焦点交回触发它的那个按钮，而不是当时的 activeElement')
})

test('侧栏「资料与文件」两分节都在，资料分节的列表逐字不变',async()=>{
 const resource={id:resourceId,groupId,version:2,title:'核对口径',withdrawnAt:null,createdAt:stamp,updatedAt:stamp}
 const base=mount({visible:true,api:makeApi({resources:[resource]}).api,directory:directory(),target,roles,profileName:'测试者'})
 await base.flush()
 openInfoPanel(base)
 const before=base.contentOf(base.find(el=>el.props.className==='resourceList'))
 const {attachments}=makeAttachments({files:[attachment({name:'旧.png',createdAt:'2026-09-20T01:00:00.000Z'}),attachment({attachmentId:docId,kind:'file',mime:'text/markdown',name:'新.md',bytes:4096,width:null,height:null,createdAt:'2026-09-21T02:00:00.000Z'})]})
 const app=mount({visible:true,api:makeApi({resources:[resource]}).api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 const card=app.find(el=>el.props.className==='relationshipCard'&&app.contentOf(el).includes(t('collaboration.access.materials.title')))
 assert.ok(app.contentOf(card).includes(t('collaboration.attachment.section')),'第二分节「文件」必须在同一张卡里')
 assert.ok(app.contentOf(card).includes(t('collaboration.attachment.sectionHint')))
 const lists=app.findAll(el=>el.props.className==='resourceList')
 assert.equal(lists.length,2,'两个分节各一份列表')
 assert.equal(app.contentOf(lists[0]!),before,'资料分节的列表逐字不变')
 const fileNames=app.findAll(el=>el.type==='strong'&&['旧.png','新.md'].includes(app.contentOf(el))).map(el=>app.contentOf(el))
 assert.deepEqual(fileNames,['新.md','旧.png'],'文件按 createdAt 倒序')
})

test('群里没有文件时文件分节给空态词条',async()=>{
 const {attachments}=makeAttachments({files:[]})
 const app=mount({visible:true,api:makeApi().api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.attachment.sectionEmpty')).length>0)
})

test('撤回确认弹层的正文逐字含「已存的字节不会被删除。」，确认后才上网',async()=>{
 const {attachments,calls}=makeAttachments({files:[attachment({})]})
 const app=mount({visible:true,api:makeApi().api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)===t('collaboration.attachment.withdraw')&&el.props.className==='replyButton').props.onClick()
 await app.flush()
 const confirmDialog=app.find(el=>el.type==='dialog'&&el.props['aria-label']===t('collaboration.attachment.withdraw'))
 assert.ok(app.contentOf(confirmDialog).includes('已存的字节不会被删除。'),'确认正文必须逐字写明字节不删')
 assert.equal(calls.filter(call=>call.endpoint==='groups/attachments/withdraw').length,0,'弹层出来还没上网')
 app.find(el=>el.type==='form'&&app.contentOf(el).includes('已存的字节不会被删除。')).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const withdraw=calls.filter(call=>call.endpoint==='groups/attachments/withdraw')
 assert.equal(withdraw.length,1)
 assert.deepEqual(Object.keys(withdraw[0]!.payload as object).sort(),['attachmentId','requestId'],'撤回只提交白名单字段')
})

test('授权面按 kind 分三组，勾选后提交的 resources 就是勾选那几条且顺序稳定',async()=>{
 const resource={id:resourceId,groupId,version:2,title:'核对口径',withdrawnAt:null,createdAt:stamp,updatedAt:stamp}
 const {api,calls}=makeApi({resources:[resource],messages:[employeeMessage('m6',[{kind:'artifact',id:artifactId,version:2}])]})
 const {attachments}=makeAttachments({files:[attachment({})],opened:{[artifactId]:'fail'}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.agentGrant.configure'&&el.props.className==='replyButton').props.onClick()
 await app.flush()
 const legends=app.findAll(el=>el.type==='legend').map(el=>app.contentOf(el))
 assert.deepEqual(legends,[t('collaboration.grant.section.resources'),t('collaboration.grant.section.attachments'),t('collaboration.grant.section.artifacts')],'三组齐全且按资料／文件／成果排列')
 assert.ok(app.findAll(el=>app.contentOf(el)===t('collaboration.grant.canPost.attachmentNote')).length>0,'群内发言开关下补一句附件说明')
 const boxes=app.findAll(el=>el.type==='input'&&el.props.type==='checkbox')
 const labelled=(text:string)=>app.find(el=>el.props.className==='memberChoice'&&app.contentOf(el).includes(text))
 assert.ok(boxes.every(box=>box.props.checked!==undefined))
 labelled('核对口径').props.children[0].props.onChange()
 app.render()
 labelled('图.png').props.children[0].props.onChange()
 app.render()
 labelled(artifactId.slice(0,8)).props.children[0].props.onChange()
 app.render()
 app.find(el=>el.type==='form'&&app.contentOf(el).includes(t('collaboration.grant.canPost.attachmentNote'))).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const saved=calls.filter(call=>call.endpoint==='groups/agent-grants/change')
 assert.equal(saved.length,1)
 assert.deepEqual((saved[0]!.payload as {resources:MessageReference[]}).resources,[
  {kind:'group-resource',id:resourceId,version:2},
  {kind:'attachment',id:imageId,version:1},
  {kind:'artifact',id:artifactId,version:2},
 ],'提交的就是勾选那几条判别联合，顺序按勾选先后稳定')
})

test('群里还没有出现过成果引用时，授权面成果组给空态词条而不是空列表',async()=>{
 const {api}=makeApi()
 const {attachments}=makeAttachments()
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.agentGrant.configure'&&el.props.className==='replyButton').props.onClick()
 await app.flush()
 const artifactsFieldset=app.find(el=>el.type==='fieldset'&&app.contentOf(el).includes(t('collaboration.grant.section.artifacts')))
 assert.ok(app.contentOf(artifactsFieldset).includes(t('collaboration.grant.section.artifactsEmpty')),'成果组为空时要给空态词条')
})

test('组件卸载后释放的 blob 地址与创建数一一对上',async()=>{
 blobCount=0;revokedUrls=[]
 const {api}=makeApi({messages:[selfMessage('m7','两份',[{kind:'attachment',id:imageId,version:1},{kind:'attachment',id:docId,version:1}])]})
 const {attachments}=makeAttachments({opened:{[imageId]:{mime:'image/png',name:'图.png'},[docId]:{mime:'text/markdown',name:'说明.md'}}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.equal(blobCount,2,'两条引用各建一个 blob 地址')
 assert.equal(revokedUrls.length,0)
 app.unmount()
 assert.deepEqual(revokedUrls.sort(),['blob:teloa/1','blob:teloa/2'],'卸载后逐个释放，个数与创建数相等')
})

test('授权面按固定版本区分：同一份成果的两个版本是两条独立授权',async()=>{
 const {api,calls}=makeApi({messages:[
  employeeMessage('m8',[{kind:'artifact',id:artifactId,version:1}]),
  employeeMessage('m9',[{kind:'artifact',id:artifactId,version:2}]),
 ]})
 const {attachments}=makeAttachments({artifactFiles:{[artifactId]:{title:'核对报告',snapshotIds:[]}}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.agentGrant.configure'&&el.props.className==='replyButton').props.onClick()
 await app.flush()
 const rows=app.findAll(el=>el.props.className==='memberChoice'&&app.contentOf(el).includes(artifactId.slice(0,8)))
 assert.equal(rows.length,2,'同一份成果的两个版本各占一行')
 rows[0]!.props.children[0].props.onChange()
 app.render()
 const checked=app.findAll(el=>el.props.className==='memberChoice'&&app.contentOf(el).includes(artifactId.slice(0,8))).map(el=>el.props.children[0].props.checked)
 assert.deepEqual(checked,[true,false],'勾中一个版本不得把另一个版本也判成已勾')
 app.find(el=>el.type==='form'&&app.contentOf(el).includes(t('collaboration.grant.canPost.attachmentNote'))).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const saved=calls.filter(call=>call.endpoint==='groups/agent-grants/change')
 assert.deepEqual((saved[0]!.payload as {resources:MessageReference[]}).resources,[{kind:'artifact',id:artifactId,version:1}],'提交的就是被勾中的那个固定版本')
})

test('授权面不把界面上已经看不见的旧授权原样重存回去',async()=>{
 const resource={id:resourceId,groupId,version:2,title:'核对口径',withdrawnAt:null,createdAt:stamp,updatedAt:stamp}
 // 已存授权里有一条指向早已被撤回的附件：它不在任何一组候选里，界面上无从取消勾选。
 const stale:MessageReference={kind:'attachment',id:goneId,version:1}
 const {api,calls}=makeApi({resources:[resource],grantResources:[stale,{kind:'group-resource',id:resourceId,version:2}]})
 const {attachments}=makeAttachments({files:[]})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 openInfoPanel(app)
 await app.flush()
 app.find(el=>el.type==='button'&&app.contentOf(el)==='collaboration.agentGrant.configure'&&el.props.className==='replyButton').props.onClick()
 await app.flush()
 app.find(el=>el.type==='form'&&app.contentOf(el).includes(t('collaboration.grant.canPost.attachmentNote'))).props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const saved=calls.filter(call=>call.endpoint==='groups/agent-grants/change')
 assert.deepEqual((saved[0]!.payload as {resources:MessageReference[]}).resources,[{kind:'group-resource',id:resourceId,version:2}],'只留还在候选里的那条，失效的那条不得被静默重存')
})

test('切群时立刻释放上一群的 blob 地址：两次切换后释放数等于创建数减在屏数',async()=>{
 blobCount=0;revokedUrls=[]
 const {api}=makeTwoGroupApi()
 const {attachments}=makeAttachments({opened:{[imageId]:{mime:'image/png',name:'图.png'},[docId]:{mime:'text/markdown',name:'说明.md'},[otherImageId]:{mime:'image/png',name:'另一张.png'}}})
 const app=mount({visible:true,api,attachments,directory:directory(),target,roles,profileName:'测试者'})
 await app.flush()
 assert.equal(blobCount,2,'甲群两条引用各建一个 blob 地址')
 app.setProps({target:{groupId:otherGroupId,rootId:''}})
 await app.flush()
 assert.equal(revokedUrls.length,2,'切到乙群立刻释放甲群那两个，不等到卸载')
 assert.equal(blobCount,3,'乙群一条引用再建一个')
 app.setProps({target:{groupId,rootId:''}})
 await app.flush()
 assert.equal(revokedUrls.length,3,'切回甲群时乙群那个也释放掉')
 assert.equal(blobCount,5,'回到甲群重新取字节，两条各建一个')
 const onScreen=app.findAll(el=>el.type==='img'||(el.type==='a'&&el.props.download!==undefined)).length
 assert.equal(onScreen,2,'此刻在屏的是甲群那两条')
 assert.equal(revokedUrls.length,blobCount-onScreen,'释放数 == 创建数 − 在屏数')
 app.unmount()
 assert.equal(revokedUrls.length,blobCount,'卸载后全部释放')
})

test('跨挂载读回草稿时上传中的行落成失败，发送按钮不再被恒锁',async()=>{
 const drafts=createSavedCollaborationDraftStore()
 const first=mount({visible:true,api:makeApi().api,attachments:makeAttachments({uploadHangs:true}).attachments,directory:directory(),target,roles,profileName:'测试者'},{drafts})
 await first.flush()
 textareaOf(first).props.onChange({target:{value:'看这个'}})
 first.render()
 first.find(el=>el.type==='input'&&el.props.type==='file').props.onChange({target:{files:[file('说明.md','text/markdown')],value:''}})
 await first.flush()
 assert.equal(sendButton(first).props.disabled,true,'这次挂载里它确实还在传')
 first.unmount()

 const second=mount({visible:true,api:makeApi().api,attachments:makeAttachments().attachments,directory:directory(),target,roles,profileName:'测试者'},{drafts})
 await second.flush()
 assert.equal(second.findAll(el=>el.props.role==='alert'&&second.contentOf(el).includes('说明.md')).length,1,'读回的上传中行落成失败行')
 assert.equal(sendButton(second).props.disabled,false,'不再装作还在传，发送按钮解锁')
 // 原始字节已经随上一次挂载散掉：重试不空转，而是清掉这条失效行并重新打开选择器。
 second.find(el=>el.type==='button'&&second.contentOf(el)===t('collaboration.attachment.retry')).props.onClick()
 await second.flush()
 assert.equal(second.findAll(el=>second.contentOf(el).includes('说明.md')).length,0,'失效行被清掉，不留在待发送区')
})
