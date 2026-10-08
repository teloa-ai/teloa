/** 保留筛选只消费调用方核实的元数据，不读取或删除任何文件。 */
export interface MaintenanceRetentionEntry {
 id: string
 createdAt?: string
 completedAt?: string
 status?: string
 ownerVerified?: boolean
 recoveryVerified?: boolean
 independentReadyStarts?: number
 bytes?: number
}
export interface MaintenanceRetentionPolicy {
 minimumAgeMs?: number
 minimumReadyStarts?: number
}
const minimumAgeMs = 7 * 24 * 60 * 60 * 1000
const minimumReadyStarts = 2
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN

export function selectMaintenanceRetention<T extends MaintenanceRetentionEntry>({entries,protectedIds = [],now = Date.now(),policy = {}}: {
 entries: readonly T[]
 protectedIds?: readonly string[]
 now?: number
 policy?: MaintenanceRetentionPolicy
}): {keep: T[]; eligible: T[]} {
 if(!Array.isArray(entries)||!Array.isArray(protectedIds)||!Number.isFinite(now))throw Error('维护保留参数无效。')
 const age = Math.max(minimumAgeMs, Number.isSafeInteger(policy.minimumAgeMs) ? policy.minimumAgeMs! : minimumAgeMs)
 const starts = Math.max(minimumReadyStarts, Number.isSafeInteger(policy.minimumReadyStarts) ? policy.minimumReadyStarts! : minimumReadyStarts)
 const protectedSet = new Set(protectedIds), counts = new Map<string,number>()
 for(const row of entries)counts.set(row.id,(counts.get(row.id)??0)+1)
 const verified = entries.filter(row=>row.ownerVerified===true&&row.recoveryVerified===true&&Number.isFinite(time(row.createdAt))&&time(row.createdAt)<=now)
 const latest = verified.slice().sort((a,b)=>time(b.createdAt)-time(a.createdAt)||a.id.localeCompare(b.id))[0]
 // 没有核实恢复点时，不能靠待删元数据自行放行。
 const eligible:T[] = [], keep:T[] = []
 for(const row of entries){
  const created = time(row.createdAt), completed = time(row.completedAt)
  const removable = latest!==undefined&&row!==latest&&typeof row.id==='string'&&row.id.length>0&&counts.get(row.id)===1&&!protectedSet.has(row.id)&&row.status==='completed'&&row.ownerVerified===true&&row.recoveryVerified===true&&Number.isFinite(created)&&Number.isFinite(completed)&&completed>=created&&completed<=now&&now-completed>=age&&Number.isSafeInteger(row.independentReadyStarts)&&row.independentReadyStarts!>=starts
  ;(removable?eligible:keep).push(row)
 }
 return {keep,eligible}
}
