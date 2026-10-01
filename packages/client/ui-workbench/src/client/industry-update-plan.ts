import {isIndustryManifest} from './industry-manifest.ts'
import {industryUpdateChoiceProblem,type IndustryUpdateChoices} from '@teloa/contract'
import { compareIndustryUpdate, type IndustryUpdateContext } from './industry-update.ts'
import type { IndustryLoadRecord, IndustryLoadUpgradeInput } from './industry-load-api.ts'
import type { MarketItem } from './market-preview.ts'

export type { IndustryUpdateChoices } from '@teloa/contract'
/**
 * 只把明确的处理意图整理成提交内容；不修改实例、不执行更新、也不宣布安装成功。
 * 资源级一致性由 contract 的比较核判定（服务端用同一函数复核）；这里只加客户端独有的判据：
 * 岗位本地修改必须明确处理、候选内容必须已取得、所选关联与入口不能引用被跳过或解除的资源。
 */
export function industryUpdateSubmission(context:IndustryUpdateContext,record:IndustryLoadRecord,baseline:MarketItem,candidate:MarketItem,choices:IndustryUpdateChoices,requestId:string):IndustryLoadUpgradeInput{
 const diff=compareIndustryUpdate(context,record,baseline,candidate)
 const candidateContentId=candidate.contentStorage?.contentId
 if(!candidateContentId)throw Error('候选模板尚未持久化，不能提交升级。')
 if(diff.sameContent)throw Error('内容相同，无需建立更新计划。')
 if(diff.blockers.length)throw Error(diff.blockers.join('\n'))
 const problem=industryUpdateChoiceProblem(diff,choices)
 if(problem)throw Error(problem)
 for(const row of diff.resources)if(choices.resources[row.id]==='candidate'&&row.after&&['invalid','missing','unresolved'].includes(row.after.state))throw Error(row.title+'：候选内容尚未取得或无效。')
 for(const role of diff.localRoles.filter(row=>row.fields.length)){
  if(!['keep-local','use-template'].includes(choices.roles[role.id]||''))throw Error(role.name+'：请明确处理本地修改。')
  if(role.state==='missing'&&choices.roles[role.id]==='use-template')throw Error('员工已离开目录，不能通过更新计划恢复。')
  // 运行中的岗位与身份类型变化都会让服务端的既有编辑判据整笔回滚升级，必须在提交前就拒绝（表单也已禁用该选项）。
  if(role.state==='active'&&choices.roles[role.id]==='use-template')throw Error(role.name+'：请先暂停员工再采用模板定义。')
  if(role.kindChanged&&choices.roles[role.id]==='use-template')throw Error(role.name+'：候选模板改了员工身份类型，不能采用模板定义。')
  const item=record.items.find(row=>row.instanceId===role.id),resource=item?choices.resources[item.localId]:undefined
  // 岗位资源本身未变化时比较核不接受任何处理方式（给了就报"与当前差异不一致"），但服务端仍按候选内容重放模板字段，
  // 因此只在确实要选处理方式时才要求选"采用候选"：否则带本地修改的未变化岗位会在两条判据之间无路可走。
  if(choices.roles[role.id]==='use-template'&&(!item||resource!==undefined&&resource!=='candidate'))throw Error(role.name+'：采用模板定义时必须同时采用候选员工资源。')
 }
 if(Object.keys(choices.roles).some(id=>!diff.localRoles.some(row=>row.id===id&&row.fields.length)))throw Error('员工选择已过期，请重新比较。')
 const retained=new Set(diff.resources.filter(row=>!['detach','skip'].includes(choices.resources[row.id]!)).map(row=>row.id))
 const manifest=(choices.relations==='candidate'?candidate:baseline).manifest!
 if(isIndustryManifest(manifest)&&manifest.relations.some(row=>!retained.has(row.from)||!retained.has(row.to)))throw Error('所选关联引用了跳过或解除关联的资源，请调整选择。')
 const entryManifest=(choices.entrypoints==='candidate'?candidate:baseline).manifest!
 if(isIndustryManifest(entryManifest)&&entryManifest.entrypoints.some(id=>!retained.has(id)))throw Error('所选常用入口引用了跳过或解除关联的资源，请调整选择。')
 return {requestId,loadId:record.id,candidateContentId,expectedMappingHash:record.mappingHash,choices:structuredClone(choices)}
}
