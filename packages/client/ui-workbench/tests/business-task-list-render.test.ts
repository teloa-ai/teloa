import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {BusinessTaskListState} from '../src/client/business-task-list.ts'

// 与现有任务列表测试一致：实际 tsc 组件产物配 CSS 类名代理，无浏览器或网络。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {BusinessTaskList,BusinessTaskListView}=await import('../lib/types/client/BusinessTaskList.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const props={object:false,openTask:()=>{},refresh:()=>{},more:()=>{}}
const task={id:'task-one',ownerId:'owner',title:'真实任务标题',scope:'sales',version:2,state:'waiting' as const,assigneeRoleId:'role-one',assigneeRoleVersion:1,createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T01:00:00.000Z'}
const ready:BusinessTaskListState={phase:'ready',items:[{task,source:null,progress:null,completion:null}],loadingMore:false}
const render=(state:BusinessTaskListState,extra:Partial<Parameters<typeof BusinessTaskListView>[0]>={})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessTaskListView,{...props,state,...extra})))

test('实际组件展示真实状态和负责人，任务/成果共用原任务入口，不伪造成果内容',()=>{
 const html=render(ready,{roleName:id=>id==='role-one'?'客户负责人':undefined})
 assert.match(html,/真实任务标题/);assert.match(html,/客户负责人/)
 assert.match(html,new RegExp(translateMessage('zh-CN','status.waiting')))
 assert.match(html,/查看任务与成果/);assert.doesNotMatch(html,/查看来源对象|启动|派发|创建任务|成果已完成/)
 assert.match(html,/<time dateTime="2026-09-29T01:00:00.000Z"/)
})

test('同一正式业务页区分未执行、Run结束待验收与固定版本成果',()=>{
 const waiting={...task,id:'task-waiting',state:'waiting' as const}
 const completed={...task,id:'task-completed',state:'completed' as const}
 const state:BusinessTaskListState={phase:'ready',loadingMore:false,items:[
  {task:{...task,id:'task-idle'},source:null,progress:null,completion:null},
  {task:waiting,source:null,progress:{runId:'run-waiting',state:'ended',reason:'completed',stopRequestedAt:null},completion:null},
  {task:completed,source:null,progress:{runId:'run-completed',state:'ended',reason:'completed',stopRequestedAt:null},completion:{artifactId:'artifact-accepted',version:1,title:'本人验收初版',completedAt:'2026-09-29T02:00:00.000Z'}},
 ]}
 const html=render(state,{openArtifact:()=>{}})
 assert.match(html,/尚未执行/);assert.match(html,/待本人验收/)
 assert.match(html,/本人验收初版/);assert.match(html,/第 1 版/);assert.match(html,/查看成果/)
 assert.doesNotMatch(html,/artifact-accepted|run-waiting|run-completed/,'页面只显示可读摘要，不泄漏内部身份或正文')
 const withoutPort=render(state);assert.doesNotMatch(withoutPort,/查看成果/);assert.match(withoutPort,/查看任务与成果/)
})

test('无负责人/不可见岗位诚实展示，不把当前业务负责人冒充任务负责人',()=>{
 assert.match(render(ready),/role-one/)
 assert.match(render({...ready,items:[{task:{...task,assigneeRoleId:null,assigneeRoleVersion:null},source:null,progress:null,completion:null}]}),/还没有负责人/)
})

test('只有真实来源且宿主提供导航才显示对象入口',()=>{
 const source={schema:'teloa.business-task-source/v1' as const,taskId:task.id,ownerId:'owner',sourceId:'local-configuration',reference:{scope:'sales',type:'customer',id:'one',version:2,snapshotHash:'a'.repeat(64)},createdAssignee:null,createdAt:task.createdAt}
 const state={...ready,items:[{task,source,progress:null,completion:null}]}
 assert.doesNotMatch(render(state),/查看来源对象/)
 assert.match(render(state,{object:true,openSource:()=>{}}),/对象相关任务/)
 assert.match(render(state,{openSource:()=>{}}),/查看来源对象/)
})

test('加载、失败、空目录和分页各有可访问反馈，错误不显示旧任务',()=>{
 assert.match(render({phase:'loading',items:[],loadingMore:false}),/role="status"/)
 const error=render({phase:'failed',items:[],loadingMore:false})
 assert.match(error,/role="alert"/);assert.match(error,/重试/);assert.doesNotMatch(error,/暂无相关任务|真实任务标题/)
 assert.match(render({...ready,items:[]}),/暂无相关任务/)
 assert.match(render({...ready,nextCursor:'next'}),/加载更多任务/)
 assert.match(render({...ready,nextCursor:'next',loadingMore:true}),/disabled=""/)
})

test('实际容器初始为加载面，SSR 不调用任务 API 或触发任何动作',()=>{
 let calls=0
 const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessTaskList,{scope:'sales',api:{list:async()=>{calls++;return {items:[]}}},openTask:()=>{calls++}})))
 assert.equal(calls,0);assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/暂无相关任务/)
})
