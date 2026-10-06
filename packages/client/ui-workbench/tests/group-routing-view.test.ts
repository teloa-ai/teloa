import {applicationCapabilityModule} from './application-capability-fixture.ts'
import * as knowledgeMarkdown from '../src/client/knowledge-markdown-core.ts'
import {staffAvatarComponent} from './staff-avatar-component.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import type {GroupMessage,GroupRoutingDecisionView} from '@teloa/contract'
import {groupRoutingPending,groupRoutingPendingWindowMs} from '../src/client/group-routing-view.ts'

/**
 * 群内直接回应与表情一期 功能验证（2026-09-21）：话题面板的「同事正在回复…」折叠行、
 * relay-stopped 副标题、4 秒轮询三口闭环与表情条接线。
 * 折叠行是纯派生（规格 §3.4）：只用本话题的消息目录 + groups/routing/list 的决策视图，
 * 不读运行状态；30 分钟兜底是纯客户端判断。派生逻辑在这里按函数直测；
 * 接线面按本仓既有手法（collaboration-topic-focus.test.ts）对源码文本做机器化断言。
 */

const root=new URL('../src/client/',import.meta.url)
const source=(name:string)=>readFileSync(new URL(name,root),'utf8')

const messageId='11111111-1111-4111-8111-111111111111'
const roleA='22222222-2222-4222-8222-222222222222'
const roleB='33333333-3333-4333-8333-333333333333'
const groupId='44444444-4444-4444-8444-444444444444'
const now=Date.parse('2026-09-21T12:00:00.000Z')

const selfMessage=(id:string,createdAt:string):GroupMessage=>({id,groupId,rootId:null,authorId:'self',text:'请看一下',references:[],mentions:[],createdAt})
const roleMessage=(id:string,authorId:string,createdAt:string,text='我来看'):GroupMessage=>({id,groupId,rootId:messageId,authorId,taskId:roleA,runId:roleB,text,references:[],createdAt})
const decision=(over:Partial<GroupRoutingDecisionView>={}):GroupRoutingDecisionView=>({messageId,kind:'routed',respond:[roleA],hops:0,...over})

test('折叠行：respond 里还没发过言的同事算「正在回复」',()=>{
 const messages=[selfMessage(messageId,'2026-09-21T11:59:00.000Z')]
 assert.deepEqual(groupRoutingPending(decision({respond:[roleA,roleB]}),messages,now),[roleA,roleB])
})

test('折叠行：已经在本话题目录里发过言的同事不再显示',()=>{
 const messages=[selfMessage(messageId,'2026-09-21T11:59:00.000Z'),roleMessage('55555555-5555-4555-8555-555555555555',roleA,'2026-09-21T11:59:30.000Z')]
 assert.deepEqual(groupRoutingPending(decision({respond:[roleA,roleB]}),messages,now),[roleB])
})

test('折叠行：超过三十分钟一律不再显示（纯客户端兜底）',()=>{
 const within=[selfMessage(messageId,new Date(now-groupRoutingPendingWindowMs+1000).toISOString())]
 const beyond=[selfMessage(messageId,new Date(now-groupRoutingPendingWindowMs-1000).toISOString())]
 assert.deepEqual(groupRoutingPending(decision(),within,now),[roleA])
 assert.deepEqual(groupRoutingPending(decision(),beyond,now),[])
 assert.equal(groupRoutingPendingWindowMs,30*60*1000)
})

test('折叠行：触发消息不在本话题目录里、respond 为空或时间戳不可解析时都不显示',()=>{
 assert.deepEqual(groupRoutingPending(decision(),[],now),[])
 assert.deepEqual(groupRoutingPending(decision({respond:[]}),[selfMessage(messageId,'2026-09-21T11:59:00.000Z')],now),[])
 assert.deepEqual(groupRoutingPending(decision(),[selfMessage(messageId,'不是时间')],now),[])
})

test('折叠行：relay-stopped 决策本身不产生「正在回复」（respond 恒空）',()=>{
 const messages=[selfMessage(messageId,'2026-09-21T11:59:00.000Z')]
 assert.deepEqual(groupRoutingPending(decision({kind:'relay-stopped',respond:[],hops:6}),messages,now),[])
})

test('话题面板进 4 秒闭环：一次重读同时刷消息、话题、表情与路由（教训 b）',()=>{
 const page=source('SavedCollaborationPage.tsx')
 const reload=page.split('\n const reloadSelected=')[1]!.split('\n /**')[0]!
 for(const call of ['api.get(','api.messages(','api.resources(','setTopic(','readMessageOverlays('])assert.ok(reload.includes(call),call)
 // 轮询 effect 的依赖带上 topic：话题里多一条回帖同样会重排下一轮，话题面板不再掉出闭环。
 const loop=page.split('return scheduleGroupMessageRefresh(')[1]!.split('\n')[1]!
 assert.match(loop,/\[visible,selected,messages,rootId,topic,api\]/)
})

test('轮询三口互不拖累：表情与路由各自 catch，失败不让目录刷新整体失败',()=>{
 const page=source('SavedCollaborationPage.tsx')
 const overlays=page.split('\n const readMessageOverlays=')[1]!.split('\n /**')[0]!
 assert.match(overlays,/reactions\?\.list\([^)]*\)\.catch\(/)
 assert.match(overlays,/routing\?\.list\([^)]*\)\.catch\(/)
 // 两口在同一个 Promise.all 里并发，任一失败都被自己的 catch 吃掉，另一口照常落地。
 assert.ok(overlays.includes('await Promise.all(['))
 assert.ok(overlays.includes('if(reactionRows)setReactionItems(reactionRows)'))
 assert.ok(overlays.includes('if(routingRows)setRoutingDecisions(routingRows)'))
})

test('表情条接线：表情条挂在 SavedMessage 的 reactions prop 上（正文之后、动作行之前），不再是消息的兄弟节点',()=>{
 const page=source('SavedCollaborationPage.tsx')
 assert.ok(page.includes("import {GroupReactionBar} from './GroupReactionBar.js'"))
 assert.ok(page.includes('<GroupReactionBar'))
 assert.match(page,/const toggleReaction=[\s\S]{0,400}?reactions\.toggle\(/)
 // 飞书式：表情条是 SavedMessage 的 reactions prop，落在消息体内；Fragment 里不再把它当兄弟节点渲染。
 assert.ok(page.includes('reactions={reactionBar(message)}'),'两处 SavedMessage 都必须以 reactions prop 挂表情条')
 assert.equal(page.includes('/>{reactionBar(message)}'),false,'Fragment 里不应再有 {reactionBar(message)} 这种兄弟节点写法')
 // SavedMessage 内部：reactions 包一层 css.reactions，渲染在 referenceCards 之后、messageActions 之前。
 const savedMessage=page.split('function SavedMessage(')[1]!.split('\nfunction ')[0]!
 assert.ok(savedMessage.indexOf('className={css.reactions}')<savedMessage.indexOf('<GroupReplyPreview'))
 assert.ok(savedMessage.indexOf('<GroupReplyPreview')<savedMessage.indexOf('className={css.messageActions}'))
 // 归档及高级权益只读都禁止新增回应；消息与原回应仍可读取。
 const bar=page.split('<GroupReactionBar')[1]!.split('/>')[0]!
 assert.ok(bar.includes('archived={group.archived||!allowed}'),bar)
 assert.ok(bar.includes('roleNames={roleNames}'),bar)
})

test('话题面板渲染折叠行与 stoppedHint，两位以上折叠成通用文案并可展开',()=>{
 const page=source('SavedCollaborationPage.tsx')
 assert.ok(page.includes("t('group.routing.pendingNamed'"))
 assert.ok(page.includes("t('group.routing.pending')"))
 assert.ok(page.includes("t('group.routing.stoppedHint')"))
 assert.ok(page.includes("kind==='relay-stopped'"))
 assert.ok(page.includes('groupRoutingPending('))
})

function sourceNode(file:string,predicate:(node:ts.Node)=>boolean):ts.Node{
 const ast=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let found:ts.Node|undefined
 const visit=(node:ts.Node)=>{if(!found&&predicate(node))found=node;ts.forEachChild(node,visit)}
 visit(ast);assert.ok(found,'没有找到实际实现：'+file);return found
}
function implementation<T>(node:ts.Node,scope:Record<string,unknown>):T{
 const js=ts.transpileModule('const implementation='+node.getText(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 return new Function(...Object.keys(scope),js+';return implementation')(...Object.values(scope)) as T
}

test('开岗位会话时 conversations/create 带 roleId；普通会话不带岗位或工作区，并保留固定标题',async()=>{
 const property=sourceNode('index.ts',node=>ts.isPropertyAssignment(node)&&node.name.getText()==='create'&&node.initializer.getText().includes("call('conversations/create'")) as ts.PropertyAssignment
 const calls:{endpoint:string;input:unknown}[]=[],conversation={sessionId:'created'}
 const create=implementation<(input:Record<string,string>)=>Promise<unknown>>(property.initializer,{call:async(endpoint:string,input:unknown)=>{calls.push({endpoint,input});return conversation},isConversation:(value:unknown)=>value===conversation})
 assert.equal(await create({requestId:'ordinary'}),conversation)
 assert.equal(await create({requestId:'role',roleId:roleA,workspaceId:'workspace',title:'固定岗位标题'}),conversation)
 assert.deepEqual(calls,[
  {endpoint:'conversations/create',input:{requestId:'ordinary',title:'新工作会话'}},
  {endpoint:'conversations/create',input:{requestId:'role',title:'固定岗位标题',workspaceId:'workspace',roleId:roleA}},
 ])
 // 新增可选标题/请求身份不能让原有的可选岗位字段消失或变成必填。
 for(const name of ['ConversationCreation','CreateConversationOptions']){
  const alias=sourceNode('binding-client.ts',node=>ts.isTypeAliasDeclaration(node)&&node.name.text===name) as ts.TypeAliasDeclaration
  const type=(alias.type as ts.TypeReferenceNode).typeArguments![0] as ts.TypeLiteralNode
  const role=type.members.find(member=>member.name?.getText()==='roleId') as ts.PropertySignature
  assert.ok(role.questionToken);assert.equal(role.type?.kind,ts.SyntaxKind.StringKeyword)
 }
})

test('岗位新会话仅建立本人关联；身份由宿主上下文注入，不自动发送长正文',()=>{
 const frame=source('WorkbenchFrame.tsx')
 assert.ok(frame.includes("roleId:intent.object.id"))
 assert.match(frame,/await ensureHomeObjectContext\(objectConversationApi,object,row\.sessionId,intent\.scope\)/)
 assert.doesNotMatch(frame,/sendRoleIdentity\(object,conversation,canContinue\)/)
 // openTwinConversation 仍然只是 openRoleConversation(twin.id)，零额外代码。
 assert.match(frame,/openTwinConversation=async\(\)=>\{[\s\S]{0,600}?return openRoleConversation\(twin\.id\)/)
})

test('会话头部身份行：RoleConversationIdentity 用 role.conversation.identity 词条并接在原生会话头部',()=>{
 const identity=source('RoleConversationIdentity.tsx')
 assert.ok(identity.includes("t('role.conversation.identity',{name"))
 const client=source('index.ts')
 assert.match(client,/conversation\.session\.header\.utilities[\s\S]{0,400}?RoleConversationIdentity/)
})

/* ------------------------------------------------------------------------ *
 * 修复轮 1（M2）：折叠行、展开名单与 stoppedHint 的真渲染用例。
 * 这一段里 group-routing-view.js 用真模块、GroupReactionBar.js 用真组件（不再是空桩），
 * 手法照 group-attachment-view.test.ts：真实运行组件函数与 useEffect，不经过 jsdom。
 * ------------------------------------------------------------------------ */

import ts from 'typescript'
import * as React from 'react'
import {testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {GroupAgentGrant,GroupMember} from '@teloa/contract'
import * as savedCollaborationState from '../src/client/saved-collaboration-state.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import * as groupRoutingView from '../src/client/group-routing-view.ts'
import {GROUP_REACTION_MESSAGE_ROWS} from '../src/client/i18n/locales/group-reaction.ts'
import {COLLABORATION_MESSAGE_ROWS} from '../src/client/i18n/locales/collaboration.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {GroupApi,GroupSnapshot} from '../src/client/group-api.js'
import type {GroupReactionApi} from '../src/client/group-reaction-api.js'
import type {GroupRoutingApi} from '../src/client/group-routing-api.js'

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

const routingText=new Map<string,string>(GROUP_REACTION_MESSAGE_ROWS.map(row=>[row[0],row[1]] as [string,string]))
// 作者区用的是协作词表里的几条，逐字从 COLLABORATION_MESSAGE_ROWS 取 zh-CN，不在测试里另造文案。
for(const key of ['collaboration.message.self','collaboration.message.selfRole','collaboration.message.employeeRole','collaboration.message.historicalMember'])routingText.set(key,COLLABORATION_MESSAGE_ROWS.find(row=>row[0]===key)![1]!)
const rt=(key:string,params?:Record<string,string|number>)=>{
 const text=routingText.get(key)
 if(text===undefined)return params?key+':'+JSON.stringify(params):key
 return text.replace(/\{(\w+)\}/g,(whole,name:string)=>params&&name in params?String(params[name]):whole)
}

const previewRole=(id:string,name:string):PreviewRole=>({id,name,kind:'employee',scopes:['general'],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[]})
const viewRoles:PreviewRole[]=[previewRole(roleA,'小张'),previewRole(roleB,'小李')]
const viewGroup={id:groupId,ownerId:'self',version:3,name:'直接回应群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:'2026-09-21T01:00:00.000Z',updatedAt:'2026-09-21T01:00:00.000Z'}
const viewMembers:GroupMember[]=[{groupId,roleId:null,createdAt:'2026-09-21T01:00:00.000Z'},{groupId,roleId:roleA,createdAt:'2026-09-21T01:00:00.000Z'},{groupId,roleId:roleB,createdAt:'2026-09-21T01:00:00.000Z'}]
const fresh=()=>new Date().toISOString()

type ViewSetup={main?:GroupMessage[];replies?:GroupMessage[];decisions?:GroupRoutingDecisionView[];reactionPending?:boolean}
function viewFixture(setup:ViewSetup={}){
 const snapshot:GroupSnapshot={group:viewGroup,members:viewMembers}
 const api={
  get:async()=>snapshot,
  messages:async(_id:string,forRoot?:string)=>({items:forRoot?setup.replies??[]:setup.main??[]}),
  resources:async()=>({items:[]}),
  agentGrant:async(_groupId:string,roleId:string)=>({groupVersion:3,roleVersion:1,grant:{groupId,roleId,groupVersion:3,roleVersion:1,grantVersion:1,state:'active' as const,resources:[],canPost:true,canAutoRun:true,createdAt:'2026-09-21T01:00:00.000Z'} satisfies GroupAgentGrant,status:'active' as const}),
  list:async()=>({items:[viewGroup]}),
  recoveryMessage:()=>undefined,
  pending:()=>undefined,
 } as unknown as GroupApi
 const reactionCalls:{endpoint:string;ids?:string[]}[]=[]
 let pendingRequest:{messageId:string}|undefined=setup.reactionPending?{messageId}:undefined
 const reactions={
  list:async(_groupId:string,ids:string[])=>{reactionCalls.push({endpoint:'list',ids});return []},
  toggle:async(_groupId:string,id:string)=>{reactionCalls.push({endpoint:'toggle'});return [{messageId:id,emoji:'👍' as const,count:1,mine:true,actors:[{actorKind:'self' as const,actorId:'self'}]}]},
  pending:()=>pendingRequest,
  recoveryMessage:()=>undefined,
  discard:()=>{const had=pendingRequest!==undefined;pendingRequest=undefined;return had},
  recover:async()=>{reactionCalls.push({endpoint:'recover'});pendingRequest=undefined;return []},
 } as unknown as GroupReactionApi
 const routingCalls:{ids:string[]}[]=[]
 const routing={list:async(_groupId:string,ids:string[])=>{routingCalls.push({ids});return setup.decisions??[]}} as unknown as GroupRoutingApi
 return {api,reactions,routing,reactionCalls,routingCalls}
}

/**
 * MarkdownText 的最小复刻：只认 `**加粗**` 与 `- 列表` 两种语法，供下面「同事消息按 Markdown 渲染」
 * 一条真渲染测试使用。原因见 mountPage 内 require 分支的注释。
 */
const testMarkdownText=({text}:{text:string}):React.ReactNode=>{
 const blocks:React.ReactNode[]=[]
 let listItems:string[]=[]
 const flushList=()=>{
  if(listItems.length===0)return
  blocks.push(React.createElement('ul',{key:'ul'+blocks.length},listItems.map((item,index)=>React.createElement('li',{key:index},item))))
  listItems=[]
 }
 for(const line of text.split('\n')){
  if(line.startsWith('- ')){listItems.push(line.slice(2));continue}
  flushList()
  if(!line.trim())continue
  const parts=line.split(/\*\*(.+?)\*\*/g)
  blocks.push(React.createElement('p',{key:'p'+blocks.length},parts.map((part,index)=>index%2===1?React.createElement('strong',{key:index},part):part)))
 }
 flushList()
 return React.createElement(React.Fragment,null,...blocks)
}

/** 递归加载真实模块：group-routing-view 与 GroupReactionBar 都跑真身，只有外部依赖给桩。 */
function mountPage(props:Record<string,unknown>){
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
 const loaded=new Map<string,Record<string,any>>()
 const load=(file:string):Record<string,any>=>{
  const cached=loaded.get(file)
  if(cached)return cached
  const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
  const exported:Record<string,any>={}
  loaded.set(file,exported)
  new Function('require','exports','React',code)(require,exported,hooks)
  return exported
 }
 const require=(id:string):unknown=>{
  const capability=applicationCapabilityModule(id);if(capability!==undefined)return capability
  if(id==='react')return hooks
  if(id==='./StaffAvatar.js')return staffAvatarComponent
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('knowledge-markdown-core.js'))return knowledgeMarkdown
  if(id.endsWith('ComposerPopover.js'))return {ComposerPopover:({children,label}:{children:React.ReactNode;label:string})=>React.createElement('div',{role:'dialog','aria-label':label},children)}
  if(id.endsWith('dialog-focus.js'))return {openDialog:()=>()=>{}}
  if(id.endsWith('directory-focus.js'))return {closeDirectoryDetailOnEscape:()=>{}}
  if(id.endsWith('panel-focus.js'))return {returnPanelFocus:()=>{}}
  if(id.endsWith('business-scope-context.js'))return {useBusinessScopes:()=>({general:'通用'})}
  if(id.endsWith('saved-collaboration-state.js'))return savedCollaborationState
  if(id.endsWith('saved-collaboration-drafts.js'))return {savedCollaborationDrafts:createSavedCollaborationDraftStore()}
  if(id.endsWith('team-presentation.js'))return {twinDisplayName:(name:string)=>name}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:'zh-Hans',t:rt,time:(value:string)=>value})}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:(_locale:string,cause:unknown)=>String(cause)}
  if(id.endsWith('group-message-refresh.js'))return {scheduleGroupMessageRefresh:()=>()=>{}}
  // 这两条是本轮的重点：真模块、真组件，不给空桩。
  if(id.endsWith('group-routing-view.js'))return groupRoutingView
  if(id.endsWith('GroupReactionBar.js'))return load('GroupReactionBar.tsx')
  // @deepseek-ai/dsh-client-ui-primitives 是 DSH 平台模块（运行时由宿主注入，katex.min.css/anser/shiki/mdast
  // 一串依赖只在宿主里有），Node 下 import 当场炸掉整个测试文件（详见 saved-message-markdown-stubs.ts）。
  // 这里换成只认 **加粗** 与 - 列表 两种语法的最小复刻，只为验证 SavedMessage 把 message.text 原样递给它、
  // 渲染出 strong/li 且不残留字面 **；不代表验证过真实 GFM 解析器本身。
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return {MarkdownText:testMarkdownText}
  throw Error('未声明的组件依赖：'+id)
 }
 const Component=load('SavedCollaborationPage.tsx').SavedCollaborationPage as (p:unknown)=>React.ReactNode
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
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 const textOf=(node:React.ReactNode):string=>{
  if(Array.isArray(node))return node.map(textOf).join('')
  if(React.isValidElement<Record<string,any>>(node)){
   if(typeof node.type==='function')return textOf((node.type as (p:unknown)=>React.ReactNode)(node.props))
   return textOf((node.props as {children?:React.ReactNode}).children)
  }
  return typeof node==='string'||typeof node==='number'?String(node):''
 }
 const flush=async()=>{for(let round=0;round<16;round++){await Promise.resolve();render()}return tree}
 return {render,flush,all:()=>expand(render()),text:()=>textOf(render()),
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match)}
}

const pageProps=(f:ReturnType<typeof viewFixture>)=>({visible:true,api:f.api,reactions:f.reactions,routing:f.routing,target:{groupId,rootId:messageId},roles:viewRoles,profileName:'我',directory:{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}})

test('真渲染·折叠行：只有一位同事在回复时逐字显示名字',async()=>{
 const root=selfMessage(messageId,fresh())
 const f=viewFixture({main:[root],replies:[root],decisions:[decision({respond:[roleA]})]})
 const app=mountPage(pageProps(f))
 await app.flush()
 assert.ok(app.text().includes('小张 正在回复…'),app.text())
 assert.ok(!app.text().includes("员工正在回复…"))
})

test('真渲染·折叠行：两位以上折叠成通用文案，展开后两个名字都在',async()=>{
 const root=selfMessage(messageId,fresh())
 const f=viewFixture({main:[root],replies:[root],decisions:[decision({respond:[roleA,roleB]})]})
 const app=mountPage(pageProps(f))
 await app.flush()
 const summaries=app.findAll(el=>el.type==='summary')
 assert.equal(summaries.length,1)
 assert.equal(app.text().includes('小张 正在回复…'),false,'折叠时不应逐个铺开命名行')
 assert.ok(app.text().includes("员工正在回复…"))
 const names=app.findAll(el=>el.type==='li').map(el=>String((el.props as {children?:unknown}).children))
 assert.deepEqual(names,['小张','小李'])
 // 展开语义交给原生 <details>；外面那层 role=status 让新出现的折叠行被读屏播报。
 assert.equal(app.findAll(el=>el.type==='div'&&el.props.role==='status'&&!!el.props.children).length>0,true)
})

test('真渲染·同事回帖的作者是群成员名与首字头像，来源收进可展开详情',async()=>{
 const reply=roleMessage('55555555-5555-4555-8555-555555555555',roleA,fresh())
 const f=viewFixture({main:[selfMessage(messageId,fresh())],replies:[selfMessage(messageId,fresh()),reply]})
 const app=mountPage(pageProps(f))
 await app.flush()
 const text=app.text()
 assert.ok(text.includes('小张'),text)
 assert.equal(text.includes('AI 员工'),false,'通用标签不再当名字用')
 assert.equal(text.includes('受管回传'),false,'技术来源不挤占作者行')
 assert.equal(app.findAll(el=>el.type==='details'&&String(el.props.className).includes('messageSource')).length,1)
 const avatars=app.findAll(el=>el.type==='text'&&String(el.props.className).includes('avText'))
 assert.ok(avatars.some(el=>String(el.props.children)==='小'),'共享头像取群成员名的首字')
})

test('真渲染·群里已经不在的成员回帖按「历史成员」兜底，界面上不出现 roleId',async()=>{
 const reply=roleMessage('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',fresh())
 const f=viewFixture({main:[selfMessage(messageId,fresh())],replies:[selfMessage(messageId,fresh()),reply]})
 const app=mountPage(pageProps(f))
 await app.flush()
 const text=app.text()
 assert.ok(text.includes('历史成员'),text)
 assert.equal(text.includes('77777777'),false,'界面上不出现内部身份')
})

test('真渲染·同事消息按 Markdown 渲染：**加粗**出 strong、- 列表出 li，不残留字面 **（2026-09-21 用户反馈修复）',async()=>{
 const reply=roleMessage('88888888-8888-4888-8888-888888888888',roleA,fresh(),'**加粗**\n\n- 列表')
 const f=viewFixture({main:[selfMessage(messageId,fresh())],replies:[selfMessage(messageId,fresh()),reply]})
 const app=mountPage(pageProps(f))
 await app.flush()
 const text=app.text()
 assert.ok(text.includes('加粗')&&text.includes('列表'),text)
 assert.equal(text.includes('**'),false,'不应残留字面 Markdown 标记')
 assert.equal(app.findAll(el=>el.type==='strong'&&String((el.props as {children?:unknown}).children)==='加粗').length,1)
 assert.equal(app.findAll(el=>el.type==='li'&&String((el.props as {children?:unknown}).children)==='列表').length,1)
})

test('真渲染·relay-stopped 那条消息下出现 stoppedHint，且不带任何「正在回复」',async()=>{
 const root=selfMessage(messageId,fresh())
 const f=viewFixture({main:[root],replies:[root],decisions:[decision({kind:'relay-stopped',respond:[],hops:6})]})
 const app=mountPage(pageProps(f))
 await app.flush()
 assert.ok(app.text().includes("员工之间已经连续接力 5 轮，中间没有你的发言。"))
 assert.equal(app.text().includes('正在回复'),false)
})

test('真渲染·表情写口的恢复面：pending 时两个按钮都在，丢弃后消失（修复轮 1 H2）',async()=>{
 const root=selfMessage(messageId,fresh())
 const f=viewFixture({main:[root],replies:[root],reactionPending:true})
 const app=mountPage(pageProps(f))
 await app.flush()
 const recoverButton=app.findAll(el=>el.type==='button'&&el.props['aria-label']==='team.detail.recoverMemory')
 assert.equal(recoverButton.length,1,'必须有一个核对未完成请求的按钮')
 const discardButtons=app.findAll(el=>el.type==='button'&&String((el.props as {children?:unknown}).children)==='recovery.discard')
 assert.equal(discardButtons.length,1)
 // 丢弃本地记录后未决请求消失，表情条重新可用（两个按钮一起退场）。
 ;(discardButtons[0]!.props as {onClick:()=>void}).onClick()
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='button'&&el.props['aria-label']==='team.detail.recoverMemory').length,0)
 assert.ok(app.text().includes('recovery.discarded'))
})

test('叠加层封顶取尾且话题优先：主目录 250 条 + 话题 3 条时话题 id 一个不丢（修复轮 1 M1）',async()=>{
 const root=selfMessage(messageId,fresh())
 const main=Array.from({length:250},(_,index)=>selfMessage('a'.repeat(7)+String(index).padStart(5,'0')+'-1111-4111-8111-111111111111',fresh()))
 const replies=[root,roleMessage('cccccccc-1111-4111-8111-111111111111',roleA,fresh())]
 const f=viewFixture({main,replies})
 const app=mountPage(pageProps(f))
 await app.flush()
 const last=f.routingCalls.at(-1)!
 assert.equal(last.ids.length,200)
 for(const message of replies)assert.ok(last.ids.includes(message.id),'话题消息必须全部在内：'+message.id)
 assert.ok(last.ids.includes(main.at(-1)!.id),'主目录最新一条必须在内')
 assert.equal(last.ids.includes(main[0]!.id),false,'主目录最旧一条应被截掉')
 assert.deepEqual(f.reactionCalls.filter(row=>row.endpoint==='list').at(-1)!.ids,last.ids,'表情与路由用同一份消息身份')
})

test('重开已有岗位会话也不自动发送身份正文',()=>{
 const frame=source('WorkbenchFrame.tsx')
 const openRole=frame.split('const openRoleConversation=')[1]!.split('const openTwinConversation=')[0]!
 assert.equal(openRole.includes('sendRoleIdentity'),false,'命中已有会话的那条路不许再发引导语')
 assert.ok(openRole.includes('if(!recent){'),'已有会话与无历史两支仍然分开')
 assert.doesNotMatch(frame,/\bsendRoleIdentity\b/)
})

test('新建岗位会话不自动发消息，照常清理创建意图并跳转；手动介绍是短请求',async()=>{
 const node=sourceNode('WorkbenchFrame.tsx',node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createWork')
  const calls:unknown[]=[],conversation={id:'conversation',sessionId:'created'},object={kind:'role',id:roleA,version:1,canStart:true}
  let current='previous'
  const create=implementation<(workspace:string,intent:unknown)=>Promise<void>>(node,{
   setCreating:(value:boolean)=>calls.push(['creating',value]),homeCreationLocation:()=> 'origin',latestState:{current:{}},
   resolveConversationObject:()=>object,homeContextApi:{pending:()=>undefined},persistentObject:()=>true,
   work:{create:async(options:{roleId?:string;beforeOpen:(row:unknown)=>Promise<void>;mayOpen:()=>boolean})=>{assert.equal(options.roleId,roleA);assert.equal(options.mayOpen(),true);await options.beforeOpen(conversation);current=conversation.sessionId;return conversation},getSnapshot:()=>({sessionId:current})},
   mergeObjectLinks:()=>{},ensureHomeObjectContext:async()=>({}),objectConversationApi:{},setConversationObject:()=>{},
   mayContinueHomeCreation:()=>true,mainSession:{getSnapshot:()=>current},
   sendRoleIdentity:async()=>{calls.push(['unexpected-send'])},
   localizeWorkError:(_locale:string,error:Error)=>error.message,locale:'zh-CN',
   setCreationIntent:(value:unknown)=>calls.push(['intent',value]),setWorkspaceSelection:(value:boolean)=>calls.push(['selection',value]),setCreationError:(value:unknown)=>calls.push(['creationError',value]),
   roleConversationIdentities:{fail:(sessionId:string,error:string)=>calls.push(['identityError',sessionId,error])},
   actions:{closeDetail:()=>{},openMessages:(mode:string)=>calls.push(['open',mode]),closeSidebar:()=>{}},window:{matchMedia:()=>({matches:false})},
  })
  await create('workspace',{object,resolve:(ok:boolean)=>calls.push(['resolved',ok])})
  assert.deepEqual(calls,[['creating',true],['resolved',true],['intent',null],['selection',false],['creationError',undefined],['open','native'],['creating',false]])
 const resendNode=sourceNode('WorkbenchFrame.tsx',node=>ts.isVariableDeclaration(node)&&node.name.getText()==='resendRoleIdentity') as ts.VariableDeclaration
 const sent:unknown[]=[]
 const resend=implementation<(id:string,sessionId:string)=>Promise<void>>(resendNode.initializer!,{tasksRef:{current:{roles:[{id:roleA,storage:'persistent'}]}},work:{getSnapshot:()=>({sessionId:'created'})},sendConversationMessage:(...args:unknown[])=>sent.push(args),t:(key:string)=>key==='role.conversation.introducePrompt'?'Please briefly describe your current role’s responsibilities and boundaries.':''})
 await resend(roleA,'created')
 assert.deepEqual(sent,[['created','Please briefly describe your current role’s responsibilities and boundaries.']])
})
