import type {ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'

type ReviewPhase='revise'|'verify'

const blockIds=(meaning:string)=>({
 type:'array',required:true,items:{type:'integer'},
 description:meaning+'；值必须为整数数组，没有编号时写 []，不能写空字符串、null 或省略。',
} as const)
const basis={type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
 sourceId:{type:'string',required:true},passageId:{type:'string',required:true},
}}} as const
const coverage={type:'object',required:true,additionalProperties:false,
 description:'每个问题独立划分整稿的全部块编号；每块只属于 change、retain、unrelated、unknown 之一。四个字段都是必填整数数组，无项写 []。未知仍不得交付。',
 properties:{
  change:blockIds('需要修改的块编号'),
  retain:blockIds('相关但保留原文的块编号；保留不代表事实已通过'),
  unrelated:blockIds('与此问题无关的块编号'),
  unknown:blockIds('尚无法确定的块编号；没有未知块时必须写 []'),
  unlisted:{type:'string',const:'retain',required:true,description:'当前简写必须显式写 retain，将未列编号归入相关保留并由R2逐块核对；保留不代表事实已通过。'},
 },
} as const
const issue={type:'object',additionalProperties:false,properties:{
 problem:{type:'string',required:true},basis,
 affectedScope:{type:'string',const:'coverage',required:true,description:'固定写 coverage，位于每个 issues[i] 内，与 coverage、edits 同级；不提交 affectedBlockIds。'},
 coverage,
 edits:{type:'array',required:true,description:'位于每个 issues[i] 内；按本单元块编号提供完整替换文字，不放到工具参数顶层。同一 blockId 在整个 issues 数组中只能编辑一次；多个问题涉及同一块时，合并为一个问题和一份最终替换。',items:{type:'object',additionalProperties:false,properties:{
  blockId:{type:'integer',required:true},after:{type:'string',required:true},
 }}},
}} as const
const checks={type:'array',required:true,description:'完整且不重复地核对 goal 与 1 至 8；每项写 pass、fail 或 unknown。',items:{type:'object',additionalProperties:false,properties:{
 id:{oneOf:[{type:'string',const:'goal'},{type:'integer',enum:[1,2,3,4,5,6,7,8]}],required:true},
 status:{type:'string',enum:['pass','fail','unknown'],required:true},
}}} as const
const changeChecks={type:'array',required:true,description:'只使用宿主给出的变更 issueId 和依赖块编号；没有待核变更时写 []。',items:{type:'object',additionalProperties:false,properties:{
 issueId:{type:'string',required:true},status:{type:'string',enum:['verified','unresolved','unknown'],required:true},
 reviewedBlockIds:blockIds('已核对的当前稿依赖块编号'),
}}} as const
const findings={type:'array',required:true,description:'按原目标、资料和方法核对出的实质问题；无问题时写 []，不在此提交修改文字。',items:{type:'object',additionalProperties:false,properties:{
 problem:{type:'string',required:true},basis,blockIds:blockIds('问题涉及的当前稿块编号'),
}}} as const

/** 只收窄模型可见的当前阶段参数；真实登记工具与历史解析器继续执行既有严格校验。 */
export function createDeliveryReviewToolParameters(phase:ReviewPhase,sources?:readonly {id:string;passages:readonly {id:string}[]}[]):ParameterSchemaSpec{
 // 只收窄本轮模型可选的来源组合，实际引文还原及事实核对仍由宿主严格执行。
 // 编辑基线等没有可引用片段的来源不进入选项：空 enum 会让整个工具 schema 非法。
 const choices=sources?.filter(source=>source.passages.length).map(source=>({type:'object' as const,additionalProperties:false,properties:{sourceId:{type:'string' as const,const:source.id,required:true},passageId:{type:'string' as const,enum:source.passages.map(passage=>passage.id),required:true}}}))
 // 大型冻结上下文仍完整保留在来源目录；不将全部身份再次展开为巨型工具 schema。
 // 这里只限制模型呈现，工具体仍逐项核对来源/片段配对、摘要、覆盖范围及编辑，未知引用不会被接受。
 const currentBasis=(choices?.length&&Buffer.byteLength(JSON.stringify(choices),'utf8')<=12000
  ?{...basis,items:choices.length===1?choices[0]:{oneOf:choices}}
  :{...basis,description:'仅逐字选择本轮冻结来源目录中的 sourceId 与 passageId 配对；不得猜测。宿主按完整目录校验，未知或串错配对仍拒绝。'}) as unknown as typeof basis
 const currentIssue={...issue,properties:{...issue.properties,basis:currentBasis}}
 const currentFindings={...findings,items:{...findings.items,properties:{...findings.items.properties,basis:currentBasis}}}
 if(phase==='revise')return {
  phase:{type:'string',const:'revise',required:true},
  issues:{type:'array',required:true,description:'本阶段只提交问题组；没有需改问题时写 []。每组仅包含 problem、basis、affectedScope、coverage、edits。change/retain/unrelated/unknown 只能放在 coverage 内；不要添加 changes、change 或 affectedBlockIds 等同级字段。',items:currentIssue},
 }
 return {
  phase:{type:'string',const:'verify',required:true},
  verdict:{type:'string',enum:['accept','reject'],required:true},
  checks,changeChecks,findings:currentFindings,
 }
}

/** 只示范字段位置与类型；示例编号和来源不能代替宿主本轮提供的真实目录。 */
export function deliveryReviewToolShapeExample(phase:ReviewPhase):string{
 if(phase==='revise')return '仅示范一个块的 JSON 形状，编号、来源与内容须以本轮宿主目录为准，不可照抄：'+JSON.stringify({
  phase:'revise',issues:[{problem:'第1块与原资料不符。',basis:[{sourceId:'goal',passageId:'p1'}],affectedScope:'coverage',coverage:{change:[1],retain:[],unrelated:[],unknown:[],unlisted:'retain'},edits:[{blockId:1,after:'依据原资料修订后的第1块。'}]}],
 })+'。affectedScope、coverage、edits 均在同一个 issues[i] 内；四类编号均用数组，空集合写 []；当前简写必须显式提交 coverage.unlisted:"retain"，未列块仍由R2逐块核对。 Each issue has exactly these five keys: problem, basis, affectedScope, coverage, edits. Put change only inside coverage; never add changes or change beside coverage. If issues overlap on a block, merge their problems and write that block once with all corrections combined. Do not submit competing replacements.'
 return '仅示范无待核变更、无问题时的 JSON 形状；状态必须来自本轮实际核对：'+JSON.stringify({
  phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[],
 })+'。本阶段不提交 issues、edits、after 或任何改稿字段；存在问题或未知时应 reject，并完整填写对应核对结果。'
}
