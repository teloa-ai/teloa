import type {SkillInstallationRecord,SkillInstallPreview,SkillInstallSourceIdentity,SkillInstallSourceInput,SkillInstallUsage} from './skill-install-api.js'

export const mergeSkillInstallation=(current:SkillInstallationRecord|undefined,incoming:SkillInstallationRecord|undefined)=>!incoming?current:!current||current.id!==incoming.id||incoming.version>current.version?incoming:incoming.version<current.version?current:current.state==='installed'&&incoming.state==='preparing'?current:incoming

export function uniqueSkillInstallations(items:readonly SkillInstallationRecord[]):SkillInstallationRecord[]{
  const byId=new Map<string,SkillInstallationRecord>()
  for(const item of items)byId.set(item.id,mergeSkillInstallation(byId.get(item.id),item)!)
  return [...byId.values()]
}

const canonical=(value:SkillInstallSourceIdentity)=>value.kind==='industry-local'?JSON.stringify(['industry-local',value.contentId,value.contentHash,value.resourceId,value.resourceVersion]):value.kind==='industry-public'?JSON.stringify(['atomic',value.sourceContentId,value.sourceContentHash,value.sourceResourceId,value.sourceResourceVersion]):JSON.stringify(['atomic',value.contentId,value.contentHash,value.resourceId,value.resourceVersion])

const nativeKeys=['name','description','bodyHash','modelInvocable','userInvocable'] as const
/** 包内方法可在包升级后沿用，仍须逐项核对资源版本、完整字节、原生元数据与信任说明；公共/原子来源保持固定原件身份。 */
const sameReference=(installed:SkillInstallSourceIdentity,requested:SkillInstallSourceIdentity)=>canonical(installed)===canonical(requested)||installed.kind==='industry-local'&&requested.kind==='industry-local'&&installed.resourceId===requested.resourceId&&installed.resourceVersion===requested.resourceVersion
export type SkillInstallDifference='source'|'files'|'trust'|'native'
export type SkillInstallMismatch={record:SkillInstallationRecord;fields:SkillInstallDifference[]}
export function skillInstallationDifferences(record:SkillInstallationRecord,preview:SkillInstallPreview):SkillInstallDifference[]{
  return [...(!sameReference(record.source,preview.source)?['source' as const]:[]),...(record.bundleHash!==preview.bundleHash?['files' as const]:[]),...(record.trustHash!==preview.trustHash?['trust' as const]:[]),...(!nativeKeys.every(key=>record.native[key]===preview.native[key])?['native' as const]:[])]
}
export const skillInstallationMatchesPreview=(record:SkillInstallationRecord,preview:SkillInstallPreview)=>skillInstallationDifferences(record,preview).length===0

export function selectSkillInstallation(source:SkillInstallSourceInput,preview:SkillInstallPreview,items:SkillInstallationRecord[],usages:SkillInstallUsage[]):{record:SkillInstallationRecord|undefined;linked:boolean;mismatch?:SkillInstallMismatch}{
  const selected=(record:SkillInstallationRecord|undefined,linked:boolean)=>{const fields=record?skillInstallationDifferences(record,preview):[];return {record,linked,...(record&&fields.length?{mismatch:{record,fields}}:{})}}
  if(source.kind==='atomic')return selected(items.find(item=>canonical(item.source)===canonical(preview.source)),true)
  const usage=usages.find(value=>value.loadId===source.loadId&&value.itemInstanceId===source.itemInstanceId)
  if(usage)return selected(items.find(item=>item.id===usage.installationId),true)
  const reusable=items.find(item=>skillInstallationMatchesPreview(item,preview))
  if(reusable)return selected(reusable,false)
  // 相近安装仅用于说明差异，绝不能作为已关联或可复用的事实。
  const nearby=items.find(item=>canonical(item.source)===canonical(preview.source)||item.source.kind==='industry-local'&&preview.source.kind==='industry-local'&&item.source.resourceId===preview.source.resourceId||item.native.name===preview.native.name)
  return {record:undefined,linked:false,...(nearby?{mismatch:{record:nearby,fields:skillInstallationDifferences(nearby,preview)}}:{})}
}

export const skillPendingForSource=(pending:{source:SkillInstallSourceInput}|undefined,source:SkillInstallSourceInput)=>!!pending&&(source.kind==='atomic'?pending.source.kind==='atomic'&&pending.source.contentId===source.contentId:pending.source.kind==='industry'&&pending.source.loadId===source.loadId&&pending.source.itemInstanceId===source.itemInstanceId)

export async function recoverSkillForSource(api:{pending:()=>{source:SkillInstallSourceInput}|undefined;recover:()=>Promise<SkillInstallationRecord>},source:SkillInstallSourceInput){
  if(!skillPendingForSource(api.pending(),source))throw Error('待核对的技能安装请求已变化，请从全局安装目录继续核对。')
  return api.recover()
}
