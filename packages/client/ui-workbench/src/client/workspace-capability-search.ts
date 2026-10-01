import type {CapabilitySnapshot} from '@teloa/contract'
import type {MarketPluginInstallation} from './market-plugin-install-api.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import type {SkillAvailabilityApi} from './skill-availability-api.js'
import type {SkillInstallApi} from './skill-install-api.js'
import type {MarketSkillRuntimeFact} from './market-runtime-state.js'

export type WorkspaceCapabilitySearchType='skill'|'plugin'|'mcp'
export type WorkspaceCapabilityOpenTarget=
 | {kind:'installation';id:`skill:${string}`|`plugin:${string}`}
 | {kind:'team-capability';category:'source';selectedId:`connection:${string}`}
export type WorkspaceCapabilitySearchRow={
 key:string
 id:string
 type:WorkspaceCapabilitySearchType
 title:string
 detail:string
 open:WorkspaceCapabilityOpenTarget
}
export type WorkspaceCapabilitySearchSource={
 skills:readonly MarketSkillRuntimeFact[]
 plugins:readonly MarketPluginInstallation[]
 snapshot?:CapabilitySnapshot
}
export type WorkspaceCapabilitySearchFailure='skill'|'plugin'
export type WorkspaceCapabilitySearchDirectory={rows:WorkspaceCapabilitySearchRow[];failures:WorkspaceCapabilitySearchFailure[]}
export type WorkspaceCapabilitySearchPorts={
 skillInstallApi:Pick<SkillInstallApi,'list'|'observe'>
 skillAvailabilityApi:Pick<SkillAvailabilityApi,'get'>
 pluginInstallApi:Pick<MarketPluginInstallApi,'list'>
 snapshot?:CapabilitySnapshot
}

function availableSkill(fact:MarketSkillRuntimeFact):boolean{
 const {record,availability,observation}=fact,current=observation?.current
 return record.state==='installed'&&
  fact.verificationError!==true&&
  availability?.installationId===record.id&&
  availability.availability==='enabled'&&
  observation?.installationId===record.id&&
  observation.state==='available'&&
  current?.name===record.native.name&&
  current.bodyHash===record.native.bodyHash
}

function activePlugin(plugin:MarketPluginInstallation):boolean{
 const observed=plugin.observation,expected=plugin.preview
 return plugin.state==='installed-active'&&
  observed?.status==='active'&&
  observed.bundleHash===expected.bundleHash&&
  observed.source.registry===expected.source.registry&&
  observed.source.packageName===expected.source.packageName&&
  observed.source.version===expected.source.version
}

/**
 * 全局搜索只消费已经由持久安装记录与当前运行环境共同证明可用的能力。
 * 市场声明、准备中记录和无法核验的目录项都不在这里降级为可搜索结果。
 */
export function workspaceCapabilitySearchRows(source:WorkspaceCapabilitySearchSource):WorkspaceCapabilitySearchRow[]{
 const rows:WorkspaceCapabilitySearchRow[]=[]
 for(const fact of source.skills){
 if(!availableSkill(fact))continue
  const installationId=`skill:${fact.record.id}` as const
  rows.push({key:'skill:'+fact.record.id,id:fact.record.id,type:'skill',title:fact.record.native.name,detail:fact.record.native.description,open:{kind:'installation',id:installationId}})
 }
 for(const plugin of source.plugins){
  if(!activePlugin(plugin))continue
  const title=plugin.preview.source.packageName
  const installationId=`plugin:${plugin.id}` as const
  rows.push({key:'plugin:'+plugin.id,id:plugin.id,type:'plugin',title,detail:title+'@'+plugin.preview.source.version,open:{kind:'installation',id:installationId}})
 }
 const snapshot=source.snapshot
 if(snapshot?.conversation.status==='ready'&&snapshot.connections.status==='observed'){
  const seen=new Set<string>()
  for(const tool of snapshot.connections.tools){
   if(seen.has(tool.name))continue
   seen.add(tool.name)
   const selectedId=`connection:${tool.name}` as const
   rows.push({key:'mcp:'+tool.name,id:tool.name,type:'mcp',title:tool.name,detail:tool.description,open:{kind:'team-capability',category:'source',selectedId}})
  }
 }
 return rows
}

/** 各真实来源独立读取；单一来源失败不会把其它已核验结果伪装成空目录。 */
export async function loadWorkspaceCapabilitySearchDirectory(ports:WorkspaceCapabilitySearchPorts):Promise<WorkspaceCapabilitySearchDirectory>{
 const [skillResult,pluginResult]=await Promise.allSettled([ports.skillInstallApi.list(),ports.pluginInstallApi.list()])
 const skills:MarketSkillRuntimeFact[]=[]
 if(skillResult.status==='fulfilled'){
  const facts=await Promise.all(skillResult.value.items.map(async record=>{
   if(record.state!=='installed')return {record,availability:null,observation:null} satisfies MarketSkillRuntimeFact
   const [availability,observation]=await Promise.allSettled([ports.skillAvailabilityApi.get(record.id),ports.skillInstallApi.observe(record.id)])
   const failed=availability.status==='rejected'||observation.status==='rejected'
   return {record,availability:availability.status==='fulfilled'?availability.value:null,observation:observation.status==='fulfilled'?observation.value:null,...(failed?{verificationError:true as const}:{})} satisfies MarketSkillRuntimeFact
  }))
  skills.push(...facts)
 }
 const plugins=pluginResult.status==='fulfilled'?pluginResult.value.items:[]
 const failures:WorkspaceCapabilitySearchFailure[]=[]
 if(skillResult.status==='rejected')failures.push('skill')
 if(pluginResult.status==='rejected')failures.push('plugin')
 return {rows:workspaceCapabilitySearchRows({skills,plugins,...(ports.snapshot?{snapshot:ports.snapshot}:{})}),failures}
}
