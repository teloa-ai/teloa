import type {RoleDailyLogPruneHint,RoleMemory} from '@teloa/contract'

export type RoleMemoryGroup={id:'pending'|'pruneSuggested'|'confirmed'|'withdrawn';titleKey:string;items:RoleMemory[]}

/**
 * 「判断力样本」页签分组：待确认（candidate）→ 建议撤回（已确认且被当前有效日志点名）→ 已确认 → 已撤回。
 * 只改呈现顺序，不改任何写口；`memoryStateVersion` 与当前记忆的 `stateVersion` 不一致时视为过期建议，
 * 该记忆仍留在「已确认」组（对应日志详情里同一条建议会单独显示为失效，见 dailyLog.pruneStale）。
 */
export function groupRoleMemories(memories:readonly RoleMemory[],pruneHints:readonly RoleDailyLogPruneHint[]):RoleMemoryGroup[]{
 const hints=new Map(pruneHints.map(hint=>[hint.memoryId,hint]))
 const pending:RoleMemory[]=[],pruneSuggested:RoleMemory[]=[],confirmed:RoleMemory[]=[],withdrawn:RoleMemory[]=[]
 for(const memory of memories){
  if(memory.state==='candidate'){pending.push(memory);continue}
  if(memory.state==='withdrawn'){withdrawn.push(memory);continue}
  const hint=hints.get(memory.id)
  if(hint&&hint.memoryStateVersion===memory.stateVersion)pruneSuggested.push(memory)
  else confirmed.push(memory)
 }
 return [
  {id:'pending',titleKey:'team.presentation.memory.candidate.label',items:pending},
  {id:'pruneSuggested',titleKey:'dailyLog.pruneHints',items:pruneSuggested},
  {id:'confirmed',titleKey:'team.presentation.memory.confirmed.label',items:confirmed},
  {id:'withdrawn',titleKey:'team.presentation.memory.withdrawn.label',items:withdrawn},
 ]
}
