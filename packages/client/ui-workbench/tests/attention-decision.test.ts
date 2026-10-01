import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import type {SecurityAction,SecurityActionExecution,SecurityActionPanel} from '@teloa/contract'
import type {AttentionItem} from '../src/client/attention-item.ts'
import type {SecurityActionContext} from '../src/client/security-action-api.ts'
import {
 ATTENTION_EXPANDED_KEY,approveAndExecute,attentionDecisionActionMode,attentionNextStepKey,confirmTargetMatches,
 readExpandedAttention,securityDecisionStage,securityExecutionChecks,toggleExpandedAttention,writeExpandedAttention,
 type SecurityDecisionSnapshot,
} from '../src/client/attention-decision.ts'
import {canResolveHandoff} from '../src/client/task-handoff-presentation.ts'

const page=await readFile(new URL('../src/client/TaskPage.tsx',import.meta.url),'utf8')
const detail=await readFile(new URL('../src/client/TaskDetail.tsx',import.meta.url),'utf8')
const card=await readFile(new URL('../src/client/AttentionDecisionCard.tsx',import.meta.url),'utf8')
const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const handoff=await readFile(new URL('../src/client/HandoffDecisionActions.tsx',import.meta.url),'utf8')
const security=await readFile(new URL('../src/client/SecurityDecisionActions.tsx',import.meta.url),'utf8')
const handoffPanel=await readFile(new URL('../src/client/TaskHandoffs.tsx',import.meta.url),'utf8')
const panelSource=await readFile(new URL('../src/client/SecurityActions.tsx',import.meta.url),'utf8')
const gateSource=await readFile(new URL('../src/client/attention-decision.ts',import.meta.url),'utf8')
const executionGate=await readFile(new URL('../src/client/SecurityExecutionGate.tsx',import.meta.url),'utf8')

const item=(id:string,patch:Partial<AttentionItem>={}):AttentionItem=>({id,kind:'approval',source:'security-action',persistence:'saved',target:{kind:'task',id:'t1'},title:'核对',reason:{kind:'text',text:'依据'},scope:'SOC',occurredAt:'2026-09-15T02:00:00.000Z',...patch})

const action=(patch:Partial<SecurityAction>={}):SecurityAction=>({id:'a1',ownerId:'o',taskId:'t1',version:2,state:'pending_approval',title:'隔离主机',goal:'隔离 prod-03',tool:'security.endpoint.isolate',riskTier:'high',reversible:'irreversible',playbookVersion:'1.0.0',targetSet:['prod-03'],params:{reason:'C2'},supersedesActionId:null,frozen:null,proposerId:'o',createdAt:'2026-09-15T01:00:00.000Z',updatedAt:'2026-09-15T02:00:00.000Z',...patch} as SecurityAction)
const panel=(rows:SecurityAction[],patch:Partial<SecurityActionPanel>={}):SecurityActionPanel=>({taskId:'t1',actions:rows,approvals:[],executions:[],proposal:{tools:[{tool:'security.endpoint.isolate',allowedTargets:['prod-03','prod-04']}]},...patch} as SecurityActionPanel)
const context={panel:panel([]),taskVersion:1,source:{taskId:'t1',ownerId:'o',sourceId:'security-alert-http',reference:{}}} as unknown as SecurityActionContext
const executionRequired=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'execution-required' as const}]
const baseAction=action()
const basePanel=panel([])
const executingAction=action({state:'executing'})
const approvedAction=action({state:'approved',riskTier:'low',reversible:'reversible'})
const baseExecution:SecurityActionExecution={operationId:'operation-1',ownerId:'o',actionId:'a1',approvalId:'approval-1',approvalVersion:1,state:'dispatching',revision:1,frozen:{taskDefinitionDigest:'sha256:'+'a'.repeat(64),sourceSnapshotDigest:'b'.repeat(64),objectSnapshotHash:'c'.repeat(64),playbookVersion:'1.0.0',paramFingerprint:'sha256:'+'d'.repeat(64),targetFingerprint:'sha256:'+'e'.repeat(64)},dispatch:{operationId:'operation-1',actionId:'a1',tool:'security.endpoint.isolate',playbookVersion:'1.0.0',targets:['prod-03'],params:{}},acceptanceReceipt:null,effectReceipt:null,createdAt:'2026-09-15T01:00:00.000Z',updatedAt:'2026-09-15T01:00:00.000Z'}

test('同一时间只展开一条，再点同一条收起',()=>{
 assert.equal(toggleExpandedAttention(null,'a'),'a')
 assert.equal(toggleExpandedAttention('a','b'),'b')
 assert.equal(toggleExpandedAttention('a','a'),null)
})

test('展开态按事项 id 存 sessionStorage，事项消失即视为未展开',()=>{
 assert.equal(ATTENTION_EXPANDED_KEY,'teloa.attention-expanded/v1')
 const items=[item('x'),item('y')]
 assert.equal(readExpandedAttention({getItem:()=>'y'},items),'y')
 assert.equal(readExpandedAttention({getItem:()=>'gone'},items),null)
 assert.equal(readExpandedAttention({getItem:()=>null},items),null)
 const calls:string[]=[]
 writeExpandedAttention({setItem:(k,v)=>calls.push('set:'+k+'='+v),removeItem:k=>calls.push('remove:'+k)},'x')
 writeExpandedAttention({setItem:(k,v)=>calls.push('set:'+k+'='+v),removeItem:k=>calls.push('remove:'+k)},null)
 assert.deepEqual(calls,['set:teloa.attention-expanded/v1=x','remove:teloa.attention-expanded/v1'])
})

test('存储抛错不影响展开，读回退为未展开',()=>{
 assert.equal(readExpandedAttention({getItem:()=>{throw Error('blocked')}},[item('x')]),null)
 assert.doesNotThrow(()=>writeExpandedAttention({setItem:()=>{throw Error('quota')},removeItem:()=>{}},'x'))
})

test('下一步文案默认按 kind 分派，八种齐全',()=>{
 const textReason={kind:'text' as const,text:'依据'}
 assert.deepEqual(
  (['approval','materials','connection','error','review','handoff','dispatch','execution'] as const).map(kind=>attentionNextStepKey({kind,reason:textReason})),
  ['attention.next.approval','attention.next.materials','attention.next.connection','attention.next.error','attention.next.review','attention.next.handoff','attention.next.dispatch','attention.next.execution'],
 )
})

test('审批过期与执行中未核对的安全事项不落回通用 review 文案（I-1，与 9648c28 补的过期/observe 段矛盾的缺陷）',()=>{
 const messageReason=(reason:string)=>({kind:'message' as const,key:('security.attention.'+reason) as never})
 // 这四种 reason 在 attention-item.ts 里全部落 kind:'review'，通用文案与卡内另外呈现的过期/核对段落矛盾。
 assert.equal(attentionNextStepKey({kind:'review',reason:messageReason('approval-expired')}),'security.expired.nextStep')
 for(const reason of ['execution-dispatching','external-accepted','effect-unknown'])
  assert.equal(attentionNextStepKey({kind:'review',reason:messageReason(reason)}),'attention.next.observePending')
 // 非安全消息（或安全消息里没有覆写的 reason，如 approval-required）仍按 kind 走默认文案。
 assert.equal(attentionNextStepKey({kind:'review',reason:messageReason('execution-failed')}),'attention.next.review')
 assert.notEqual(attentionNextStepKey({kind:'review',reason:messageReason('approval-expired')}),'attention.next.review')
})

test('动作区按 target.kind 分流：安全动作内联审批、交接两按钮、其余只有去处理',()=>{
 assert.equal(attentionDecisionActionMode({kind:'security-action',taskId:'t1',actionId:'a1'}),'security-action')
 assert.equal(attentionDecisionActionMode({kind:'task',id:'t1'}),'handoff')
 for(const target of [
  {kind:'artifact' as const,source:{kind:'session' as const,id:'s1'},artifactId:'x',version:1},
  {kind:'group' as const,id:'g'},{kind:'market' as const,itemId:'m'},
  {kind:'industry-skill' as const,loadId:'l',itemInstanceId:'i'},
  {kind:'binding' as const,id:'b',version:1},{kind:'installation' as const,selection:'skill:s' as const},
  {kind:'plan' as const,id:'p'},
 ])assert.equal(attentionDecisionActionMode(target),'open')
})

test('低中风险且可逆是一步“批准并执行”',()=>{
 const low=action({riskTier:'low',reversible:'reversible'})
 assert.deepEqual(securityDecisionStage(low,panel([low]),[],true),{stage:'decide',needsReason:true,needsImpact:true,combined:true})
 const med=action({riskTier:'med',reversible:'reversible'})
 assert.deepEqual(securityDecisionStage(med,panel([med]),[],true),{stage:'decide',needsReason:true,needsImpact:true,combined:true})
})

test('高风险或不可逆是两段：批准阶段不合并执行',()=>{
 const high=action({riskTier:'high',reversible:'reversible'})
 assert.deepEqual(securityDecisionStage(high,panel([high]),[],true),{stage:'decide',needsReason:true,needsImpact:true,combined:false})
 const irreversible=action({riskTier:'low',reversible:'irreversible'})
 assert.deepEqual(securityDecisionStage(irreversible,panel([irreversible]),[],true),{stage:'decide',needsReason:true,needsImpact:true,combined:false})
})

test('已批准待执行：不可逆要求输入目标名，同屏可撤回批准',()=>{
 const approved=action({state:'approved',reversible:'irreversible',targetSet:['prod-03']})
 const attention=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'execution-required' as const}]
 assert.deepEqual(securityDecisionStage(approved,panel([approved]),attention,true),{stage:'execute',irreversible:true,confirmTarget:'prod-03',canWithdraw:true})
 const reversible=action({state:'approved',reversible:'reversible'})
 assert.deepEqual(securityDecisionStage(reversible,panel([reversible]),attention,true),{stage:'execute',irreversible:false,confirmTarget:null,canWithdraw:true})
})

test('多目标的不可逆动作要求按顺序输入全部目标名',()=>{
 const many=action({state:'approved',reversible:'irreversible',targetSet:['prod-03','prod-04']})
 const attention=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'execution-required' as const}]
 assert.deepEqual(securityDecisionStage(many,panel([many]),attention,true),{stage:'execute',irreversible:true,confirmTarget:'prod-03, prod-04',canWithdraw:true})
})

test('目标名比对只放过逗号后空格与首尾空白，顺序与数量都不放过',()=>{
 assert.equal(confirmTargetMatches('prod-03','prod-03'),true)
 assert.equal(confirmTargetMatches('  prod-03  ','prod-03'),true)
 assert.equal(confirmTargetMatches('prod-03,prod-04','prod-03, prod-04'),true)
 assert.equal(confirmTargetMatches(' prod-03 ,  prod-04 ','prod-03, prod-04'),true)
 assert.equal(confirmTargetMatches('prod-04, prod-03','prod-03, prod-04'),false)
 assert.equal(confirmTargetMatches('prod-03','prod-03, prod-04'),false)
 assert.equal(confirmTargetMatches('prod-03, prod-04, prod-05','prod-03, prod-04'),false)
 assert.equal(confirmTargetMatches('PROD-03','prod-03'),false)
 assert.equal(confirmTargetMatches('','prod-03'),false)
})

test('审批已过期给出接续出路：不给执行，卡内仍可撤回批准（T9 缺陷 1，规格 §3.2 d）',()=>{
 const approved=action({state:'approved'})
 const expired=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'approval-expired' as const}]
 assert.deepEqual(securityDecisionStage(approved,panel([approved]),expired,true),{stage:'expired',canWithdraw:true})
})

test('过期批准一旦已经派发（有执行记录）就不再算过期，判据只认动作与执行的当下事实',()=>{
 const approved=action({state:'approved'})
 const expired=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'approval-expired' as const}]
 const dispatched={...baseExecution,actionId:approved.id,state:'dispatching' as const}
 assert.equal(securityDecisionStage(approved,panel([approved],{executions:[dispatched]}),expired,true).stage,'observe')
})

test('已批准但执行器不可用仍保留批准状态与撤回；未核对目录不开放接续',()=>{
 const approved=action({state:'approved'})
 const unavailable=[{taskId:'t1',actionId:'a1',kind:'security-action' as const,reason:'adapter-unavailable' as const}]
 assert.deepEqual(securityDecisionStage(approved,panel([approved]),unavailable,true),{stage:'approved',canWithdraw:true})
 assert.deepEqual(securityDecisionStage(approved,panel([approved]),unavailable,false),{stage:'wait'})
})

test('派发中、已受理与效果未知一律给出核对执行结果，并带上操作身份与版本',()=>{
 for(const state of ['dispatching','accepted','effect_unknown'] as const){
  const execution={...baseExecution,state,revision:3}
  const panel={...basePanel,actions:[executingAction],executions:[execution]}
  const stage=securityDecisionStage(executingAction,panel,[],true)
  assert.deepEqual(stage,{stage:'observe',operationId:execution.operationId,expectedRevision:3})
 }
})

test('执行失败给出确认失败',()=>{
 const failed={...baseAction,state:'failed'} as SecurityAction
 assert.deepEqual(securityDecisionStage(failed,{...basePanel,actions:[failed]},[],true),{stage:'acknowledge'})
})

test('已批准且执行器就绪时仍走执行段，不被核对态抢走',()=>{
 const stage=securityDecisionStage(approvedAction,{...basePanel,actions:[approvedAction],executions:[]},[{taskId:basePanel.taskId,actionId:approvedAction.id,kind:'security-action',reason:'execution-required'}],true)
 assert.equal(stage.stage,'execute')
})

test('列表行是可展开的按钮，箭头是并列的独立按钮而非嵌套的伪链接',()=>{
 assert.match(page,/aria-expanded=\{expandedAttention===item\.id\}/)
 assert.match(page,/<button type="button" data-teloa-attention-arrow/)
 // 兄弟结构下不需要拦冒泡，也不该把 link 语义塞进 button 里
 assert.doesNotMatch(page,/data-teloa-attention-arrow[^>]*role="link"/)
 assert.doesNotMatch(page,/stopPropagation/)
})

test('本人接手走既有 handoffs/resolve，交接两按钮只给真正挂着交接单的事项',()=>{
 assert.match(frame,/handoffPort\.resolve\(taskId,\{handoffId:row\.id,expectedTaskVersion:task\.version,target:\{kind:'self'\},note\}\)/)
 assert.match(frame,/mode==='handoff'&&item\.kind==='handoff'/)
 // 契约要求接任说明必填，卡内就得有这一栏，不能空着提交
 assert.match(handoff,/task\.detail\.handoffNote/)
 // 说明栏只归"本人接手"：导航那条路不该陪着填
 assert.match(handoff,/\{canTakeOver&&open&&<>/)
 // 存储/恢复出问题时接任一律不给写，对齐详情页对 api.error 的处理
 assert.match(handoff,/disabled=\{busy\|\|pending\|\|error!==undefined\|\|!note\.trim\(\)\}/)
})

test('详情页面板写入后，决策卡手里的面板缓存一并作废',()=>{
 assert.match(frame,/const invalidateSecurityAttention=\(\)=>\{.*setSecurityPanels\(\{\}\)/)
})

test('卡片是四行结构，风险行只在安全动作上出现',()=>{
 assert.match(card,/attention\.row\.source/)
 assert.match(card,/attention\.row\.basis/)
 assert.match(card,/attention\.row\.next/)
 assert.match(card,/attention\.row\.risk/)
 assert.match(card,/item\.target\.kind==='security-action'/)
})

test('执行前检查读面板的提议能力表：执行器缺工具或目标越权都算未通过',()=>{
 const row=action({state:'approved',reversible:'reversible',targetSet:['prod-03','prod-04']})
 assert.deepEqual(securityExecutionChecks(row,panel([row])),{executorReady:true,targetsAllowed:true,targets:['prod-03','prod-04']})
 assert.deepEqual(securityExecutionChecks(row,panel([row],{proposal:{tools:[]}})),{executorReady:false,targetsAllowed:false,targets:['prod-03','prod-04']})
 const outside=action({state:'approved',targetSet:['prod-09']})
 assert.deepEqual(securityExecutionChecks(outside,panel([outside])),{executorReady:true,targetsAllowed:false,targets:['prod-09']})
})

// 三拍的编排刻意留在 React 之外，这样"卡片被筛走/收起"根本无从影响它。
const snapshot=(row:SecurityAction,attention=executionRequired,known=true):SecurityDecisionSnapshot=>({action:row,panel:panel([row]),context,attention,known})
const stubApi=(calls:string[])=>({
 decide:async(request:{expectedActionVersion:number})=>{calls.push('decide:v'+request.expectedActionVersion);return {} as never},
 execute:async(request:{expectedActionVersion:number})=>{calls.push('execute:v'+request.expectedActionVersion);return {} as never},
})
const ids=()=>{let n=0;return ()=>'00000000-0000-4000-8000-'+String(++n).padStart(12,'0')}

test('批准并执行走满三拍：decide 用旧版本，重载后 execute 用新版本，执行完再重载一次',async()=>{
 const calls:string[]=[],low=action({riskTier:'low',reversible:'reversible',version:2})
 const approved=action({riskTier:'low',reversible:'reversible',version:3,state:'approved'})
 const outcome=await approveAndExecute(snapshot(low,[],true),stubApi(calls),'核对无误',async()=>{calls.push('reload');return snapshot(approved)},ids())
 assert.equal(outcome,'executed')
 // 执行后那次重载不能少：否则卡片停在"已批准 · 待执行"、"执行"仍可点，再点就撞 version-conflict
 assert.deepEqual(calls,['decide:v2','reload','execute:v3','reload'])
})

test('执行后的重载失败也不影响结论：批准与执行都已落地',async()=>{
 const calls:string[]=[],low=action({riskTier:'low',reversible:'reversible',version:2})
 const approved=action({riskTier:'low',reversible:'reversible',version:3,state:'approved'})
 let round=0
 const outcome=await approveAndExecute(snapshot(low,[],true),stubApi(calls),'r',async()=>{
  if(++round===1)return snapshot(approved)
  throw Error('offline')
 },ids())
 assert.equal(outcome,'executed')
 assert.deepEqual(calls,['decide:v2','execute:v3'])
 assert.equal(round,2)
})

test('批准后事项被筛走或卡片收起都不影响第三拍：编排不依赖组件存活',async()=>{
 const calls:string[]=[],low=action({riskTier:'low',reversible:'reversible',version:2})
 const approved=action({riskTier:'low',reversible:'reversible',version:3,state:'approved'})
 // 模拟用户在批准瞬间切到"审批"筛选：列表里已经没有这条，重载仍照常把新事实交回来。
 let unmounted=false
 const outcome=await approveAndExecute(snapshot(low,[],true),stubApi(calls),'核对无误',async()=>{unmounted=true;return snapshot(approved)},ids())
 assert.equal(unmounted,true)
 assert.equal(outcome,'executed')
 assert.deepEqual(calls,['decide:v2','execute:v3'])
})

test('重载没回到待执行、执行前检查没过或重载失败时，停在已批准而不拿旧版本硬试',async()=>{
 const low=action({riskTier:'low',reversible:'reversible',version:2})
 const approved=action({riskTier:'low',reversible:'reversible',version:3,state:'approved'})
 const waiting:string[]=[]
 assert.equal(await approveAndExecute(snapshot(low,[],true),stubApi(waiting),'r',async()=>snapshot(approved,[],false),ids()),'approved')
 assert.deepEqual(waiting,['decide:v2'])
 const blocked:string[]=[]
 assert.equal(await approveAndExecute(snapshot(low,[],true),stubApi(blocked),'r',async()=>({...snapshot(approved),panel:panel([approved],{proposal:{tools:[]}})}),ids()),'approved')
 assert.deepEqual(blocked,['decide:v2'])
 const broken:string[]=[]
 assert.equal(await approveAndExecute(snapshot(low,[],true),stubApi(broken),'r',async()=>{throw Error('offline')},ids()),'approved')
 assert.deepEqual(broken,['decide:v2'])
})

test('decide 本身失败就不该有第三拍，错误照常抛给调用方',async()=>{
 const low=action({riskTier:'low',reversible:'reversible'})
 const calls:string[]=[]
 await assert.rejects(approveAndExecute(snapshot(low,[],true),{
  decide:async()=>{throw Error('rejected')},
  execute:async()=>{calls.push('execute');return {} as never},
 },'r',async()=>snapshot(low),ids()),/rejected/)
 assert.deepEqual(calls,[])
})

test('卡内写操作先看 journal：同任务有未决就只给恢复，不另造请求',()=>{
 assert.match(security,/api\.recover\(kind\)/)
 // journal 锁语义只有一处出处，决策卡与任务详情面板同用：held / disabledCommands / verified 都在那里算。
 assert.match(security,/securityJournalLocks\(api,cardCommands,panel\.taskId,\{busy,verified:panelError===undefined\}\)/)
 assert.match(panelSource,/securityJournalLocks\(api,securityActionCommands,taskId,\{busy,verified\}\)/)
 assert.match(gateSource,/const held=pendingKinds\.some\(kind=>api\.pending\(kind\)!\.context\.panel\.taskId===taskId\)/)
 // 同名命令被别的任务占着时那一条一定发不出去：write() 对同名命令的任何未决条目都 conflict
 assert.match(gateSource,/const disabledCommands=commands\.filter\(kind=>pendingKinds\.includes\(kind\)\|\|brokenKinds\.includes\(kind\)\)/)
 assert.match(gateSource,/locked:kind=>blocked\|\|disabledCommands\.includes\(kind\)/)
 // 恢复按钮标明是哪条任务的未决，并在恢复后重新核对那条任务的面板
 assert.match(security,/\{t\('security\.recover'\)\} · \{t\(commandKey\(kind\)\)\} · \{savedTaskId\}/)
 assert.match(security,/if\(savedTaskId!==panel\.taskId\)await api\.list\(savedTaskId\)/)
 // 执行区是同一扇门：三行核对与逐字抄目标名都长在共用组件里，两个入口只是用它。
 assert.match(executionGate,/export function SecurityExecutionGate/)
 assert.match(executionGate,/securityExecutionChecks\(action,panel\)/)
 assert.match(executionGate,/confirmTargetMatches\(confirm,stage\.confirmTarget\)/)
 assert.match(security,/<SecurityExecutionGate /)
 assert.match(panelSource,/<SecurityExecutionGate /)
 assert.doesNotMatch(panelSource,/controls\.execute&&<button/,'面板不得再自己摆一个只判锁的“执行”')
 assert.match(handoff,/collaboration\.action\.recover/)
 assert.match(handoff,/disabled=\{busy\|\|pending\|\|error!==undefined\|\|!note\.trim\(\)\}/)
 // I4：真实「本人接手」不能再借用演示沙盒那句“确认演示交接”。
 assert.match(handoff,/t\('task\.detail\.confirmTakeOver'\)/)
 assert.doesNotMatch(handoff,/t\('task\.detail\.confirmHandoff'\)/)
 assert.match(handoffPanel,/t\('task\.detail\.confirmTakeOver'\)/)
 assert.match(detail,/t\('task\.detail\.confirmDemoHandoff'\)/)
 assert.doesNotMatch(detail,/t\('task\.detail\.confirmHandoff'\)/)
})

test('接手门槛与详情页共用一个判据，任务在跑或已易主都不给接手',()=>{
 const base={state:'waiting' as const,assigneeId:'r1'}
 assert.equal(canResolveHandoff(base,'r1'),true)
 assert.equal(canResolveHandoff({...base,state:'running'},'r1'),false)
 assert.equal(canResolveHandoff({...base,state:'completed'},'r1'),false)
 assert.equal(canResolveHandoff({...base,state:'cancelled'},'r1'),false)
 assert.equal(canResolveHandoff(base,'r2'),false)
 // 详情页两处表单与决策卡都改读这一个函数，避免再各写一份而漂移
 assert.equal(handoffPanel.match(/canResolveHandoff\(task,row\.fromRoleId\)/g)?.length,2)
 assert.match(frame,/canTakeOver:canResolveHandoff\(task,row\.fromRoleId\)/)
})

test('风险行自带分级、可逆性与目标数，拉不到就直说不可用',()=>{
 assert.match(card,/security\.risk\.'\+risk\.riskTier/)
 assert.match(card,/security\.reversible\.'\+risk\.reversible/)
 assert.match(card,/attention\.security\.targets',\{count:risk\.targets\}/)
 assert.match(card,/attention\.row\.riskUnavailable/)
 // 风险行不再把用户支去动作区
 assert.doesNotMatch(card,/riskInActions/)
})

test('依据行是叙述：原因加对象摘要走 Markdown 子集，且不加载远程图片',()=>{
 assert.match(card,/<MarkdownPreview markdown=\{basis\} empty=\{t\('evidence\.emptyBody'\)\} images=\{false\}\/>/)
 assert.match(card,/attentionReasonText\(item\.reason,key=>t\(key\)\)/)
 assert.match(card,/summary\?\.trim\(\)/)
 assert.match(frame,/summary:action\?\.goal/)
})

test('展开中的事项不被筛选抽走，展开按钮用 aria-controls 指向卡片',()=>{
 assert.match(page,/aria-controls=\{expandedAttention===item\.id\?cardId:undefined\}/)
 // 存储写入不能留在 setState 更新函数里：更新函数必须是纯的
 assert.doesNotMatch(page,/setExpandedAttention\(current=>/)
 assert.match(page,/const cardId='teloa-attention-card-'\+item\.id\.replace/)
 assert.match(page,/item\.id===expandedAttention\|\|matchedAttention\.some\(row=>row\.id===item\.id\)/)
 // 事项消失时 state 与 sessionStorage 一起清
 assert.match(page,/if\(next===expandedAttention\)return\n\s*writeExpandedAttention\(sessionStorage,next\)/)
})

test('面板拉取失败不静默：卡内给错误与重试',()=>{
 assert.match(security,/export function SecurityPanelFallback/)
 assert.match(frame,/<SecurityPanelFallback error=\{securityPanelErrors\[taskId\]\} retry=/)
 // 旧面板副本还在时也要把重载失败摆出来，不能让人对着可能已经不成立的阶段下手
 assert.match(frame,/panelError:securityPanelErrors\[taskId\]/)
 // I5：三拍终态与错误与面板错误同层，卡片只显示，不再自己拿 useState 存结论。
 assert.match(frame,/const \[securityDecisionOutcome,setSecurityDecisionOutcome\]=useState<Record<string,SecurityDecisionOutcome>>\(\{\}\)/)
 assert.match(frame,/outcome:securityDecisionOutcome\[outcomeKey\]/)
 assert.match(security,/const awaitingExecute=outcome\?\.awaitingExecute===true,error=outcome\?\.error/)
 assert.doesNotMatch(security,/setAwaitingExecute|setError\(/)
 assert.match(security,/\{panelError!==undefined&&<>/)
 assert.match(frame,/setSecurityPanelErrors\(previous=>\(\{\.\.\.previous,\[taskId\]:localizeWorkError\(locale,cause\)\}\)\)/)
})

test('面板拉取带代次守卫：迟到的旧响应不盖新面板，也不盖新错误',()=>{
 // 对照 SecurityActions.tsx 的 generation ref：外壳这条路径原先一条守卫都没有。
 assert.match(frame,/const securityPanelLoads=useRef<Record<string,number>>\(\{\}\)/)
 assert.match(frame,/const generation=\(securityPanelLoads\.current\[taskId\]\?\?0\)\+1/)
 assert.match(frame,/const current=\(\)=>securityPanelLoads\.current\[taskId\]===generation/)
 assert.match(frame,/if\(!origin\|\|!current\(\)\)return undefined/)
 assert.match(frame,/if\(!current\(\)\)return undefined/)
 assert.match(frame,/if\(current\(\)\)setSecurityPanelErrors/)
})
