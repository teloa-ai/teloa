import type {SkillInstallationRecord,SkillInstallPreview,SkillInstallSourceIdentity,SkillInstallSourceInput,SkillInstallUsage} from './skill-install-api.js'

export const mergeSkillInstallation=(current:SkillInstallationRecord|undefined,incoming:SkillInstallationRecord|undefined)=>!incoming?current:!current||current.id!==incoming.id||incoming.version>current.version?incoming:incoming.version<current.version?current:current.state==='installed'&&incoming.state==='preparing'?current:incoming

export function uniqueSkillInstallations(items:readonly SkillInstallationRecord[]):SkillInstallationRecord[]{
  const byId=new Map<string,SkillInstallationRecord>()
  for(const item of items)byId.set(item.id,mergeSkillInstallation(byId.get(item.id),item)!)
  return [...byId.values()]
}

const canonical=(value:SkillInstallSourceIdentity)=>value.kind==='industry-local'?JSON.stringify(['industry-local',value.contentId,value.contentHash,value.resourceId,value.resourceVersion]):value.kind==='industry-public'?JSON.stringify(['atomic',value.sourceContentId,value.sourceContentHash,value.sourceResourceId,value.sourceResourceVersion]):JSON.stringify(['atomic',value.contentId,value.contentHash,value.resourceId,value.resourceVersion])

export function selectSkillInstallation(source:SkillInstallSourceInput,preview:SkillInstallPreview,items:SkillInstallationRecord[],usages:SkillInstallUsage[]){
  if(source.kind==='atomic')return {record:items.find(item=>canonical(item.source)===canonical(preview.source)),linked:true}
  const usage=usages.find(value=>value.loadId===source.loadId&&value.itemInstanceId===source.itemInstanceId)
  if(usage)return {record:items.find(item=>item.id===usage.installationId),linked:true}
  return {record:items.find(item=>canonical(item.source)===canonical(preview.source)),linked:false}
}

export const skillPendingForSource=(pending:{source:SkillInstallSourceInput}|undefined,source:SkillInstallSourceInput)=>!!pending&&(source.kind==='atomic'?pending.source.kind==='atomic'&&pending.source.contentId===source.contentId:pending.source.kind==='industry'&&pending.source.loadId===source.loadId&&pending.source.itemInstanceId===source.itemInstanceId)

export async function recoverSkillForSource(api:{pending:()=>{source:SkillInstallSourceInput}|undefined;recover:()=>Promise<SkillInstallationRecord>},source:SkillInstallSourceInput){
  if(!skillPendingForSource(api.pending(),source))throw Error('待核对的技能安装请求已变化，请从全局安装目录继续核对。')
  return api.recover()
}
