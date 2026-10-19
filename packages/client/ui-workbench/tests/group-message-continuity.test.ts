import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import * as React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import type {GroupRoutingStatusView} from '@teloa/contract'
import {createGroupApi} from '../src/client/group-api.ts'
import {createGroupRoutingApi} from '../src/client/group-routing-api.ts'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'
import {GROUP_CONTINUITY_MESSAGE_ROWS} from '../src/client/i18n/locales/group-continuity.ts'
import * as presentation from '../src/client/group-progress-presentation.ts'

// 状态行的额度说明复用 i18n/errors.ts：源码按 .js 引用同目录模块，测试按 .ts 源码解析。
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/ui-workbench/src/client/i18n/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {localizeWorkError}=await import('../src/client/i18n/errors.ts')
const {translateMessage}=await import('../src/client/i18n/messages.ts')

const groupId='11111111-1111-4111-8111-111111111111',replyId='55555555-5555-4555-8555-555555555555',messageId='66666666-6666-4666-8666-666666666666'
const roleId='33333333-3333-4333-8333-333333333333',taskId='77777777-7777-4777-8777-777777777777',at='2026-10-14T00:00:00.000Z'
function storage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)}}}

test('引用回复目标按群与输入入口持久保存；关闭预览只清引用，发送后随草稿清理；旧存储没有该键仍可读取',()=>{
 const persisted=storage(),store=createSavedCollaborationDraftStore(persisted)
 store.writeGroupDraftText(groupId,'main','这个数怎么来的？')
 store.writeGroupMentionDrafts(groupId,'main',[{roleId,expectedVersion:1}])
 store.writeGroupReplyDraft(groupId,'main',replyId)
 store.writeGroupReplyDraft(groupId,replyId,replyId)
 const reloaded=createSavedCollaborationDraftStore(persisted)
 assert.equal(reloaded.readGroupDraftEntry(groupId).replyDrafts.main,replyId,'刷新后保留引用目标')
 reloaded.writeGroupReplyDraft(groupId,'main',undefined)
 const closed=reloaded.readGroupDraftEntry(groupId)
 assert.equal(closed.replyDrafts.main,undefined)
 assert.equal(closed.drafts.main,'这个数怎么来的？','关闭引用预览不删除正文')
 assert.deepEqual(closed.mentionDrafts.main,[{roleId,expectedVersion:1}],'关闭引用预览不删除手动 @')
 assert.equal(closed.replyDrafts[replyId],replyId,'另一入口的引用不受影响')
 const sent=reloaded.readGroupDraftEntry(groupId)
 reloaded.writeGroupReplyDraft(groupId,replyId,messageId)
 assert.equal(reloaded.clearGroupSentDraft(groupId,replyId,sent),false,'发送期间改了引用目标时不清理新草稿')
 const current=reloaded.readGroupDraftEntry(groupId)
 assert.equal(reloaded.clearGroupSentDraft(groupId,replyId,current),true)
 assert.equal(reloaded.readGroupDraftEntry(groupId).replyDrafts[replyId],undefined)
 const legacy={getItem:()=>JSON.stringify({[groupId]:{drafts:{main:'旧草稿'},referenceDrafts:{},mentionDrafts:{}}}),setItem:()=>{}}
 assert.deepEqual(createSavedCollaborationDraftStore(legacy).readGroupDraftEntry(groupId).replyDrafts,{})
 assert.equal(createSavedCollaborationDraftStore(legacy).readGroupDraftEntry(groupId).drafts.main,'旧草稿')
})

test('发送携带引用与结构化全员；省略时请求与旧客户端逐字一致；回执丢失关系时保留恢复请求',async()=>{
 const calls:unknown[]=[]
 const reply=(payload:Record<string,unknown>,drop=false)=>({id:messageId,groupId,rootId:null,authorId:'self',text:payload.text,references:[],mentions:[],createdAt:at,...(drop?{}:{...(payload.replyToMessageId?{replyToMessageId:payload.replyToMessageId}:{}),...(payload.mentionAll?{mentionAll:true}:{})})})
 let drop=false
 const api=createGroupApi(async(endpoint,payload)=>{calls.push(payload);if(endpoint!=='groups/messages/send')throw Error('unexpected');return reply(payload as Record<string,unknown>,drop)})
 await api.send(groupId,1,'普通发言')
 assert.deepEqual(Object.keys(calls[0] as object).sort(),['expectedVersion','groupId','requestId','text'])
 const saved=await api.send(groupId,1,'@全员 接着说',undefined,undefined,undefined,{replyToMessageId:replyId,mentionAll:true})
 assert.equal('replyToMessageId' in saved&&saved.replyToMessageId,replyId)
 assert.deepEqual([(calls[1] as Record<string,unknown>).replyToMessageId,(calls[1] as Record<string,unknown>).mentionAll],[replyId,true])
 drop=true
 await assert.rejects(api.send(groupId,1,'关系被丢弃',undefined,undefined,undefined,{replyToMessageId:replyId}),/已保留恢复请求/)
 assert.equal(api.pending()?.kind,'send','回执与原请求不一致时保留原请求，不另发新消息')
})

const status=(patch:Partial<GroupRoutingStatusView>={}):GroupRoutingStatusView=>({messageId,attemptVersion:1,phase:'routing-failed',recipients:[],hintCode:'route-unavailable',canRetry:true,...patch})

test('处理状态只认服务端投影；重新安排只提交原消息身份与期望尝试，回执必须对应下一尝试',async()=>{
 const calls:Array<[string,unknown]>=[]
 let attempt=2
 const api=createGroupRoutingApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(endpoint==='groups/routing/status')return {items:[status()]};return {messageId,attemptVersion:attempt}})
 assert.deepEqual(await api.status(groupId,[messageId]),[status()])
 const requestId='88888888-8888-4888-8888-888888888888'
 assert.deepEqual(await api.retry({requestId,groupId,messageId,expectedAttempt:1,expectedGroupVersion:3}),{messageId,attemptVersion:2})
 assert.deepEqual(calls[1],['groups/routing/retry',{requestId,groupId,messageId,expectedAttempt:1,expectedGroupVersion:3}])
 attempt=5
 await assert.rejects(api.retry({requestId,groupId,messageId,expectedAttempt:1,expectedGroupVersion:3}),/不一致/)
 const leaky=createGroupRoutingApi(async()=>({items:[{...status(),hintCode:'Error: connect ECONNREFUSED'}]}))
 await assert.rejects(leaky.status(groupId,[messageId]),/格式不正确/,'原始异常不能作为提示进入界面')
 const foreign=createGroupRoutingApi(async()=>({items:[status({messageId:replyId})]}))
 await assert.rejects(foreign.status(groupId,[messageId]),/格式不正确/)
})

/** 真实组件函数 + 服务端渲染：断言可见文案与动作，不读内部身份。 */
/** 缺省按简体词条桩渲染；给出 locale 时用真实词典，核对简繁英定稿文案。 */
function loadStatusComponent(locale?:string){
 const text=new Map<string,string>(GROUP_CONTINUITY_MESSAGE_ROWS.map(row=>[row[0],row[1]] as [string,string]))
 text.set('collaboration.message.historicalMember','历史成员')
 const t=locale?(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key,params):(key:string,params?:Record<string,string|number>)=>(text.get(key)??key).replace(/\{(\w+)\}/g,(whole,name:string)=>params&&name in params?String(params[name]):whole)
 const require=(id:string):unknown=>{
  if(id==='react'||id==='react/jsx-runtime')return React
  if(id==='./DetailsMenu.js'){const code=ts.transpileModule(readFileSync(new URL('../src/client/DetailsMenu.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;const values:Record<string,any>={};new Function('require','exports','React',code)(require,values,React);return values}
  if(id==='./group-progress-presentation.js')return presentation
  if(id==='lucide-react')return {ExternalLink:()=>React.createElement('svg')}
  if(id==='./i18n/provider.js')return {useI18n:()=>({locale:locale??'zh-CN',t})}
  if(id==='./i18n/errors.js')return {localizeWorkError}
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  throw Error('未声明的组件依赖：'+id)
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/GroupMessageStatus.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={};new Function('require','exports','React',code)(require,exported,React)
 return exported.GroupMessageStatus as (props:Record<string,unknown>)=>React.ReactElement
}

test('状态行：路由失败给原因与重新安排；归档只读不给恢复；未知提交只给查看工作；不显示内部身份',()=>{
 const GroupMessageStatus=loadStatusComponent(),render=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(GroupMessageStatus,{archived:false,retrying:false,retryFailed:false,retry:()=>{},openTask:()=>{},...props}))
 const failed=render({status:status()})
 assert.match(failed,/未能安排回应/);assert.match(failed,/暂时无法判断由谁回应/);assert.match(failed,/>重新安排<\/button>/)
 assert.doesNotMatch(render({status:status(),archived:true}),/<button/,'归档群不给恢复动作')
 assert.match(render({status:status(),retrying:true}),/正在重新安排/)
 const unknown=render({status:status({phase:'unknown',hintCode:'delivery-unknown',canRetry:false,recipients:[{roleId,name:'售后',taskId,runId:null,phase:'unknown',resultMessageId:null,executionMode:null}]})})
 assert.match(unknown,/待核对/);assert.match(unknown,/不会重复安排/);assert.match(unknown,/查看工作/);assert.doesNotMatch(unknown,/重新安排<\/button>/)
 for(const id of [roleId,taskId,messageId])assert.ok(!unknown.includes(id),'界面不出现内部身份')
 const partial=render({status:status({phase:'running',hintCode:null,canRetry:false,recipients:[{roleId,name:'售后',taskId,runId:null,phase:'running',resultMessageId:null,executionMode:'work'},{roleId:replyId,name:'物流',taskId:null,runId:null,phase:'unavailable',resultMessageId:null,executionMode:null}]})})
 assert.doesNotMatch(partial,/售后：正在处理/,'进行中统一由输入附近的动态状态承载');assert.match(partial,/物流：暂无可回应的员工/,'不可用的点名对象逐位呈现，不被悄悄替换')
})

test('员工交接状态行：判定失败说明是交接并给重新安排，不建议本人改用 @ 手工派工；派出接手者后不再给恢复动作',()=>{
 const GroupMessageStatus=loadStatusComponent(),render=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(GroupMessageStatus,{archived:false,retrying:false,retryFailed:false,retry:()=>{},openTask:()=>{},...props}))
 for(const [hintCode,text] of [['handoff-unavailable',/暂时无法判断由谁接手这次交接/],['handoff-invalid',/交接的安排结果无法使用/]] as const){
  const html=render({status:status({hintCode})})
  assert.match(html,/未能安排回应/);assert.match(html,text);assert.match(html,/>重新安排<\/button>/);assert.doesNotMatch(html,/@ 一位员工/)
 }
 const handed=render({status:status({phase:'running',hintCode:null,canRetry:false,recipients:[{roleId,name:'调查员',taskId,runId:null,phase:'running',resultMessageId:null,executionMode:'work'}]})})
 assert.doesNotMatch(handed,/重新安排/);assert.match(handed,/aria-label="查看工作"/)
})

test('路由被工作额度拒绝：简繁英说明原因、范围与「工作额度」下一步，仍给重新安排；未知原因只给通用额度说明',()=>{
 const reasons={zh:/最近 24 小时上限/,hant:/最近 24 小時上限/,en:/last 24 hours/}
 for(const [locale,pattern] of [['zh-CN',reasons.zh],['zh-Hant',reasons.hant],['en',reasons.en]] as const){
  const GroupMessageStatus=loadStatusComponent(locale),render=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(GroupMessageStatus,{archived:false,retrying:false,retryFailed:false,retry:()=>{},openTask:()=>{},...props}))
  const html=render({status:status({hintCode:'budget-exhausted',budget:{reason:'elapsed',scope:'owner'}})})
  assert.match(html,pattern);assert.ok(html.includes(translateMessage(locale,'planWork.budget.owner')),locale)
  assert.ok(html.includes(translateMessage(locale,'planWork.budget.title')),locale);assert.match(html,new RegExp('>'+translateMessage(locale,'group.status.retry')+'</button>'))
  assert.doesNotMatch(html,new RegExp(translateMessage(locale,'group.status.hint.route-unavailable')))
  assert.ok(render({status:status({hintCode:'budget-exhausted'})}).includes(localizeWorkError(locale,{code:'teloa/budget-exhausted'})),locale+' 通用额度')
 }
})

test('交流和工作结束都收起重复完成清单，查看原工作仍可达',()=>{
 const GroupMessageStatus=loadStatusComponent(),render=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(GroupMessageStatus,{archived:false,retrying:false,retryFailed:false,retry:()=>{},openTask:()=>{},...props}))
 const recipient={roleId,name:'售后',taskId,runId:null,phase:'completed' as const,resultMessageId:replyId}
 for(const executionMode of ['reply','work'] as const){
  const html=render({status:status({phase:'completed',hintCode:null,canRetry:false,recipients:[{...recipient,executionMode}]})})
  assert.doesNotMatch(html,/已回应|已完成|role="status"/)
  assert.match(html,/aria-label="查看工作"/)
 }
})
