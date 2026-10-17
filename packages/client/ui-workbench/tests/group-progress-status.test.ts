import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import * as React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import type {GroupRecipientStatus,GroupRoutingStatusView} from '@teloa/contract'
import * as presentation from '../src/client/group-progress-presentation.ts'
import {GROUP_CONTINUITY_MESSAGE_ROWS} from '../src/client/i18n/locales/group-continuity.ts'

const messageId='66666666-6666-4666-8666-666666666666',otherMessage='99999999-9999-4999-8999-999999999999'
const roleA='33333333-3333-4333-8333-333333333333',roleB='44444444-4444-4444-8444-444444444444',roleC='55555555-5555-4555-8555-555555555555'
const taskA='77777777-7777-4777-8777-777777777777',taskB='88888888-8888-4888-8888-888888888888'
const person=(roleId:string,name:string,phase:GroupRecipientStatus['phase'],patch:Partial<GroupRecipientStatus>={}):GroupRecipientStatus=>({roleId,name,taskId:null,runId:null,phase,resultMessageId:null,executionMode:'reply',...patch})
const status=(patch:Partial<GroupRoutingStatusView>={}):GroupRoutingStatusView=>({messageId,attemptVersion:1,phase:'running',recipients:[],hintCode:null,canRetry:false,...patch})

/** 真实组件函数 + 服务端渲染：断言可见文案、动作与可读区域，不读内部身份。 */
function load(){
 const text=new Map<string,string>(GROUP_CONTINUITY_MESSAGE_ROWS.map(row=>[row[0],row[1]] as [string,string]))
 text.set('collaboration.message.historicalMember','历史成员')
 const t=(key:string,params?:Record<string,string|number>)=>(text.get(key)??key).replace(/\{(\w+)\}/g,(whole,name:string)=>params&&name in params?String(params[name]):whole)
 const require=(id:string):unknown=>{
  if(id==='react'||id==='react/jsx-runtime')return React
  if(id==='./DetailsMenu.js'){const code=ts.transpileModule(readFileSync(new URL('../src/client/DetailsMenu.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;const values:Record<string,any>={};new Function('require','exports','React',code)(require,values,React);return values}
  if(id==='./i18n/provider.js')return {useI18n:()=>({t})}
  if(id==='./group-progress-presentation.js')return presentation
  if(id==='lucide-react')return {ExternalLink:()=>React.createElement('svg',{'data-icon':'external'})}
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  throw Error('未声明的组件依赖：'+id)
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/GroupMessageStatus.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={};new Function('require','exports','React',code)(require,exported,React)
 const message=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(exported.GroupMessageStatus,{archived:false,retrying:false,retryFailed:false,retry:()=>{},openTask:()=>{},...props}))
 const progress=(statuses:GroupRoutingStatusView[])=>renderToStaticMarkup(React.createElement(exported.GroupProgressStatus,{statuses,avatar:(item:{name:string})=>React.createElement('b',null,item.name.slice(0,1))}))
 return {message,progress}
}

test('阶段分层：进行中只聚合，需要关注的留在原消息，完成与记录静默',()=>{
 for(const phase of ['received','routing','queued','running','delivering','stopping'] as const)assert.equal(presentation.groupStatusTone(phase),'active')
 for(const phase of ['awaiting-approval','awaiting-review','routing-failed','unavailable','blocked','unknown','paused','stopped'] as const)assert.equal(presentation.groupStatusTone(phase),'attention')
 for(const phase of ['completed','recorded'] as const)assert.equal(presentation.groupStatusTone(phase),'quiet')
})

test('聚合行：交流显示正在回复，工作显示正在处理；排队不冒充正在回复，没有逐字信号不称正在输入',()=>{
 const {progress}=load()
 const statuses=[
  status({messageId:otherMessage,phase:'queued',recipients:[person(roleC,'财务','queued')]}),
  status({recipients:[person(roleA,'售后','running'),person(roleB,'物流','running'),person(roleC,'财务','queued')]}),
 ]
 const html=progress(statuses)
 assert.match(html,/role="status"/);assert.match(html,/aria-live="polite"/)
 assert.match(html,/售后、物流/);assert.doesNotMatch(html,/ \+1|财务/,'排队员工不混入正在回复名单');assert.match(html,/正在回复/)
 assert.doesNotMatch(html,/财务/);assert.doesNotMatch(html,/正在输入/)
 const arranging=progress([status({phase:'routing'})])
 assert.doesNotMatch(arranging,/正在安排|正在处理|正在输入|progressPhase/,'等待安排时没有可见的内部过程文案')
 assert.match(arranging,/progressDots/,'只留轻量动态点')
 assert.match(arranging,/<span class="progressSrOnly">已收到，等待回应<\/span>/,'读屏如实说明已收到、在等回应')
 const queued=progress([status({phase:'queued',recipients:[person(roleA,'售后','queued')]})])
 assert.match(queued,/progressAvatars/);assert.match(queued,/售后/);assert.match(queued,/已收到，等待回应/)
 assert.doesNotMatch(queued,/正在安排|正在处理|progressPhase|progressSeparator/)
 assert.equal(presentation.groupProgressPresentation([status({recipients:[person(roleA,'售后','running')]}),status({messageId:otherMessage,recipients:[person(roleA,'售后','running')]})])?.people.length,1,'同一员工只算一次')
 assert.match(progress([status({phase:'delivering',recipients:[person(roleA,'','delivering')]})]),/历史成员[\s\S]*正在发送回复/)
 assert.match(progress([status({recipients:[person(roleA,'售后','running',{executionMode:'work'})]})]),/售后[\s\S]*正在处理/)
 assert.match(progress([status({phase:'delivering',recipients:[person(roleA,'售后','delivering',{executionMode:'work'})]})]),/正在交付结果/)
 const mixed=progress([status({recipients:[person(roleA,'售后','running'),person(roleB,'物流','running',{executionMode:'work'})]})])
 assert.match(mixed,/progressDots/);assert.doesNotMatch(mixed,/progressPhase|正在回复|正在处理/,'混合或未知执行模式只用动态点，不给员工贴错阶段')
})

test('所有终态退出动态显示；live region 常驻但为空，重载后按投影准确恢复',()=>{
 const {progress}=load()
 for(const phase of ['completed','recorded','routing-failed','unavailable','blocked','unknown','paused','stopped','awaiting-approval','awaiting-review'] as const){
  const html=progress([status({phase,recipients:[person(roleA,'售后',phase)]})])
  assert.doesNotMatch(html,/售后|progressDots/,`${phase} 不保留动态状态`)
  assert.match(html,/role="status"/,'空的可读区域保持挂载，后续真实变化才播报')
 }
 // 同一投影再次渲染文案逐字一致：没有计时器或计数文本，不会反复播报。
 const once=[status({recipients:[person(roleA,'售后','running')]})]
 assert.equal(progress(once),progress(structuredClone(once)))
 assert.equal(progress([]),progress([status({phase:'completed',recipients:[person(roleA,'售后','completed')]})]))
 // 整体仍需本人确认、但另一位员工仍在运行：确认留在原消息，运行中的那位仍在聚合行。
 const mixed=[status({phase:'awaiting-approval',recipients:[person(roleA,'售后','awaiting-approval'),person(roleB,'物流','running')]})]
 assert.match(progress(mixed),/物流[\s\S]*正在回复/);assert.doesNotMatch(progress(mixed),/售后/)
})

test('原消息：进行中不再逐人堆阶段；交流回应完成后只留查看工作图标，不写已完成或已回应',()=>{
 const {message}=load()
 assert.equal(message({status:status({recipients:[person(roleA,'售后','running'),person(roleB,'物流','queued')]})}),'','进行中且无工作入口时原消息下没有状态块')
 const running=message({status:status({recipients:[person(roleA,'售后','running',{taskId:taskA,executionMode:'work'})]})})
 assert.doesNotMatch(running,/正在处理|role="status"/);assert.match(running,/aria-label="查看工作"/,'进行中的原工作入口保留为紧凑图标')
 const replied=message({status:status({phase:'completed',recipients:[person(roleA,'售后','completed',{taskId:taskA,resultMessageId:otherMessage})]})})
 assert.doesNotMatch(replied,/已完成|已回应|售后：/);assert.match(replied,/aria-label="查看工作"/);assert.doesNotMatch(replied,/role="status"/,'静默行不进入播报')
 const two=message({status:status({phase:'completed',recipients:[person(roleA,'售后','completed',{taskId:taskA,executionMode:'work'}),person(roleB,'物流','completed',{taskId:taskB,executionMode:'work'})]})})
 assert.match(two,/查看 售后 的工作/);assert.match(two,/查看 物流 的工作/,'多份工作各自按原归属打开')
 assert.equal(message({status:status({phase:'completed',recipients:[person(roleA,'售后','completed')]}),openTask:undefined}),'')
 assert.equal(message({status:status({phase:'recorded'})}),'' ,'只记录的消息保持安静，不替用户判断无需处理')
})

test('原消息：失败、未知提交、等待授权、部分不可用仍可读；重试只按服务端条件且归档禁用',()=>{
 const {message}=load()
 const failed=message({status:status({phase:'routing-failed',hintCode:'route-unavailable',canRetry:true})})
 assert.match(failed,/role="status"/);assert.match(failed,/未能安排回应/);assert.match(failed,/暂时无法判断由谁回应/);assert.match(failed,/>重新安排<\/button>/)
 assert.doesNotMatch(message({status:status({phase:'routing-failed',hintCode:'route-unavailable',canRetry:true}),archived:true}),/<button/,'归档群不给重新安排')
 assert.doesNotMatch(message({status:status({phase:'routing-failed',hintCode:'route-unavailable',canRetry:false})}),/重新安排<\/button>/,'服务端未判定可重试时不给按钮')
 assert.match(message({status:status({phase:'routing-failed',canRetry:true}),retrying:true}),/正在重新安排…/)
 assert.match(message({status:status({phase:'routing-failed',canRetry:true}),retryFailed:true}),/role="alert"[^>]*>未能重新安排/)
 const unknown=message({status:status({phase:'unknown',hintCode:'delivery-unknown',recipients:[person(roleA,'售后','unknown',{taskId:taskA,executionMode:null})]})})
 assert.match(unknown,/待核对/);assert.match(unknown,/不会重复安排/);assert.match(unknown,/<button[^>]+aria-label="查看工作"[^>]*><svg/);assert.doesNotMatch(unknown,/重新安排<\/button>/)
 const approval=message({status:status({phase:'awaiting-approval',recipients:[person(roleA,'售后','awaiting-approval',{taskId:taskA,executionMode:'work'})]})})
 assert.match(approval,/需要你确认/);assert.match(approval,/<button[^>]+aria-label="查看工作"[^>]*><svg/)
 const partial=message({status:status({recipients:[person(roleA,'售后','running',{taskId:taskA,executionMode:'work'}),person(roleB,'物流','unavailable')]})})
 assert.match(partial,/物流：暂无可回应的员工/,'不可用的点名对象逐位呈现，不被悄悄替换');assert.doesNotMatch(partial,/售后：/,'运行中的人交给聚合行')
 assert.match(partial,/<button[^>]+aria-label="查看工作"[^>]*><svg/,'运行中那位的原工作入口仍在')
 const owned=message({status:status({phase:'paused',hintCode:'work-paused',recipients:[person(roleA,'售后','paused',{taskId:taskA,executionMode:'work'}),person(roleB,'物流','stopped',{taskId:taskB,executionMode:'work'})]})})
 assert.match(owned,/售后：已暂停/);assert.match(owned,/物流：已停止/);assert.match(owned,/查看 售后 的工作/);assert.match(owned,/查看 物流 的工作/)
 for(const html of [failed,unknown,approval,partial,owned])for(const id of [roleA,roleB,taskA,taskB,messageId])assert.ok(!html.includes(id),'界面不出现内部身份')
})

test('新增词条简繁英齐全，交流状态不再使用已回应的完成口径',()=>{
 const rows=new Map<string,readonly string[]>(GROUP_CONTINUITY_MESSAGE_ROWS.map(row=>[row[0],row] as const))
 for(const key of ['group.progress.waiting','group.progress.people.two','group.status.openWorkOf'])assert.ok(rows.get(key)?.slice(1).every(value=>value.length>0),key)
 assert.ok(!rows.has('group.status.phase.replied'))
 assert.ok(!rows.has('group.progress.arranging'),'内部过程文案「正在安排回应」已退出')
 for(const row of GROUP_CONTINUITY_MESSAGE_ROWS)assert.doesNotMatch(row.slice(1).join(),/正在输入|正在輸入|typing/i)
})
