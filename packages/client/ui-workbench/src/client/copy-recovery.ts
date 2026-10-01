export type CopyAttempt={ownerId:string;requestId:string;sourceSessionId:string;state:'pending'|'ready'|'rejected';childSessionId?:string;createdAt:string;releasedAt?:string}
export function isCopyAttempt(value:unknown):value is CopyAttempt {
  if(!value||typeof value!=='object')return false
  const row=value as Record<string,unknown>
  return (row.releasedAt===undefined||typeof row.releasedAt==='string'&&Number.isFinite(Date.parse(row.releasedAt))&&row.state!=='rejected')&&typeof row.ownerId==='string'&&typeof row.requestId==='string'&&typeof row.sourceSessionId==='string'&&['pending','ready','rejected'].includes(String(row.state))&&typeof row.createdAt==='string'&&Number.isFinite(Date.parse(row.createdAt))&&(row.state==='ready'?typeof row.childSessionId==='string':row.childSessionId===undefined||row.state==='pending'&&typeof row.childSessionId==='string')
}
