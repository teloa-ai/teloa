import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'

// 直接渲染本轮真实源码；只转译 TypeScript 和替换 CSS 类名，不依赖旧 lib 或运行包。
const sourceRoot=new URL('../src/',import.meta.url).href
registerHooks({
 resolve(specifier,context,next){
  if(context.parentURL?.startsWith(sourceRoot)&&specifier.startsWith('.')&&specifier.endsWith('.js'))for(const extension of ['.ts','.tsx']){const url=new URL(specifier.slice(0,-3)+extension,context.parentURL);if(existsSync(url))return {url:url.href,shortCircuit:true}}
  if(/\.(module\.css|svg|webp|png)$/.test(specifier))return {url:new URL(specifier,context.parentURL).href,shortCircuit:true}
  return next(specifier,context)
 },
 load(url,context,next){
  if(url.endsWith('.module.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}
  if(/\.(svg|webp|png)$/.test(url))return {format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}
  if(url.startsWith(sourceRoot)&&/\.tsx?$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{fileName:new URL(url).pathname,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText}
  return next(url,context)
 },
})
const {TaskPage}=await import('../src/client/TaskPage.tsx')
const {I18nProvider}=await import('../src/client/i18n/provider.tsx')
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const {emptyTaskPreview}=await import('../src/client/task-preview.ts')
const {projectSavedTask}=await import('../src/client/task-api.ts')
const {aggregateAttentionItems}=await import('../src/client/attention-item.ts')
const at='2026-10-30T00:00:00.000Z',task={id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',version:2,state:'running' as const,title:'审批发现验收',goal:'核对当前申请',scope:'general',groupId:null,skills:[],assigneeRoleId:'22222222-2222-4222-8222-222222222222',assigneeRoleVersion:1,createdAt:at,updatedAt:at},nativeApproval={runId:'33333333-3333-4333-8333-333333333333',sessionId:'approval-session'}
const noop=()=>{}
function paint(mode:'tasks'|'attention',locale:'zh-CN'|'zh-TW'|'en'='zh-CN',unknown=false){
 const state={...emptyTaskPreview(),tasks:[projectSavedTask(task)]},row={task,attention:null,...(unknown?{nativeApprovalUnknown:true as const}:{nativeApproval})}
 const attentionItems=aggregateAttentionItems({...state,taskAttention:[row],workAttention:[],securityAttention:[],handoffs:[],savedPlanIds:new Set(),bindings:[]})
 const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>noop,getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})}
 return renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(TaskPage,{state,mode,visible:true,selected:null,select:noop,change:noop,switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,conversations:()=>null,openArtifacts:noop,openPlans:noop,attentionItems,openAttention:noop,persistence:{directoryKnown:true,attention:{known:true,rows:[row]},handoffs:{rows:[]},loading:false,pendingFields:()=>undefined}} as never)))
}

test('实际任务页把原生审批显示为可点击需要你入口，执行状态仍是进行中',()=>{
 const html=paint('tasks')
 assert.match(html,/>进行中<\/span>/)
 assert.match(html,/<td[^>]*><button[^>]*class="tableLink"[^>]*>审批<\/button><\/td>/)
 assert.doesNotMatch(html,/<td>—<\/td>/)
})

test('实际需要你页显示原任务并提供原生会话入口，三语言文案可读',()=>{
 for(const locale of ['zh-CN','zh-TW','en'] as const){
  const html=paint('attention',locale)
  assert.match(html,/审批发现验收/)
  assert.doesNotMatch(html,/task\.attention\.reason\.nativeApproval|33333333-3333/)
 }
 assert.match(paint('tasks','zh-CN',true),/尚未核对/)
})
