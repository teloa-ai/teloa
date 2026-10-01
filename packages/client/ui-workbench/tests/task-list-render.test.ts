import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {PreviewTask} from '../src/client/task-preview.ts'
import type {TaskRowAttention} from '../src/client/task-list-presentation.ts'

// 与 attention-decision-card.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {TaskList}=await import('../lib/types/client/TaskList.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

const task=(id:string,patch:Partial<PreviewTask>={}):PreviewTask=>({id,title:'任务 '+id,goal:'',scope:'general',object:'对象',version:1,state:'ready',need:null,request:'',authorId:'me',assigneeId:'me',assigneeHistory:[],createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'security.risk.low'},execution:'not_started',...patch} as PreviewTask)
const none:TaskRowAttention={kinds:[],reason:null}
const row=(item:PreviewTask,patch:Partial<{attention:TaskRowAttention;unverified:boolean}>={})=>({task:item,attention:none,ownerName:'本人',scopeLabel:'通用工作',unverified:false,...patch})
const routed=(id:string)=>task(id,{source:{groupId:'g',messageId:'m',rootId:'r',text:'',trigger:'routed'}})
const rows=[row(task('f1')),row(task('f2',{storage:'persistent'}),{unverified:true}),row(routed('r1')),row(routed('r2')),row(routed('r3'))]
const props={filter:'all' as const,selected:null as string|null,select:()=>{},stateLabel:(state:PreviewTask['state'])=>state,attentionLabel:(kind:string)=>kind,stamp:(at:string)=>at}

test('两条正式加三条群内回应：正式行两个 option，群组折成一个收起按钮',()=>{
  const html=render(createElement(TaskList,{...props,rows}))
  assert.equal(html.match(/aria-expanded="false"/g)?.length,1)
  assert.match(html,/群内回应 · 3 条/)
  assert.equal(html.match(/role="option"/g)?.length,2)
  assert.match(html,/role="listbox"[^>]*aria-label="任务列表"/)
})

test('只看正式时没有群组按钮',()=>{
  const html=render(createElement(TaskList,{...props,rows,filter:'formal'}))
  assert.doesNotMatch(html,/aria-expanded/)
  assert.doesNotMatch(html,/群内回应/)
  assert.equal(html.match(/role="option"/g)?.length,2)
})

test('表头恰五列：任务/负责人/状态/需要你/更新时间',()=>{
  const html=render(createElement(TaskList,{...props,rows}))
  assert.deepEqual([...html.matchAll(/<th>([^<]*)<\/th>/g)].map(match=>match[1]),['任务','负责人','状态','需要你','更新时间'])
})

test('打开详情后只保留三列，群分组也跨三列，避免隐藏列仍挤占任务名称',()=>{
 const html=render(createElement(TaskList,{...props,rows,selected:'f1'}))
 assert.deepEqual([...html.matchAll(/<th>([^<]*)<\/th>/g)].map(match=>match[1]),['任务','负责人','状态'])
 assert.match(html,/<td colSpan="3">/)
 assert.doesNotMatch(html,/<td colSpan="5">/)
 assert.match(html,/尚未核对/)
})

test('选中行 aria-selected 且 tabIndex 0，其它 -1；持久且未核对的行显示尚未核对',()=>{
  const html=render(createElement(TaskList,{...props,rows,selected:'f2'}))
  const options=[...html.matchAll(/<tr[^>]*role="option"[^>]*>/g)].map(match=>match[0])
  assert.equal(options.length,2)
  const selectedRow=options.find(line=>line.includes('data-teloa-entry="f2"'))!
  assert.match(selectedRow,/aria-selected="true"/)
  assert.match(selectedRow,/tabindex="0"/)
  const otherRow=options.find(line=>line.includes('data-teloa-entry="f1"'))!
  assert.match(otherRow,/aria-selected="false"/)
  assert.match(otherRow,/tabindex="-1"/)
  assert.match(html,/尚未核对/)
})

test('无选中时首行可 Tab 进入；有关注原因的行置顶并标记 listPinned',()=>{
  const html=render(createElement(TaskList,{...props,rows:[row(task('f1')),row(task('f2'),{attention:{kinds:['approval'],reason:'approval'}})]}))
  const options=[...html.matchAll(/<tr[^>]*role="option"[^>]*>/g)].map(match=>match[0])
  assert.match(options[0]!,/data-teloa-entry="f2"/)
  assert.match(options[0]!,/listPinned/)
  assert.match(options[0]!,/tabindex="0"/)
  assert.match(options[1]!,/tabindex="-1"/)
})

test('英文列表将内部本机任务标签翻译为 Local task，不改业务对象原文',()=>{
  const englishRuntime={...runtime,t:(key:string,params?:Record<string,string|number>)=>translateMessage('en',key as never,params),getSnapshot:()=>({locale:'en' as const,dshLocale:'en',revision:1})}
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:englishRuntime as never},createElement(TaskList,{...props,rows:[{...row(task('local',{storage:'persistent',object:'本机任务'})),scopeLabel:'Security operations'},{...row(task('business',{storage:'persistent',object:'客户的业务对象'})),scopeLabel:'Security operations'}]})))
  assert.match(html,/Security operations · Local task/)
  assert.doesNotMatch(html,/本机任务/)
  assert.match(html,/客户的业务对象/)
})
