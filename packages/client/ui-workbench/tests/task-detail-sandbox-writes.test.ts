import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// 真实 TaskDetail 走 tsc 产物；CSS Modules 只替换类名。页头菜单只在打开后才渲染菜单项，静态渲染拿不到，
// 这里把 ObjectPageHeader 换成把 menu 直接铺开的桩，只为核对 TaskDetail 交给菜单的条目。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}
  :url.endsWith('/lib/types/client/ObjectPageHeader.js')?{format:'module',shortCircuit:true,source:"import {createElement as h} from 'react';export function ObjectPageHeader(props){return h('header',null,h('h2',null,props.title),h('div',{role:'menu'},...(props.menu??[]).map(item=>h('button',{key:item.id,type:'button',role:'menuitem','data-teloa-menu-item':item.id,disabled:item.disabled},item.label))))}"}
  :next(url,context),
})
const {TaskDetail}=await import('../lib/types/client/TaskDetail.js')
const {readTaskInputs}=await import('../lib/types/client/task-inputs.js')
const {emptyBusinessPreview}=await import('../lib/types/client/business-preview.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const noop=()=>{}
const now='2026-09-21T04:30:00.000Z'
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const base={id:'task-1',title:'季度安全审计',goal:'核对全部外部访问记录。',scope:'general',object:'审计',version:3,need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:now,updatedAt:now,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'task.approval.risk.none'},execution:'not_started'}
const paint=(task:Record<string,unknown>)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(TaskDetail as never,{
 attentionNeeds:task.need?[task.need]:[],attention:undefined,attentionReason:undefined,securityItems:[],securityActions:null,industrySource:null,executions:()=>null,knowledge:null,handoffs:null,handoffRows:[],
 conversations:()=>null,draft:readTaskInputs({},task as never),patch:noop,clear:noop,review:noop,openArtifacts:noop,openPlans:noop,
 task,approvals:[],artifacts:[],change:noop,back:noop,backHidden:false,openSource:noop,roles:[],team:noop,openRole:noop,business:emptyBusinessPreview(),openBusiness:noop,saveTemplate:noop,
} as never)))

test('沙盒就绪任务：··· 菜单里有「开始任务」；持久就绪任务没有（开始由状态框主按钮覆盖）',()=>{
 const sandbox=paint({...base,state:'ready'})
 assert.match(sandbox,/<button[^>]*role="menuitem"[^>]*data-teloa-menu-item="start"[^>]*>开始任务/)
 const persistent=paint({...base,storage:'persistent',state:'ready',assigneeId:'role-1'})
 assert.doesNotMatch(persistent,/data-teloa-menu-item="start"/)
 assert.match(persistent,/data-teloa-menu-item="template"/)
 assert.match(paint({...base,storage:'persistent',state:'ready'}),/data-teloa-menu-item="start"/,'本人负责的真实任务保留手动开始入口')
})

test('沙盒运行中任务：状态框里有「记录结果并完成」表单；持久运行中任务没有',()=>{
 const sandbox=paint({...base,state:'running'})
 assert.match(sandbox,/data-teloa-status-box[\s\S]*<form[^>]*>[\s\S]*<textarea[\s\S]*记录结果并完成/)
 const persistent=paint({...base,storage:'persistent',state:'running'})
 assert.doesNotMatch(persistent,/记录结果并完成/)
 assert.doesNotMatch(persistent,/data-teloa-menu-item="start"/)
})

test('沙盒没有运行面时不提供空跳转；持久任务保留运行主按钮',()=>{
 for(const state of ['running','waiting','blocked','ready']){
  const task={...base,state,assigneeId:'role-1'}
  assert.doesNotMatch(paint(task),/data-teloa-primary/,state)
  assert.match(paint({...task,storage:'persistent'}),/data-teloa-primary/,state)
 }
 assert.match(paint({...base,state:'paused'}),/data-teloa-primary/,'恢复任务仍可执行')
})

test('沙盒未处理需求或待审批任务不能从菜单直接开始',()=>{
 for(const patch of [{need:'materials'},{approvalRequired:true}])assert.doesNotMatch(paint({...base,state:'ready',...patch}),/data-teloa-menu-item="start"/)
})
