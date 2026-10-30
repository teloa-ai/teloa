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
const routed=(id:string)=>task(id,{source:{groupId:'g',messageId:'m',rootId:'r',text:'',trigger:'routed',executionMode:'reply'}})
const rows=[row(task('f1')),row(task('f2',{storage:'persistent'}),{unverified:true}),row(routed('r1')),row(routed('r2')),row(routed('r3'))]
const props={filter:'all' as const,selected:null as string|null,select:()=>{},stateLabel:(state:PreviewTask['state'])=>state,attentionLabel:(kind:string)=>kind,stamp:(at:string)=>at}

test('两条正式加三条群内回应：正式行保留原生表格与按钮语义，群组折成一个收起按钮',()=>{
  const html=render(createElement(TaskList,{...props,rows}))
  assert.equal(html.match(/aria-expanded="false"/g)?.length,1)
  assert.match(html,/群内回应 · 3 条/)
  assert.equal(html.match(/data-teloa-task-open/g)?.length,2)
  assert.match(html,/<table aria-label="任务列表"/)
  assert.doesNotMatch(html,/role="(?:listbox|option)"/)
})

test('只看正式时没有群组按钮',()=>{
  const html=render(createElement(TaskList,{...props,rows,filter:'formal'}))
  assert.doesNotMatch(html,/aria-expanded/)
  assert.doesNotMatch(html,/群内回应/)
  assert.equal(html.match(/data-teloa-task-open/g)?.length,2)
})

test('筛选隐藏当前任务时首个可见任务仍能 Tab 进入',()=>{
 const html=render(createElement(TaskList,{...props,rows,selected:'r1'}))
 const buttons=[...html.matchAll(/<button[^>]*data-teloa-task-open[^>]*>/g)].map(match=>match[0])
 assert.doesNotMatch(buttons[0]!,/tabindex="-1"/)
 assert.doesNotMatch(buttons[1]!,/tabindex="-1"/)
 assert.doesNotMatch(buttons.join(''),/aria-current/)
})

test('表头恰五列：任务/负责人/状态/需要你/更新时间',()=>{
  const html=render(createElement(TaskList,{...props,rows}))
  assert.deepEqual([...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map(match=>match[1]),['任务','负责人','状态','需要你','更新时间'])
})

test('打开详情后负责人并入任务单元，状态单列，完整姓名不会挤成几字',()=>{
 const html=render(createElement(TaskList,{...props,rows,selected:'f1'}))
 assert.deepEqual([...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map(match=>match[1]),['任务','状态'])
 assert.match(html,/<td colSpan="2">/)
 assert.doesNotMatch(html,/<td colSpan="5">/)
 assert.match(html,/尚未核对/)
 const named=render(createElement(TaskList,{...props,rows:[{...row(task('long')),ownerName:'开发验收·资料编辑已保存'}],selected:'long'}))
 assert.match(named,/<span class="rowOwner"[^>]*>开发验收·资料编辑已保存<\/span>/)
})

test('当前任务按钮 aria-current，所有原生按钮均可 Tab 进入；持久且未核对的行显示尚未核对',()=>{
  const html=render(createElement(TaskList,{...props,rows,selected:'f2'}))
  const options=[...html.matchAll(/<button[^>]*data-teloa-task-open[^>]*>/g)].map(match=>match[0])
  assert.equal(options.length,2)
  const selectedRow=options.find(line=>line.includes('title="任务 f2"'))!
  assert.match(selectedRow,/aria-current="page"/)
  assert.doesNotMatch(selectedRow,/tabindex="-1"/)
  const otherRow=options.find(line=>line.includes('title="任务 f1"'))!
  assert.doesNotMatch(otherRow,/aria-current/)
  assert.doesNotMatch(otherRow,/tabindex="-1"/)
  assert.match(html,/尚未核对/)
})

test('无选中时首行可 Tab 进入；有关注原因的行置顶并标记 listPinned',()=>{
  const html=render(createElement(TaskList,{...props,rows:[row(task('f1')),row(task('f2'),{attention:{kinds:['approval'],reason:'approval'}})]}))
  const options=[...html.matchAll(/<button[^>]*data-teloa-task-open[^>]*>/g)].map(match=>match[0])
  assert.match(options[0]!,/title="任务 f2"/)
  assert.match(html,/<tr[^>]*class="[^"]*listPinned[^>]*data-teloa-entry="f2"/)
  assert.doesNotMatch(options[0]!,/tabindex="-1"/)
  assert.doesNotMatch(options[1]!,/tabindex="-1"/)
})

test('英文列表将内部本机任务标签翻译为 Local task，不改业务对象原文',()=>{
  const englishRuntime={...runtime,t:(key:string,params?:Record<string,string|number>)=>translateMessage('en',key as never,params),getSnapshot:()=>({locale:'en' as const,dshLocale:'en',revision:1})}
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:englishRuntime as never},createElement(TaskList,{...props,rows:[{...row(task('local',{storage:'persistent',object:'本机任务'})),scopeLabel:'Security operations'},{...row(task('business',{storage:'persistent',object:'客户的业务对象'})),scopeLabel:'Security operations'}]})))
  assert.match(html,/Security operations · Local task/)
  assert.doesNotMatch(html,/本机任务/)
  assert.match(html,/客户的业务对象/)
})
