import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {SecurityAction,SecurityActionPanel} from '@teloa/contract'
import type {AttentionItem} from '../src/client/attention-item.ts'

// 和 evidence-list.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {AttentionDecisionCard}=await import('../lib/types/client/AttentionDecisionCard.js')
const {TaskPage}=await import('../lib/types/client/TaskPage.js')
const {emptyTaskPreview}=await import('../lib/types/client/task-preview.js')
const {SecurityDecisionActions}=await import('../lib/types/client/SecurityDecisionActions.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

const item=(patch:Partial<AttentionItem>={}):AttentionItem=>({id:'security-action:a1',kind:'approval',source:'security-action',persistence:'saved',target:{kind:'security-action',taskId:'t1',actionId:'a1'},title:'隔离主机',reason:{kind:'text',text:'**高危**外联'},scope:'SOC',occurredAt:'2026-09-15T02:00:00.000Z',...patch})
const card=(props:Record<string,unknown>)=>render(createElement(AttentionDecisionCard as never,{id:'card-1',item:item(),sourceName:'外部动作',scopeName:'安全运营',occurred:'09-15 10:00',evidence:[],actions:null,...props}))

test('目录读取失败不冒充零任务，不重复显示无上下文的尚未核对',()=>{
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'tasks',state:emptyTaskPreview(),attentionItems:[],selected:null,visible:true,
  persistence:{attention:{rows:[],known:false},handoffs:{rows:[]},directoryKnown:false,error:'记录校验未通过',loading:false,load:noop},
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/任务列表暂时无法加载/)
 assert.match(html,/重试/)
 assert.doesNotMatch(html,/0 项任务|还没有任务|尚未核对|重置筛选/)
})

test('需要你默认行只展示识别信息，完整原因留在展开决策卡',()=>{
 const reason='需要核对这次外联是否由已登记的维护操作引起'
 const entry=item({reason:{kind:'text',text:reason}})
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'attention',state:emptyTaskPreview(),attentionItems:[entry],selected:null,visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  examples:noop,switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/隔离主机/)
 assert.match(html,/data-teloa-attention-arrow/)
 assert.match(html,/aria-expanded="false"/)
 assert.ok(!html.includes(reason))
 assert.ok(card({item:entry}).includes(reason))
})

test('交接等来源读取失败（attentionKnown=false）时页顶给出提示与重试，计数改说“至少”',()=>{
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'attention',state:emptyTaskPreview(),attentionItems:[item()],attentionKnown:false,retryAttention:noop,selected:null,visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/role="status"/)
 assert.match(html,/部分待办暂时无法加载/)
 assert.match(html,/列表可能不完整/)
 assert.match(html,/重试/)
 assert.match(html,/至少 1 项/)
 assert.doesNotMatch(html,/>1 项</)
})

test('全部来源都已确认（attentionKnown 默认 true）时不显示读取失败提示，计数照常给确定数字',()=>{
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'attention',state:emptyTaskPreview(),attentionItems:[item()],selected:null,visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.doesNotMatch(html,/role="status"/)
 assert.doesNotMatch(html,/部分待办暂时无法加载|列表可能不完整/)
 assert.doesNotMatch(html,/至少 1 项/)
 assert.match(html,/>1 项</)
})

test('需要你不被上一次任务选择替换成任务详情',()=>{
 const noop=()=>{},oldTask={
  id:'t1',title:'旧任务详情',goal:'旧任务目标',scope:'SOC',object:'告警',version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z',result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'',execution:'not_started',
 }
 const html=render(createElement(TaskPage as never,{
  mode:'attention',state:{...emptyTaskPreview(),tasks:[oldTask]},attentionItems:[item()],selected:'t1',visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/<h1>需要你<\/h1>/)
 assert.match(html,/待审批、待补充资料和待核对的事项/)
 assert.match(html,/隔离主机/)
 assert.doesNotMatch(html,/旧任务目标/)
})

test('需要你为空时不显示“全部 0”筛选，并说明哪些事项会回流',()=>{
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'attention',state:emptyTaskPreview(),attentionItems:[],selected:null,visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  examples:noop,switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/没有需要你处理的事项/)
 assert.match(html,/有需要你决定、补充或核对的事项时/)
 assert.doesNotMatch(html,/按类型查看/)
 assert.doesNotMatch(html,/>全部 <span>0<\/span>/)
})

test('工作为空时不画空表头，直接给任务语义与交办入口',()=>{
 const noop=()=>{}
 const html=render(createElement(TaskPage as never,{
  mode:'tasks',state:emptyTaskPreview(),attentionItems:[],selected:null,visible:true,
  conversations:()=>null,openArtifacts:noop,openPlans:noop,openAttention:noop,select:noop,change:noop,
  examples:noop,switchMode:noop,openSource:noop,team:noop,openRole:noop,openBusiness:noop,saveTemplate:noop,
 } as never))
 assert.match(html,/还没有任务/)
 assert.match(html,/交办第一项任务/)
 assert.match(html,/>交办任务</)
 assert.doesNotMatch(html,/<table/)
})

const action=(patch:Partial<SecurityAction>={}):SecurityAction=>({id:'a1',ownerId:'o',taskId:'t1',version:3,state:'approved',title:'隔离主机',goal:'隔离 prod-03',tool:'security.endpoint.isolate',riskTier:'high',reversible:'irreversible',playbookVersion:'1.0.0',targetSet:['prod-03'],params:{reason:'C2'},supersedesActionId:null,frozen:null,proposerId:'o',createdAt:'2026-09-15T01:00:00.000Z',updatedAt:'2026-09-15T02:00:00.000Z',...patch} as SecurityAction)
const panel=(rows:SecurityAction[],tools:{tool:string;allowedTargets:string[]}[]=[{tool:'security.endpoint.isolate',allowedTargets:['prod-03']}]):SecurityActionPanel=>({taskId:'t1',actions:rows,approvals:[],executions:[],proposal:{tools}} as SecurityActionPanel)
const idleApi={pending:()=>undefined,recoveryError:()=>undefined,recover:async()=>({} as never),list:async()=>({} as never),decide:async()=>({} as never),execute:async()=>({} as never),withdrawApproval:async()=>({} as never)}
const executionRequired=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'execution-required' as const}]
const actions=(row:SecurityAction,rows:SecurityActionPanel,api:Record<string,unknown>=idleApi,panelError?:string)=>render(createElement(SecurityDecisionActions as never,{
 action:row,panel:rows,context:{} as never,attention:[{taskId:'t1',actionId:'a1',kind:'security-action',reason:'execution-required'}],known:true,
 api:api as never,panelError,reload:async()=>null,
} as never))

test('批准后执行器不可用：卡片仍显示批准事实与撤回，不提供执行按钮',()=>{
 const row=action(),rows=panel([row])
 const html=render(createElement(SecurityDecisionActions as never,{
  action:row,panel:rows,context:{},attention:[{taskId:'t1',actionId:'a1',kind:'security-action',reason:'adapter-unavailable'}],known:true,
  api:idleApi,reload:async()=>null,
 } as never))
 assert.match(html,/已批准 · 待执行/)
 assert.match(html,/>撤回<\/button>/)
 assert.doesNotMatch(html,/>执行已批准动作<\/button>/)
 assert.doesNotMatch(html,/这条外部动作当前没有需要你操作的步骤/)
})

test('风险行自己说全分级、可逆性与目标数，不把人支去动作区',()=>{
 const html=card({risk:{riskTier:'high',reversible:'irreversible',targets:2}})
 assert.match(html,/风险/)
 assert.match(html,/高风险/)
 assert.match(html,/不可逆/)
 assert.match(html,/目标 2 个/)
})

test('拿不到动作时风险行直说不可用，而不是假装没有风险',()=>{
 const html=card({})
 assert.match(html,/风险信息暂不可用/)
 assert.doesNotMatch(html,/高风险/)
})

test('非安全动作的事项没有风险行',()=>{
 const html=card({item:item({target:{kind:'task',id:'t1'},kind:'handoff'})})
 assert.doesNotMatch(html,/风险信息暂不可用/)
})

test('审批过期事项的下一步行只给接续文案一句，不落回通用的 review 文案，也不与卡内 actions 区重复（N-1）',()=>{
 const row=action({state:'approved'})
 // actions 传真的 SecurityDecisionActions（nextStep=false）：这是 WorkbenchFrame 卡内装配的真实组合，
 // 只在 actions:null 的桩上测量不到"两处并列"这件事。
 const decisionActions=createElement(SecurityDecisionActions as never,{
  action:row,panel:panel([row]),context:{} as never,
  attention:[{taskId:'t1',actionId:'a1',kind:'security-action',reason:'approval-expired'}],known:true,
  api:idleApi as never,panelError:undefined,reload:async()=>null,nextStep:false,
 } as never)
 const html=card({item:item({kind:'review',reason:{kind:'message',key:'security.attention.approval-expired'}}),actions:decisionActions})
 assert.match(html,/这条批准已超过有效期/)
 assert.doesNotMatch(html,/核对交付内容与依据，确认通过或退回修改/)
 // 卡内下一步只出现一次：下一步行有它，actions 区靠 nextStep=false 抑制了同一句复述。
 assert.equal((html.match(/这条批准已超过有效期/g)??[]).length,1)
})

test('执行中未核对（派发中/已受理/效果未知）的事项下一步给出核对提示，不落回通用的 review 文案（I-1）',()=>{
 for(const reason of ['execution-dispatching','external-accepted','effect-unknown']){
  const html=card({item:item({kind:'review',reason:{kind:'message',key:('security.attention.'+reason) as never}})})
  assert.match(html,/执行已派发但结果尚未确认/)
  assert.doesNotMatch(html,/核对交付内容与依据，确认通过或退回修改/)
 }
})

test('依据行把原因与对象摘要一起当叙述渲染，Markdown 生效且不出 img',()=>{
 const html=card({summary:'## 处置目标\n\n隔离 `prod-03`\n\n![证据](https://example.test/a.png)'})
 assert.match(html,/<strong>高危<\/strong>/)
 assert.match(html,/<h2>处置目标<\/h2>/)
 assert.match(html,/<code>prod-03<\/code>/)
 assert.doesNotMatch(html,/<img/)
})

test('执行前三行检查都摆出来，全通过时执行可点',()=>{
 const row=action({reversible:'reversible'})
 const html=actions(row,panel([row]))
 assert.match(html,/目标集/)
 assert.match(html,/prod-03/)
 assert.match(html,/执行器就绪/)
 assert.match(html,/目标可达/)
 assert.match(html,/已通过/)
 assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>执行已批准动作</)
})

test('审批时确定的对象里没有合法目标时执行不可点，且按真实成因归因',()=>{
 const row=action({reversible:'reversible'})
 const html=actions(row,panel([row],[]))
 // 成因是固定对象没有可授权终端（后端 action-panel 的 allowedTargets 为空），不是执行器连接
 assert.match(html,/审批时确定的对象里没有可执行的合法目标/)
 assert.doesNotMatch(html,/恢复连接/)
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
})

test('目标越出授权范围时执行不可点，并说清为什么',()=>{
 const row=action({reversible:'reversible',targetSet:['prod-09']})
 const html=actions(row,panel([row]))
 assert.match(html,/有目标不在当前授权范围内/)
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
})

test('不可逆动作没抄目标名之前执行不可点',()=>{
 const row=action({targetSet:['prod-03']})
 const html=actions(row,panel([row]))
 assert.match(html,/请按顺序逐字输入全部目标标识 prod-03 后执行/)
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
})

test('同任务有未决的写时只给恢复，执行与撤回一律禁用',()=>{
 const row=action({reversible:'reversible'})
 const held={...idleApi,pending:(kind:string)=>kind==='execute'?{request:{},context:{panel:panel([row])}}:undefined}
 const html=actions(row,panel([row]),held)
 assert.match(html,/核对原请求 · 执行已批准动作 · t1<\/button>/)
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
 assert.match(html,/<button[^>]*disabled[^>]*>撤回<\/button>/)
})

test('别的任务占着同名命令时，那条命令照样锁死并标明是哪条任务',()=>{
 const row=action({reversible:'reversible'})
 const other={...idleApi,pending:(kind:string)=>kind==='execute'?{request:{},context:{panel:{...panel([row]),taskId:'t9'}}}:undefined}
 const html=actions(row,panel([row]),other)
 // write() 对同名命令的任何未决条目都 conflict，所以别的任务占着也发不出去
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
 // 本任务没被占，撤回仍然可点
 assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>撤回<\/button>/)
 // 恢复入口要说清是哪条任务的未决
 assert.match(html,/核对原请求 · 执行已批准动作 · t9<\/button>/)
})

test('面板副本还在但最近一次重载失败时，卡内照样给出错误与重试，并按“未核对”锁住写入',()=>{
 const row=action({reversible:'reversible'})
 const html=actions(row,panel([row]),idleApi,'连接不可用。')
 assert.match(html,/<p role="alert">连接不可用。<\/p>/)
 assert.match(html,/重试/)
 // journal 锁语义与任务详情面板同出一处：面板副本已知过期就不许对着它下手。
 assert.match(html,/<button[^>]*disabled[^>]*>执行已批准动作<\/button>/)
})

test('三拍终态与错误由外壳持有：卡片卸载后重新展开仍看得见',()=>{
 const row=action({state:'approved',reversible:'reversible'})
 // 卡片被筛走再重新展开 = 一个全新的组件实例，只拿得到外壳交回来的 outcome。
 const pending=render(createElement(SecurityDecisionActions as never,{
  action:row,panel:panel([row]),context:{} as never,attention:executionRequired,known:true,
  api:idleApi as never,panelError:undefined,reload:async()=>null,
  outcome:{awaitingExecute:true},setOutcome:()=>{},
 } as never))
 assert.match(pending,/已批准 · 待执行/)
 const failed=render(createElement(SecurityDecisionActions as never,{
  action:row,panel:panel([row]),context:{} as never,attention:executionRequired,known:true,
  api:idleApi as never,panelError:undefined,reload:async()=>null,
  outcome:{awaitingExecute:false,error:'写入失败：连接不可用。'},setOutcome:()=>{},
 } as never))
 assert.match(failed,/<p role="alert">写入失败：连接不可用。<\/p>/)
})

test('通用请求展示文档与订单等真实对象，不强加安全风险字段；重复目标叙述只显示一次',()=>{
 const html=card({item:item({source:'task',target:{kind:'task',id:'t1'},scope:'general',title:'发布周报',reason:{kind:'text',text:'请核对本周内容'}}),request:{title:'发布周报',targets:['周报 2026-W39','客户订单 A-102']},summary:'经核对的本周内容',evidence:[{kind:'text',title:'内容依据',body:'经核对的本周内容'}]})
 assert.match(html,/涉及对象/)
 assert.match(html,/周报 2026-W39/)
 assert.match(html,/客户订单 A-102/)
 assert.doesNotMatch(html,/风险信息暂不可用|高风险|隔离/)
 assert.equal(html.split('经核对的本周内容').length-1,1)
})
