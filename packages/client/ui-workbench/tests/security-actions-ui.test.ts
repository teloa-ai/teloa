import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readFile,readdir} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import {action,panel,execution,taskId,owner} from './security-action-fixtures.ts'
import {securityActionControls,securityExecutionPresentation} from '../src/client/security-action-presentation.ts'
import {confirmTargetMatches,securityDecisionStage,securityExecutionChecks,securityJournalLocks} from '../src/client/attention-decision.ts'
// 依据区的渲染由 evidence-list.test.ts 盯；这里只需要卡片能装配出它，映射仍走真实实现。
import {securityActionEvidence} from '../src/client/security-action-evidence.ts'
import * as decisionReasonDrafts from '../src/client/decision-reason-drafts.ts'
// G9 静态断言与决策卡的真实渲染：.tsx 走 tsc 产物，CSS Modules 换成类名代理，和 attention-decision-card.test.ts 同样的取巧。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {SecurityDecisionActions}=await import('../lib/types/client/SecurityDecisionActions.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const i18nRuntime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
type Node={type:unknown;props:Record<string,any>;children:Node[]}
const transpile=(file:string)=>ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
function load(){
 const js=transpile('SecurityActions.tsx')
 const states:unknown[]=[],effects:Array<()=>void>=[];let cursor=0
 const React={createElement:(type:unknown,props:Record<string,unknown>|null,...children:Node[])=>({type,props:props??{},children:children.flat(Infinity)}),useState:(initial:unknown)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[i],(v:unknown)=>{states[i]=typeof v==='function'?(v as (old:unknown)=>unknown)(states[i]):v}]},useRef:(v:unknown)=>{const i=cursor++;return states[i]??(states[i]={current:v})},useEffect:(f:()=>void)=>effects.push(f)}
 const exports:Record<string,any>={}
 // 执行门与审批表单是两个入口共用的真实组件，不许拿桩糊过去：面板的“执行”“批准/拒绝”现在都长在它们里面。
 const gate:Record<string,any>={},form:Record<string,any>={}
 const require=(id:string)=>id==='react'?React:id.endsWith('SecurityExecutionGate.js')?gate:id.endsWith('SecurityDecisionForm.js')?form:id.endsWith('decision-reason-drafts.js')?decisionReasonDrafts:id.endsWith('attention-decision.js')?{securityDecisionStage,securityJournalLocks,securityExecutionChecks,confirmTargetMatches}:id.endsWith('security-action-presentation.js')?{securityActionControls,securityExecutionPresentation}:id.endsWith('security-action-evidence.js')?{securityActionEvidence}:id.endsWith('EvidenceList.js')?{EvidenceList:()=>null}:id.endsWith('security-action-api.js')?{securityActionCommands:['propose','submit','decide','withdraw-submission','withdraw-approval','execute','observe','acknowledge-failure']}:id.endsWith('provider.js')?{useI18n:()=>({locale:'zh-CN',t:(key:string)=>key,dateTime:(v:string)=>v})}:id.endsWith('errors.js')?{localizeWorkError:(_:string,e:{code:string})=>e.code}:{default:new Proxy({},{get:(_,key)=>String(key)})}
 new Function('require','exports','React',transpile('SecurityExecutionGate.tsx'))(require,gate,React)
 new Function('require','exports','React',transpile('SecurityDecisionForm.tsx'))(require,form,React)
 new Function('require','exports','React',js)(require,exports,React)
 return {
  exports,render:(name:string,props:unknown)=>{cursor=0;return exports[name](props) as Node},effects,
  /** 桩 React 不会自己渲染子组件；把树里的某个子组件就地展开成它自己的节点。 */
  expand:(root:Node,name:string)=>{
   const found=nodes(root).find(n=>typeof n.type==='function'&&(n.type as Function).name===name)
   return found?(found.type as (props:unknown)=>Node)(found.props):undefined
  },
 }
}
function nodes(root:Node):Node[]{return root&&typeof root==='object'?[root,...root.children.flatMap(n=>Array.isArray(n)?n.flatMap(nodes):nodes(n))]:[]}
const text=(node:Node):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
/** 面板的“执行”长在共用执行门里，“批准/拒绝”长在共用审批表单里；按钮要连它们一起找。 */
const button=(ui:ReturnType<typeof load>,tree:Node,label:string)=>{
 const gate=ui.expand(tree,'SecurityExecutionGate'),form=ui.expand(tree,'SecurityDecisionForm')
 return [...nodes(tree),...(gate?nodes(gate):[]),...(form?nodes(form):[])].find(n=>n.type==='button'&&text(n)===label)
}
test('真实按钮分别绑定提交、批准、拒绝、撤回、执行、核对和失败知悉',async()=>{
 const ui=load(),calls:string[]=[]
 const render=(state:typeof action.state,executions:typeof panel.executions=[])=>ui.render('SecurityActionCard',{action:{...action,state},panel:{...panel,actions:[{...action,state}],executions},attention:[{taskId,actionId:action.id,kind:'security-action',reason:'execution-required'}],known:true,busy:false,disabled:false,run:async(kind:string)=>{calls.push(kind)},repropose:()=>calls.push('propose')})
 for(const [state,label,command] of [['proposed','security.submit','submit'],['pending_approval','security.withdraw','withdraw-submission'],['approved','security.withdraw','withdraw-approval'],['approved','security.execute','execute'],['failed','security.acknowledge','acknowledge-failure'],['failed','security.repropose','propose']] as const){
  const found=button(ui,render(state),label);assert.ok(found,label);await found.props.onClick()
  assert.equal(calls.at(-1),command)
 }
 const observing=nodes(render('effect_unknown',[execution])).find(n=>n.type==='button'&&text(n)==='security.observe')!;assert.ok(observing);await observing.props.onClick();assert.equal(calls.at(-1),'observe')
 // “批准/拒绝”长在共用审批表单里，得先展开它再摸输入框。
 const draftForm=ui.expand(render('pending_approval'),'SecurityDecisionForm')!,inputs=nodes(draftForm).filter(n=>n.type==='textarea'||n.type==='input')
 inputs.find(n=>n.type==='textarea')!.props.onChange({target:{value:'已核对影响'}})
 inputs.find(n=>n.props.type==='checkbox')!.props.onChange({target:{checked:true}})
 const approved=nodes(ui.expand(render('pending_approval'),'SecurityDecisionForm')!).find(n=>n.type==='button'&&text(n)==='security.approve')!;assert.equal(approved.props.disabled,false);await approved.props.onClick();assert.equal(calls.at(-1),'decide')
})
test('未确认影响不能批准；目录未知不呈现执行；固定摘要为空不伪造',()=>{
 const ui=load(),props={action:{...action,state:'pending_approval'},panel,attention:[],known:false,busy:false,disabled:false,run:async()=>{},repropose:()=>{}}
 const tree=ui.render('SecurityActionCard',props)
 const draftForm=ui.expand(tree,'SecurityDecisionForm')!
 assert.equal(nodes(draftForm).find(n=>n.type==='button'&&text(n)==='security.approve')?.props.disabled,true)
 assert.equal(nodes(ui.render('SecurityActionCard',{...props,action})).some(n=>text(n)==='security.execute'),false)
 assert.ok(text(ui.render('SecurityActionCard',{...props,action:{...action,state:'proposed',frozen:null}})).includes('security.unfrozen'))
})
test('详情表单和卡片经真实组件路由到正确 API，写后刷新 panel 与全局目录',async()=>{
 const ui=load(),calls:string[]=[],api:any={list:async()=>{calls.push('list');return panel},pending:()=>undefined,recoveryError:()=>undefined}
 for(const method of ['submit','decide','withdrawSubmission','withdrawApproval','execute','observe','acknowledgeFailure','propose'])api[method]=async()=>{calls.push(method)}
 const props={taskId,taskVersion:1,api,sourceApi:{source:async()=>({reference:{type:'alert',id:'alert-1',version:1,snapshotHash:action.frozen!.objectSnapshotHash}})},attention:[{taskId,actionId:action.id,kind:'security-action',reason:'execution-required'}],attentionKnown:true,invalidateAttention:()=>calls.push('invalidate'),changed:async()=>{calls.push('attention')}}
 ui.render('SecurityActions',props);ui.effects[0]!();await new Promise(resolve=>setImmediate(resolve))
 const tree=ui.render('SecurityActions',props),card=nodes(tree).find(n=>typeof n.type==='function'&&(n.type as Function).name==='SecurityActionCard')!
 assert.ok(card)
 await card.props.run('execute',action);assert.deepEqual(calls.slice(-4),['invalidate','execute','attention','list'])
})
test('固定来源 hash 不一致不能开放写入口；读失败保留旧面板并关闭执行',async()=>{
 const ui=load();let mode='ready'
 const api:any={list:async()=>{if(mode==='error')throw {code:'teloa/dependency-unavailable'};return mode==='wrong'?{...panel,actions:[{...action,frozen:{...action.frozen!,objectSnapshotHash:'f'.repeat(64)}}]}:panel},pending:()=>undefined,recoveryError:()=>undefined}
 const props={taskId,taskVersion:1,api,sourceApi:{source:async()=>({reference:{scope:'SOC',type:'alert',id:'alert-1',version:1,snapshotHash:action.frozen!.objectSnapshotHash}})},attention:[],attentionKnown:true,invalidateAttention:()=>{},changed:async()=>{}}
 ui.render('SecurityActions',props);ui.effects[0]!();await new Promise(resolve=>setImmediate(resolve))
 const card=(root:Node)=>nodes(root).find(n=>typeof n.type==='function'&&(n.type as Function).name==='SecurityActionCard')!
 assert.equal(card(ui.render('SecurityActions',props)).props.known,true)
 mode='wrong';nodes(ui.render('SecurityActions',props)).find(n=>n.type==='button'&&text(n)==='taskExecution.refresh')!.props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(card(ui.render('SecurityActions',props)).props.known,false)
 mode='error';nodes(ui.render('SecurityActions',props)).find(n=>n.type==='button'&&text(n)==='taskExecution.refresh')!.props.onClick();await new Promise(resolve=>setImmediate(resolve))
 const failed=ui.render('SecurityActions',props);assert.ok(card(failed));assert.equal(card(failed).props.known,false);assert.ok(nodes(failed).some(n=>n.props?.role==='alert'))
})
test('其它任务的 execute 未决只占对应命令，当前 submit 可用；恢复仍读取原任务',async()=>{
 const {createSecurityActionApi}=await import('../src/client/security-action-api.ts')
 const {command,source}=await import('./security-action-fixtures.ts')
 const otherTask='aaaaaaaa-1111-4111-8111-111111111111',otherAction='bbbbbbbb-1111-4111-8111-111111111111',reads:string[]=[]
 const otherPanel={...panel,taskId:otherTask,actions:[{...action,id:otherAction,taskId:otherTask,state:'proposed' as const,version:1,frozen:null}],approvals:[]}
 let recovering=false
 const api=createSecurityActionApi(async(endpoint,payload)=>{
  if(endpoint==='security-actions/execute'){if(!recovering)throw Error('断线');return execution}
  const id=(payload as {taskId:string}).taskId;reads.push(id)
  return id===taskId?{...panel,actions:[{...action,state:'effect_unknown',version:4}],executions:[execution]}:otherPanel
 })
 await assert.rejects(api.execute(command,{panel,taskVersion:1,source}))
 const ui=load(),props={taskId:otherTask,taskVersion:1,api,sourceApi:{source:async()=>({...source,taskId:otherTask})},attention:[],attentionKnown:true,invalidateAttention:()=>{},changed:async()=>{}}
 ui.render('SecurityActions',props);ui.effects[0]!();await new Promise(resolve=>setImmediate(resolve))
 const tree=ui.render('SecurityActions',props),card=nodes(tree).find(n=>typeof n.type==='function'&&(n.type as Function).name==='SecurityActionCard')!
 assert.equal(card.props.disabled,false)
 const cardUi=load(),submit=nodes(cardUi.render('SecurityActionCard',card.props)).find(n=>n.type==='button'&&text(n)==='security.submit')!
 assert.equal(submit.props.disabled,false)
 const recover=nodes(tree).find(n=>n.type==='button'&&text(n).includes('security.recover'))!
 assert.ok(text(recover).includes(taskId))
 recovering=true;recover.props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.ok(reads.includes(taskId),'恢复后读取原任务 panel');assert.ok(reads.includes(otherTask));assert.equal(api.pending('execute'),undefined)
})
test('同任务未决 execute 仍锁住相关写入；损坏命令只禁其对应按钮',async()=>{
 const {createSecurityActionApi}=await import('../src/client/security-action-api.ts')
 const {command,source}=await import('./security-action-fixtures.ts')
 const api=createSecurityActionApi(async(endpoint)=>{if(endpoint.endsWith('/execute'))throw Error('断线');return panel})
 await assert.rejects(api.execute(command,{panel,taskVersion:1,source}))
 const ui=load(),props={taskId,taskVersion:1,api,sourceApi:{source:async()=>source},attention:[],attentionKnown:true,invalidateAttention:()=>{},changed:async()=>{}}
 ui.render('SecurityActions',props);ui.effects[0]!();await new Promise(resolve=>setImmediate(resolve))
 const card=nodes(ui.render('SecurityActions',props)).find(n=>typeof n.type==='function'&&(n.type as Function).name==='SecurityActionCard')!
 assert.equal(card.props.disabled,true)
 const brokenUi=load(),cardTree=brokenUi.render('SecurityActionCard',{action,panel,attention:[{taskId,actionId:action.id,kind:'security-action',reason:'execution-required'}],known:true,busy:false,disabled:false,disabledCommands:['execute'],run:async()=>{},repropose:()=>{}})
 assert.equal(button(brokenUi,cardTree,'security.execute')!.props.disabled,true)
 assert.equal(nodes(cardTree).find(n=>n.type==='button'&&text(n)==='security.withdraw')!.props.disabled,false)
})

test('面板不再重复渲染依据区已经承担的 goal、派发参数、审批意见与外部回执',()=>{
 const ui=load()
 const tree=ui.render('SecurityActionCard',{action,panel:{...panel,executions:[execution]},attention:[],known:true,busy:false,disabled:false,run:async()=>{},repropose:()=>{}})
 const body=text(tree)
 for(const duplicated of [action.goal,JSON.stringify(action.params),panel.approvals[0]!.reason,execution.acceptanceReceipt?.detail??''])
  if(duplicated)assert.equal(body.includes(duplicated),false,'面板不应再抄一遍：'+duplicated)
 // 依据区仍然拿到全套事实：goal、派发参数、审批意见各算一条。
 const evidence=nodes(tree).find(n=>typeof n.type==='function'&&Array.isArray(n.props.entries))
 assert.ok(evidence&&evidence.props.entries.length>=3)
 // 依据区不表达的结构化字段仍留在面板上。
 assert.ok(body.includes(action.targetSet.join(', ')))
 assert.ok(body.includes(execution.operationId))
})

test('面板的执行段走共用门：三行核对摆出来，不可逆动作没抄目标名不能点',()=>{
 const ui=load()
 const approved={...action,state:'approved' as const,reversible:'irreversible' as const,targetSet:['endpoint-1']}
 const props={action:approved,panel:{...panel,actions:[approved]},attention:[{taskId,actionId:approved.id,kind:'security-action' as const,reason:'execution-required' as const}],known:true,busy:false,disabled:false,run:async()=>{},repropose:()=>{}}
 const tree=ui.render('SecurityActionCard',props)
 const gate=ui.expand(tree,'SecurityExecutionGate')!
 assert.ok(gate,'执行段必须由共用门承担，面板不得自己摆一个只判锁的“执行”')
 const body=text(gate)
 for(const key of ['attention.security.checkTargets','attention.security.checkExecutor','attention.security.checkReachable'])assert.ok(body.includes(key),key)
 assert.ok(nodes(gate).some(n=>n.type==='input'),'不可逆动作必须给出逐字抄目标名的输入框')
 assert.equal(button(ui,tree,'security.execute')!.props.disabled,true,'没抄目标名不能执行')

 // 目标越出授权范围时执行同样不可点，成因摆在核对行里。
 const outside=load()
 const strayed={...approved,targetSet:['endpoint-9']}
 const strayTree=outside.render('SecurityActionCard',{...props,action:strayed,panel:{...panel,actions:[strayed]}})
 assert.equal(button(outside,strayTree,'security.execute')!.props.disabled,true)
 assert.ok(text(outside.expand(strayTree,'SecurityExecutionGate')!).includes('attention.security.checkTargetsBlocked'))
})

test('审批表单只在共用组件里出现一次',async()=>{
 const dir=new URL('../src/client/',import.meta.url)
 const files=(await readdir(dir)).filter(name=>name.endsWith('.tsx'))
 const hits:string[]=[]
 for(const name of files){
  const text=await readFile(new URL(name,dir),'utf8')
  if(text.includes("'security.decisionReason'"))hits.push(name)
 }
 assert.deepEqual(hits,['SecurityDecisionForm.tsx'])
})

test('核对执行结果与确认失败两枚按钮受同名命令的 journal 锁约束',()=>{
 // 面板此刻有一条未决的 observe：同任务的因果链不能被并发第二次写打断，journal 锁把整块都锁住。
 const observePanel={...panel,executions:[execution]}
 const observeApi:any={
  pending:(kind:string)=>kind==='observe'?{request:{},context:{panel:observePanel}}:undefined,
  recoveryError:()=>undefined,
  recover:async()=>({} as never),
  list:async()=>observePanel,
  decide:async()=>({} as never),
  execute:async()=>({} as never),
  withdrawApproval:async()=>({} as never),
  observe:async()=>({} as never),
  acknowledgeFailure:async()=>({} as never),
 }
 const observeProps={
  action,panel:observePanel,context:{} as never,
  attention:[],known:true,api:observeApi,panelError:undefined,reload:async()=>null,
  outcome:undefined,setOutcome:()=>{},
 }
 const html=renderToStaticMarkup(createElement(I18nProvider as never,{runtime:i18nRuntime as never},
  createElement(SecurityDecisionActions as never,{...observeProps,locked:(kind:string)=>kind==='observe'} as never)))
 assert.match(html,/disabled/)
 assert.match(html,/核对执行结果/)
})

test('审批过期的决策卡给出撤回按钮与接续文案，不呈现执行按钮（T9 缺陷 1，规格 §3.2 d）',()=>{
 const expiredAction={...action,state:'approved' as const}
 const expiredPanel={...panel,actions:[expiredAction],executions:[]}
 const idleApi:any={
  pending:()=>undefined,recoveryError:()=>undefined,recover:async()=>({} as never),list:async()=>expiredPanel,
  decide:async()=>({} as never),execute:async()=>({} as never),withdrawApproval:async()=>({} as never),
  observe:async()=>({} as never),acknowledgeFailure:async()=>({} as never),
 }
 const expiredProps={
  action:expiredAction,panel:expiredPanel,context:{} as never,
  attention:[{taskId,actionId:expiredAction.id,kind:'security-action' as const,reason:'approval-expired' as const}],
  known:true,api:idleApi,panelError:undefined,reload:async()=>null,outcome:undefined,setOutcome:()=>{},
 }
 const html=renderToStaticMarkup(createElement(I18nProvider as never,{runtime:i18nRuntime as never},
  createElement(SecurityDecisionActions as never,expiredProps as never)))
 assert.ok(html.includes(translateMessage('zh-CN','security.expired.nextStep' as never)),'缺少接续下一步文案')
 assert.ok(html.includes(translateMessage('zh-CN','security.withdraw' as never)),'缺少撤回批准按钮')
 assert.ok(!html.includes(translateMessage('zh-CN','security.execute' as never)),'过期批准不该还呈现执行按钮')
})

test('恢复类词表里的每个键都被真实代码引用，不留只挂了词条却没接线的键（T9 concern 2）',async()=>{
 const {SECURITY_RECOVERY_MESSAGE_ROWS}=await import('../src/client/i18n/locales/security-recovery.ts')
 const dir=new URL('../src/client/',import.meta.url)
 // 定义文件本身不算“引用”——否则每个键都会因为出现在自己的定义行里而白算通过。
 const names=(await readdir(dir,{recursive:true}) as string[]).filter(name=>/\.(tsx|ts)$/.test(name)&&!name.startsWith('i18n/locales/'))
 let combined=''
 for(const name of names)combined+=await readFile(new URL(name,dir),'utf8')
 for(const [key] of SECURITY_RECOVERY_MESSAGE_ROWS){
  const literal=combined.includes("'"+key+"'")||combined.includes('"'+key+'"')
  // 部分键走前缀拼接（如 'security.attention.'+row.reason），认前缀常量出现过也算接线。
  const prefix=key.slice(0,key.lastIndexOf('.')+1)
  const dynamic=combined.includes("'"+prefix+"'+")||combined.includes('"'+prefix+'"+')
  assert.ok(literal||dynamic,'未接线的词条：'+key)
 }
})
