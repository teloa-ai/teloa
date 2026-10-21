import {businessDashboardShareSnapshotText,readBusinessDashboardShareSnapshot,readBusinessDashboardShareTarget,type BusinessDashboardShareSnapshot,type BusinessDashboardShareTarget} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
const invalid=()=>Object.assign(Error('看板分享回包与原快照不一致。'),{code:'teloa/invalid-host-response'})
export async function dashboardShareDigest(text:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))
 return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')
}
/** 本人只读接口；固定目标、范围、版本和内容摘要全部核对后才用于文件或群附件。 */
export function createDashboardShareApi(call:Call){
 return async(target:BusinessDashboardShareTarget,signal?:AbortSignal):Promise<BusinessDashboardShareSnapshot>=>{
  const expected=readBusinessDashboardShareTarget(target)
  const result=readBusinessDashboardShareSnapshot(await call('business-dashboards/share-snapshot',{target:expected},signal))
  if(JSON.stringify(expected)!==JSON.stringify(result.target)||await dashboardShareDigest(businessDashboardShareSnapshotText(result))!==result.snapshotHash)throw invalid()
  signal?.throwIfAborted()
  return result
 }
}

