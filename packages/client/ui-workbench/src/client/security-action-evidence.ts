import type {EvidenceEntry,SecurityAction,SecurityActionPanel,SecurityApprovalDecision,SecurityTargetReceipt} from '@teloa/contract'

type Format={
 receiptTitle:(kind:'acceptance'|'effect')=>string
 approvalTitle:(decision:SecurityApprovalDecision)=>string
 targetState:(state:SecurityTargetReceipt['state'])=>string
 goalTitle:string
 dispatchTitle:string
 dispatchSource:(dispatched:boolean)=>string
}

/**
 * 面板里的记录格式各异，这里统一成三类：数字员工写的 goal 与审批意见是叙述（Markdown），
 * 派发参数与外部回执是外部系统产出（原样等宽）。不做任何摘要或改写。
 * 所有面向人的文案由调用方按当前语言给出，映射本身不含文案。
 */
// 契约上限（`contract/src/evidence.ts`）在这里就收口：外部回执号、派发参数与回执正文都来自
// 外部系统，长度不受本仓控制。不在映射处夹住，条目就会在 readEvidenceEntry 那里整条被拒，
// 依据区当场少一条事实——而这正是人要逐字核对的那一条。
const TITLE_MAX=200,BODY_MAX=200000,SOURCE_MAX=256
const clamp=(value:string,max:number):string=>value.length<=max?value:value.slice(0,max-1)+'…'
// 只认规范化 ISO 串，与契约同一判据；对不上就不写这个字段，不拿一个会被拒的值去撞。
const observed=(value:string|undefined):{observedAt?:string}=>
 value!==undefined&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value?{observedAt:value}:{}
const entry=(row:{kind:EvidenceEntry['kind'];title:string;body:string;source?:string;observedAt?:string}):EvidenceEntry=>({
 kind:row.kind,title:clamp(row.title,TITLE_MAX),body:clamp(row.body,BODY_MAX),
 ...(row.source?{source:clamp(row.source,SOURCE_MAX)}:{}),...observed(row.observedAt),
})

export function securityActionEvidence(action:SecurityAction,panel:SecurityActionPanel,format:Format):EvidenceEntry[]{
 const entries:EvidenceEntry[]=[entry({kind:'text',title:format.goalTitle,body:action.goal,observedAt:action.createdAt})]
 const execution=panel.executions.find(row=>row.actionId===action.id)
 // 工具、剧本与目标是结构化字段，由面板既有区域承担；这条依据只放要逐字核对的参数本身，
 // 并且必须说清它此刻出自谁、什么时候：未执行是数字员工的提案，已执行是执行器的派发。
 entries.push(entry({
  kind:'command',
  title:format.dispatchTitle,
  body:JSON.stringify(action.params,null,2),
  source:format.dispatchSource(execution!==undefined),
  observedAt:execution?execution.createdAt:action.createdAt,
 }))
 for(const approval of panel.approvals.filter(row=>row.actionId===action.id)){
  entries.push(entry({kind:'text',title:format.approvalTitle(approval.decision),body:approval.reason,source:approval.approverId,observedAt:approval.createdAt}))
 }
 for(const kind of ['acceptanceReceipt','effectReceipt'] as const){
  const receipt=execution?.[kind]
  if(!receipt)continue
  entries.push(entry({
   kind:'log',
   title:format.receiptTitle(kind==='acceptanceReceipt'?'acceptance':'effect'),
   body:[receipt.detail,...receipt.targets.map(target=>target.target+' · '+format.targetState(target.state))].join('\n'),
   source:receipt.receiptId,
   observedAt:receipt.observedAt,
  }))
 }
 return entries
}
