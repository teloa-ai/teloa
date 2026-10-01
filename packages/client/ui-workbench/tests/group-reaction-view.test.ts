import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {contentOf,markdownPrimitivesStub,testUseMemo} from './saved-message-markdown-stubs.ts'
import * as contract from '@teloa/contract'
import type {GroupReactionActor,GroupReactionEmoji,GroupReactionSummary} from '@teloa/contract'
import {GROUP_REACTION_MESSAGE_ROWS} from '../src/client/i18n/locales/group-reaction.ts'

/**
 * 群内直接回应与表情一期 功能验证（2026-09-21）：消息下方的表情条（聚合 emoji+计数、mine 高亮、
 * 归档只读）与十二格表情浮层（固定集合、方向键+Enter+Esc、格子 onMouseDown）。
 * 零接线组件：本文件只喂 GroupReactionBar/GroupEmojiPicker 自己的 props，不经过
 * SavedCollaborationPage，不经过 jsdom；手法与 group-mention.test.ts / group-attachment-view.test.ts
 * 一致（真实运行组件函数与真实 effect 调度）。
 */

if(!('document' in globalThis))(globalThis as Record<string,unknown>).document={activeElement:null}
if(!('HTMLElement' in globalThis))(globalThis as Record<string,unknown>).HTMLElement=class{}

const messageId='11111111-1111-4111-8111-111111111111'
const roleId='22222222-2222-4222-8222-222222222222'

/** 词条按 zh-CN 逐字取用，跟 group-attachment-view.test.ts 的 t() 写法一致。 */
const reactionText=new Map<string,string>(GROUP_REACTION_MESSAGE_ROWS.map(row=>[row[0],row[1]] as [string,string]))
const t=(key:string,params?:Record<string,string|number>)=>{
 const text=reactionText.get(key)
 if(text===undefined)return params?key+':'+JSON.stringify(params):key
 return text.replace(/\{(\w+)\}/g,(whole,name:string)=>params&&name in params?String(params[name]):whole)
}

function summary(over:Partial<GroupReactionSummary> & {emoji:GroupReactionEmoji}):GroupReactionSummary{
 return {messageId,count:1,mine:false,actors:[],...over}
}

/** 执行真实组件函数与真实 effect 调度；嵌套的 GroupEmojiPicker 在 expand() 展开时按普通函数调用（与 SavedGroupTaskForm 等既有嵌套表单测试同一手法）。 */
function mount(exportName:'GroupReactionBar'|'GroupEmojiPicker',initial:Record<string,unknown>,stubs:{returnPanelFocus?:(opener:unknown,doc:unknown)=>void;locale?:string}={}){
 let props=initial
 const slots:unknown[]=[]
 let cursor=0,dirty=true,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 const effects=new Map<number,Effect>()
 let pending:Array<()=>void>=[]
 const hooks={...React,
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
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:cssProxy}
  if(id.endsWith('panel-focus.js'))return {returnPanelFocus:(opener:unknown,doc:unknown)=>{stubs.returnPanelFocus?.(opener,doc)}}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({locale:stubs.locale??'zh-Hans',t,time:(value:string)=>value})}
  // DSH 平台模块，Node 下装不起来，给透传桩（见 saved-message-markdown-stubs.ts）。
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return markdownPrimitivesStub
  throw Error('未声明的组件依赖：'+id)
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/GroupReactionBar.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,hooks)
 const Component=exported[exportName] as (props:Record<string,unknown>)=>React.ReactNode
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
 const expand=(node:React.ReactNode):React.ReactElement<Record<string,any>>[]=>{
  if(Array.isArray(node))return node.flatMap(expand)
  if(!React.isValidElement<Record<string,any>>(node))return []
  if(typeof node.type==='function')return expand((node.type as (p:unknown)=>React.ReactNode)(node.props))
  return [node,...expand((node.props as {children?:React.ReactNode}).children)]
 }
 return {
  render,flush,contentOf,
  all:()=>expand(render()),
  setProps:(patch:Record<string,unknown>)=>{props={...props,...patch};render()},
  find:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>{const matches=expand(render()).filter(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!},
  findAll:(match:(el:React.ReactElement<Record<string,any>>)=>boolean)=>expand(render()).filter(match),
 }
}

type App=ReturnType<typeof mount>
const byRole=(app:App,role:string)=>app.findAll(el=>el.props.role===role)
const barChip=(app:App,emoji:string)=>app.find(el=>el.type==='button'&&el.props.title!==undefined&&app.contentOf(el).includes(emoji))
const addButton=(app:App)=>app.find(el=>el.type==='button'&&el.props['aria-label']===t('group.reaction.add'))

test('聚合渲染：emoji + 计数分别可读；mine 为真时聚合按钮 aria-pressed 为真',()=>{
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'👍',count:3,mine:true})],archived:false,onToggle:async()=>{},roleNames:{}})
 const chip=barChip(app,'👍')
 assert.equal(app.contentOf(chip),'👍3')
 assert.equal(chip.props['aria-pressed'],true)
})

test('浮层恰十二格，顺序等于 groupReactionEmojis，没有搜索框、没有第十三个选项',()=>{
 const app=mount('GroupEmojiPicker',{onPick:()=>{},onClose:()=>{},labelKey:'group.reaction.pick'})
 const options=byRole(app,'option')
 assert.equal(options.length,12)
 assert.deepEqual(options.map(option=>app.contentOf(option)),[...contract.groupReactionEmojis])
 assert.equal(app.findAll(el=>el.type==='input').length,0,'不得有搜索框')
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(listbox.props['aria-label'],t('group.reaction.pick'))
})

test('浮层自带键盘处理：ArrowRight 移动一格、Enter 选中该格；Esc 关闭并触发 onClose；aria-activedescendant 随方向键指向当前 active 格',()=>{
 const picked:GroupReactionEmoji[]=[]
 let closed=0
 const app=mount('GroupEmojiPicker',{onPick:(emoji:GroupReactionEmoji)=>picked.push(emoji),onClose:()=>{closed+=1},labelKey:'group.reaction.pick'})
 const firstListbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 const firstOption=app.find(el=>el.props.role==='option'&&el.props['aria-selected']===true)
 assert.ok(firstOption.props.id,'每个 option 必须有 id 供 aria-activedescendant 指向')
 assert.equal(firstListbox.props['aria-activedescendant'],firstOption.props.id,'初始 activedescendant 必须指向第一格')
 firstListbox.props.onKeyDown({key:'ArrowRight',preventDefault:()=>{},stopPropagation:()=>{}})
 app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 const active=app.find(el=>el.props.role==='option'&&el.props['aria-selected']===true)
 assert.equal(app.contentOf(active),contract.groupReactionEmojis[1])
 assert.equal(listbox.props['aria-activedescendant'],active.props.id,'ArrowRight 后 activedescendant 必须跟着挪到新的 active 格')
 app.find(el=>el.type==='ul'&&el.props.role==='listbox').props.onKeyDown({key:'Enter',preventDefault:()=>{},stopPropagation:()=>{}})
 assert.deepEqual(picked,[contract.groupReactionEmojis[1]])
 app.find(el=>el.type==='ul'&&el.props.role==='listbox').props.onKeyDown({key:'Escape',preventDefault:()=>{},stopPropagation:()=>{}})
 assert.equal(closed,1)
})

test('浮层关闭兜底：onBlur（Tab 移出/点击外部）也会触发 onClose，格子的 onMouseDown+preventDefault 不受影响',()=>{
 let closed=0
 const app=mount('GroupEmojiPicker',{onPick:()=>{},onClose:()=>{closed+=1},labelKey:'group.reaction.pick'})
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 assert.equal(typeof listbox.props.onBlur,'function','浮层必须自带 onBlur 关闭兜底')
 listbox.props.onBlur()
 assert.equal(closed,1)
})

test('归档群只读：没有加表情按钮，聚合按钮 disabled',()=>{
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'👍',count:2})],archived:true,onToggle:async()=>{},roleNames:{}})
 assert.equal(app.findAll(el=>el.type==='button'&&el.props['aria-label']===t('group.reaction.add')).length,0)
 assert.equal(barChip(app,'👍').props.disabled,true)
})

test('点已有聚合按钮即 onToggle 同一个 emoji',()=>{
 const calls:GroupReactionEmoji[]=[]
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'👍',count:1})],archived:false,onToggle:async(emoji:GroupReactionEmoji)=>{calls.push(emoji)},roleNames:{}})
 barChip(app,'👍').props.onClick()
 assert.deepEqual(calls,['👍'])
})

test('actors 悬停提示用岗位名，不用 roleId',()=>{
 const actor:GroupReactionActor={actorKind:'role',actorId:roleId}
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'👍',count:1,mine:false,actors:[actor]})],archived:false,onToggle:async()=>{},roleNames:{[roleId]:'小张'}})
 const title=barChip(app,'👍').props.title as string
 assert.ok(title.includes('小张'),'悬停提示必须含岗位名')
 assert.ok(!title.includes(roleId),'悬停提示不得暴露 roleId')
})

test('actors 名单未凑满 count 时用「+N」占位，不新造叙述性中文短语',()=>{
 const actor:GroupReactionActor={actorKind:'role',actorId:roleId}
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'🎉',count:5,mine:false,actors:[actor]})],archived:false,onToggle:async()=>{},roleNames:{[roleId]:'小张'}})
 const title=barChip(app,'🎉').props.title as string
 assert.ok(title.includes('+4'),'count(5)-actors.length(1)=4 必须以 +4 呈现')
})

test('roleNames 没命中的 role actor 不回退显示 roleId：直接省略，计入 +N',()=>{
 const unknownId='33333333-3333-4333-8333-333333333333'
 const actor:GroupReactionActor={actorKind:'role',actorId:unknownId}
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'👀',count:1,mine:false,actors:[actor]})],archived:false,onToggle:async()=>{},roleNames:{}})
 const title=barChip(app,'👀').props.title as string
 assert.ok(!title.includes(unknownId),'没命中 roleNames 的 actor 不得回退显示 roleId')
 assert.ok(title.includes('+1'),'省略掉的这个 actor 必须并入 +N（count 1 − known 0 = 1）')
})

test('多个 actors 的姓名按 locale 用 Intl.ListFormat 拼接，不是写死的中文顿号',()=>{
 // 中文 narrow 与 join('、') 同串，钉不住「必须走 Intl.ListFormat」这条判据（两种实现在 zh-Hans 下无区分力）；
 // 换成 locale:'en' + 英文姓名：Intl.ListFormat('en',...) 恒为「A, B」（逗号+空格），
 // 若组件退化成硬编码顿号拼接会得到「A、B」，这条断言必须变红。
 const otherRoleId='44444444-4444-4444-8444-444444444444'
 const actors:GroupReactionActor[]=[{actorKind:'role',actorId:roleId},{actorKind:'role',actorId:otherRoleId}]
 const app=mount('GroupReactionBar',{messageId,items:[summary({emoji:'✅',count:2,mine:false,actors})],archived:false,onToggle:async()=>{},roleNames:{[roleId]:'Alice',[otherRoleId]:'Bob'}},{locale:'en'})
 const title=barChip(app,'✅').props.title as string
 const expected=new Intl.ListFormat('en',{type:'conjunction',style:'narrow'}).format(['Alice','Bob'])
 assert.equal(expected,'Alice, Bob','夹具假设核对：en 两项 narrow conjunction 必须是「A, B」这个形态')
 assert.ok(title.includes(expected),'姓名拼接必须与 Intl.ListFormat(locale) 的输出一致')
 assert.ok(!title.includes('Alice、Bob'),'不得退化成写死的中文顿号拼接')
})

test('失败时给出 role=alert 的固定文案：加表情→浮层选中→onToggle 失败',async()=>{
 const app=mount('GroupReactionBar',{messageId,items:[],archived:false,onToggle:async()=>{throw Error('x')},roleNames:{}})
 addButton(app).props.onClick({currentTarget:{}})
 app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 const firstOption=app.find(el=>el.props.role==='option'&&app.contentOf(el)===contract.groupReactionEmojis[0])
 firstOption.props.onMouseDown({preventDefault:()=>{}})
 await app.flush()
 const alert=app.find(el=>el.props.role==='alert')
 assert.ok(app.contentOf(alert).includes('表情没加上'))
 assert.equal(app.findAll(el=>el.type==='ul'&&el.props.role==='listbox').length,0,'选中后浮层必须收起')
})

test('Esc 关闭浮层：焦点交回打开它的那个按钮（event.currentTarget），不是当时的 document.activeElement',()=>{
 const focusCalls:unknown[][]=[]
 const opener={}
 const app=mount('GroupReactionBar',{messageId,items:[],archived:false,onToggle:async()=>{},roleNames:{}},{returnPanelFocus:(value,doc)=>focusCalls.push([value,doc])})
 addButton(app).props.onClick({currentTarget:opener})
 app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 listbox.props.onKeyDown({key:'Escape',preventDefault:()=>{},stopPropagation:()=>{}})
 app.render()
 assert.equal(app.findAll(el=>el.type==='ul'&&el.props.role==='listbox').length,0,'Esc 后浮层必须关闭')
 assert.equal(focusCalls.length,1)
 assert.equal(focusCalls[0]![0],opener,'焦点必须还给打开浮层的那个按钮')
})

test('浮层 onBlur（Tab 移出/点击外部）关闭后同样把焦点交回打开它的按钮',()=>{
 const focusCalls:unknown[][]=[]
 const opener={}
 const app=mount('GroupReactionBar',{messageId,items:[],archived:false,onToggle:async()=>{},roleNames:{}},{returnPanelFocus:(value,doc)=>focusCalls.push([value,doc])})
 addButton(app).props.onClick({currentTarget:opener})
 app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 listbox.props.onBlur()
 app.render()
 assert.equal(app.findAll(el=>el.type==='ul'&&el.props.role==='listbox').length,0,'onBlur 后浮层必须关闭')
 assert.equal(focusCalls.length,1)
 assert.equal(focusCalls[0]![0],opener,'焦点必须还给打开浮层的那个按钮')
})

test('选中一个表情关闭浮层后同样把焦点交回打开它的按钮',async()=>{
 const focusCalls:unknown[][]=[]
 const opener={}
 const app=mount('GroupReactionBar',{messageId,items:[],archived:false,onToggle:async()=>{},roleNames:{}},{returnPanelFocus:(value,doc)=>focusCalls.push([value,doc])})
 addButton(app).props.onClick({currentTarget:opener})
 app.render()
 const listbox=app.find(el=>el.type==='ul'&&el.props.role==='listbox')
 const option=app.find(el=>el.props.role==='option'&&app.contentOf(el)===contract.groupReactionEmojis[0])
 assert.ok(listbox)
 option.props.onMouseDown({preventDefault:()=>{}})
 await app.flush()
 assert.equal(app.findAll(el=>el.type==='ul'&&el.props.role==='listbox').length,0,'选中后浮层必须收起')
 assert.equal(focusCalls.length,1)
 assert.equal(focusCalls[0]![0],opener,'焦点必须还给打开浮层的那个按钮')
})

test('组件源码全树零 dangerouslySetInnerHTML',()=>{
 const source=readFileSync(new URL('../src/client/GroupReactionBar.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})
