import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// 真实组件走 tsc 产物；CSS Modules 只替换类名，不模拟组件行为。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {ContinuousPage}=await import('../lib/types/client/ContinuousPage.js')
const {emptyTaskPreview}=await import('../lib/types/client/task-preview.js')
const {withRoleExamples}=await import('../lib/types/client/role-preview.js')
const {withContinuousExamples}=await import('../lib/types/client/continuous-work.js')
const {writeDirectoryFilterCategory}=await import('../lib/types/client/workbench-navigation-state.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const noop=()=>{}
const now='2026-09-11T04:30:00Z'
const example=()=>withContinuousExamples({...emptyTaskPreview(),roles:withRoleExamples([],now)},now)
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const paint=(props:Record<string,unknown>={})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(ContinuousPage as never,{
 state:emptyTaskPreview(),target:{kind:'plans'},visible:true,seed:null,clearSeed:noop,openArtifacts:noop,openMarket:noop,go:noop,change:()=>emptyTaskPreview(),examples:noop,openTask:noop,openRole:noop,openBusiness:noop,team:noop,attention:noop,openWork:noop,...props,
} as never)))
const directory=(html:string)=>html.slice(html.indexOf('<aside'),html.indexOf('</aside>'))
const navigation=(query='',scope='all',planStatus='all')=>({state:{query,category:writeDirectoryFilterCategory({scope,planStatus,runStatus:'all'})},change:noop})

test('自动化列表标题独立，空目录不展示无效筛选，执行记录和新建入口仍可达',()=>{
 const html=paint(),list=directory(html)
 assert.match(html,/<h1>自动化<\/h1>/)
 assert.match(html,/按时间或事件执行/)
 assert.match(html,/每次执行会创建任务并记录结果/)
 assert.match(html,/结果需要继续处理时，可创建跟进任务/)
 assert.doesNotMatch(html,/aria-current="page">自动化/)
 assert.doesNotMatch(html,/>任务<\/button>/)
 assert.match(html,/>执行记录<\/button>/)
 assert.match(html,/新建沙盒计划/)
 // 右侧空态仍说明此处查看已保存的自动化和执行记录。
 assert.match(html,/查看已保存的自动化及其执行记录/)
 assert.match(list,/还没有自动化/)
 assert.doesNotMatch(list,/<input|<select|查看全部自动化/)
})

test('有数据时搜索、业务和状态筛选组成同一工具栏，保留真实条目',()=>{
 const state=example(),list=directory(paint({state}))
 const toolbar=list.slice(list.indexOf('class="directoryFilters"'),list.indexOf('class="rows"'))
 assert.match(toolbar,/aria-label="搜索计划、执行或对象"/)
 assert.equal((toolbar.match(/<select /g)||[]).length,2)
 assert.ok(list.includes(state.continuous.plans[0]!.fields.title))
 assert.doesNotMatch(list,/查看全部自动化|重置筛选/)
})

test('搜索零结果仍保留输入和重置入口，不伪称尚未创建自动化',()=>{
 const list=directory(paint({state:example(),navigation:navigation('不存在的自动化')}))
 assert.match(list,/value="不存在的自动化"/)
 assert.match(list,/没有匹配的结果/)
 assert.match(list,/重置筛选/)
 assert.doesNotMatch(list,/还没有自动化|查看全部自动化/)
})

test('空数据也保留恢复的业务/状态筛选和重置入口',()=>{
 const list=directory(paint({navigation:navigation('','SOC','archived')}))
 assert.match(list,/value="SOC" selected=""/)
 assert.match(list,/value="archived" selected=""/)
 assert.match(list,/没有匹配的结果/)
 assert.match(list,/重置筛选/)
})

test('岗位入口限制无结果时仍能恢复全部目录',()=>{
 const list=directory(paint({target:{kind:'plans',roleId:'missing-role'}}))
 assert.match(list,/重置筛选/)
 assert.match(list,/没有匹配的结果/)
})

test('正式目录保留加载状态和恢复提醒，页面示例不混入正式计划',()=>{
 const html=paint({state:example(),persistence:{plans:[],api:{recoveryMessage:()=> '计划恢复失败',pending:()=>null},merge:noop,refreshRoles:noop,industrySource:noop}})
 assert.match(html,/role="alert"/)
 assert.match(html,/role="status"/)
 assert.doesNotMatch(directory(html),/data-teloa-entry=|<input|<select/)
})
