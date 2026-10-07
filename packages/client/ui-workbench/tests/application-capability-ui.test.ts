import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import {createElement,Fragment} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {applicationPresentation,type WorkCapability} from '../src/client/application-presentation.ts'

// 本批不构建固定核心：直接在内存转译实际 UI 源码，不读取旧的 ui-workbench/lib。
const sourceRoot=new URL('../src/',import.meta.url).href
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@deepseek-ai/dsh-client-ui-primitives')return {url:'teloa-test-stub:markdown-text',shortCircuit:true}
  if(context.parentURL?.startsWith(sourceRoot)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
   for(const extension of ['.ts','.tsx']){const url=new URL(specifier.slice(0,-3)+extension,context.parentURL);if(existsSync(url))return {url:url.href,shortCircuit:true}}
  }
  if(specifier.endsWith('.module.css')||/\.(svg|jpg)$/.test(specifier))return {url:new URL(specifier,context.parentURL).href,shortCircuit:true}
  return next(specifier,context)
 },
 load(url,context,next){
  if(url==='teloa-test-stub:markdown-text')return {format:'module',shortCircuit:true,source:'export const MarkdownText=({text})=>text'}
  if(url.endsWith('.module.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}
  if(/\.(svg|jpg)$/.test(url))return {format:'module',shortCircuit:true,source:'export default "fixture-asset"'}
  if(url.startsWith(sourceRoot)&&/\.tsx?$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{fileName:new URL(url).pathname,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText}
  return next(url,context)
 },
})
const {CapabilityNotice,CapabilityFields}=await import('../src/client/CapabilityNotice.tsx')
const {SessionCapabilityNotice}=await import('../src/client/SessionCapabilityNotice.tsx')
const {SavedGroupForm}=await import('../src/client/SavedCollaborationPage.tsx')
const {RoleLifecycle}=await import('../src/client/RoleLifecycle.tsx')
const {RoleDetail}=await import('../src/client/TeamPage.tsx')
const {ContinuousPage}=await import('../src/client/ContinuousPage.tsx')
const {TwinDraftEditor}=await import('../src/client/TwinDraftEditor.tsx')
const {I18nProvider}=await import('../src/client/i18n/provider.tsx')
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const {emptyTaskPreview}=await import('../src/client/task-preview.ts')
const {emptyCollaboration}=await import('../src/client/collaboration-preview.ts')
const {mount,nodes}=await import('./market-component-harness.ts')
const {APPLICATION_CAPABILITY_MESSAGE_ROWS}=await import('../src/client/i18n/locales/application-capabilities.ts')
const noop=()=>{},zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const runtime={t:zh,subscribe:()=>noop,getSnapshot:()=>({locale:'zh-CN',dshLocale:'zh',revision:1})}
const render=(component:any,props:any)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(component,props)))
const rights=(allowed:boolean)=>({schema:'teloa.application-capabilities/v1',capabilities:{'general-agent':true,'parallel-agents':allowed,groups:allowed,people:allowed,automation:allowed},reason:allowed?null:'subscription-expired'})
const identity={schema:'teloa.application-presentation/v1',product:'Pro',account:{displayName:'ML',email:'private@example.test'}}
const configure=()=>applicationPresentation.configure({presentation:async()=>identity,openAccount:async()=>{},capabilities:async()=>rights(false)})
const button=(html:string,label:string)=>{const match=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match=>match[2]!.replace(/<[^>]*>/g,'')===label);assert.ok(match,'missing button '+label);return match[1]!}
const role={id:'employee',name:'调查员',kind:'employee',scopes:['general'],state:'active',version:2,duty:'核对证据',dataScope:'本人资料',executionScope:'经批准的任务',skills:[],knowledge:[],memories:[],history:[]}
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const group={id:'group',name:'已有工作组',scope:'general',announcement:'原公告',rules,pinned:false,archived:false,version:1,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}
const groupProps={form:{kind:'change',snapshot:{group,members:[{roleId:null},{roleId:'employee'}]}},roles:[role],profileName:'ML',close:noop,save:noop,error:undefined}

test('社区不显示订阅提示；商业到期显示只读和基础 Agent，不泄露邮箱或自动打开购买',async()=>{
 await applicationPresentation.configure()
 assert.equal(render(CapabilityNotice,{capability:'groups'}),'')
 let opened=0
 const close=await applicationPresentation.configure({presentation:async()=>identity,openAccount:async()=>{opened++},openSubscription:async()=>{opened++},capabilities:async()=>rights(false)})
 try{const html=render(CapabilityNotice,{capability:'groups'});assert.match(html,/高级权益已到期/);assert.match(html,/基础 Agent 仍可使用/);assert.match(html,/查看 Pro 订阅/);assert.doesNotMatch(html,/private@example/);assert.equal(opened,0)}finally{close()}
 for(const row of APPLICATION_CAPABILITY_MESSAGE_ROWS){assert.equal(row.length,11);for(const value of row)assert.ok(value.trim())}
})

test('高级表单原生 disabled 边界保留原内容，取消在边界外可用；社区仍可保存',async()=>{
 const close=await configure()
 try{
  const html=render(SavedGroupForm,groupProps)
  assert.match(html,/value="已有工作组"/);assert.match(html,/disabled=""/)
  assert.match(button(html,zh('collaboration.form.saveSettings')),/disabled/)
  assert.doesNotMatch(button(html,zh('collaboration.form.cancel')),/disabled/)
  const fields=render(Fragment,{children:[createElement(CapabilityFields,{capability:'groups',children:createElement('input',{value:'保留草稿',readOnly:true})}),createElement('button',{type:'button'},'取消')]})
  assert.match(fields,/<fieldset[^>]*disabled/);assert.match(fields,/保留草稿/);assert.match(fields,/<\/fieldset><button type="button">取消/)
 }finally{close()}
 const html=render(SavedGroupForm,groupProps);assert.doesNotMatch(button(html,zh('collaboration.form.saveSettings')),/disabled/)
})

test('员工只读时禁止指派、编辑和恢复，停止、撤销及历史入口保持可用',async()=>{
 const close=await configure(),api={pending:undefined,error:undefined,change:async()=>{},recover:async()=>{}}
 try{
  const active=render(RoleLifecycle,{role,api});assert.doesNotMatch(button(active,zh('roleLifecycle.pause')),/disabled/);assert.doesNotMatch(button(active,zh('roleLifecycle.retire')),/disabled/)
  const paused=render(RoleLifecycle,{role:{...role,state:'paused'},api});assert.match(button(paused,zh('roleLifecycle.resume')),/disabled/);assert.doesNotMatch(button(paused,zh('roleLifecycle.retire')),/disabled/)
  const html=render(RoleDetail,{work:{},resourceApi:{},memoryApi:undefined,persistence:undefined,conversations:()=>null,talk:async()=>true,input:{draft:undefined,editing:false},update:noop,role,state:{...emptyTaskPreview(),roles:[role]},collaboration:emptyCollaboration(),change:noop,back:noop,openTask:noop,openGroup:noop,resources:noop,nativeSettings:noop,capabilities:()=>null,plans:()=>null})
  assert.match(html,/调查员/);assert.match(button(html,zh('team.profile.action.assign')),/disabled/);assert.match(button(html,zh('team.action.edit')),/disabled/);assert.doesNotMatch(button(html,zh('team.profile.action.chat')),/disabled/)
  const draft=render(TwinDraftEditor,{role:{...role,kind:'twin'},input:{version:2,body:'本人未保存原稿'},update:noop,save:()=>true});assert.match(draft,/readonly=""/);assert.match(draft,/本人未保存原稿/);assert.match(button(draft,zh('twinDraft.save')),/disabled/)
 }finally{close()}
})

test('自动化目录仍可浏览历史，创建按钮显示只读；升级后同一入口恢复',async()=>{
 const props={visible:true,state:emptyTaskPreview(),target:{kind:'plans'},go:noop,change:()=>emptyTaskPreview(),openTask:noop,openRole:noop,openBusiness:noop,team:noop,attention:noop,openArtifacts:noop,seed:null,clearSeed:noop,openMarket:noop}
 const close=await configure()
 try{const html=render(ContinuousPage,props);assert.match(button(html,zh('continuous.action.createSandbox')),/disabled/);assert.doesNotMatch(button(html,zh('continuous.tab.runs')),/disabled/);assert.match(html,/高级权益已到期/)}finally{close()}
 assert.doesNotMatch(button(render(ContinuousPage,props),zh('continuous.action.createSandbox')),/disabled/)
})

test('群编辑中实时到期保留未保存输入，旧提交回调不会再写入，取消仍可用',async()=>{
 let push!:(value:unknown)=>void,saved=0,cancelled=0
 const close=await applicationPresentation.configure({presentation:async()=>identity,openAccount:async()=>{},capabilities:async()=>rights(true),subscribeCapabilities:listener=>{push=listener;return noop}})
 try{
  const mounted=mount('SavedCollaborationPage.tsx',{'./CapabilityNotice.js':{useApplicationCapability:(capability:WorkCapability)=>applicationPresentation.can(capability),CapabilityNotice,CapabilityFields},'./application-presentation.js':{applicationPresentation},'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用'})}})
  const props={...groupProps,save:()=>{saved++},close:()=>{cancelled++}}
  let tree=mounted.render('SavedGroupForm',props)
  const name=nodes(tree).find(node=>node.type==='input'&&node.props.maxLength===80)!
  name.props.onChange({target:{value:'本人未保存原稿'}})
  tree=mounted.render('SavedGroupForm',props)
  const oldSubmit=nodes(tree).find(node=>node.type==='form')!.props.onSubmit
  push(rights(false));tree=mounted.render('SavedGroupForm',props)
  assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props.maxLength===80)!.props.value,'本人未保存原稿')
  assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props.type==='submit')!.props.disabled,true)
  oldSubmit({preventDefault(){}});await Promise.resolve();assert.equal(saved,0)
  const cancel=nodes(tree).find(node=>node.type==='button'&&node.children.includes('collaboration.form.cancel'))!;assert.equal(cancel.props.disabled,false);cancel.props.onClick();assert.equal(cancelled,1)
 }finally{close()}
})

test('原生历史输入 dock 使用可信分类显示只读及主动订阅，未知分类提示核对，切会话不留旧提示',async()=>{
 const close=await configure()
 let state={sessionId:'employee-session',status:'ready',requiredCapabilities:['general-agent','people'],deniedCapability:'people'}
 const reader={getSnapshot:()=>state,subscribe:()=>noop},props={sessionId:'employee-session',reader,i18n:runtime}
 try{
  const html=render(SessionCapabilityNotice,props);assert.match(html,/高级权益已到期/);assert.match(html,/查看 Pro 订阅/);assert.doesNotMatch(html,/private@example/)
  state={...state,status:'unavailable',requiredCapabilities:null as never,deniedCapability:undefined as never}
  const unavailable=render(SessionCapabilityNotice,props);assert.match(unavailable,/暂时无法核对/);assert.match(unavailable,/核对账号/)
  assert.equal(render(SessionCapabilityNotice,{...props,sessionId:'another-session'}),'')
 }finally{close()}
})
