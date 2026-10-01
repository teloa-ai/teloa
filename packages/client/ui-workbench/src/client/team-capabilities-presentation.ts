import type {CapabilitySnapshot} from '@teloa/contract'
import type {IndustryWorkspaceProjection} from './industry-workspace-projection.js'
import {CAPABILITY_ROW_IDS} from './industry-composition.js'
import type {CompositionItemState,CompositionRowId} from './industry-composition.js'

/**
 * 团队能力只管理可直接用于工作的 Skill 和连接。插件的发现、安装与维护
 * 留在市场，避免把运行时扩展和会话/业务能力混成同一份目录。
 * 分类 id 与状态词全部收敛到跨业务四行共享的 `CompositionRowId`/`CompositionItemState`，
 * 不再自造五档状态；这里只把原生快照与行业投影翻成条目，供能力页的详情面板取
 * `industry`/`instanceId`/`source`/`boundary` 字段。
 */
export type TeamCapabilityCategoryId=CompositionRowId
export type TeamCapabilityCategory={id:TeamCapabilityCategoryId;count:number}
export type TeamCapabilityRow={key:string;category:TeamCapabilityCategoryId;title:string;detail?:string;source?:string;status:CompositionItemState;origin:'native'|'industry';industry?:{spaceName:string;required:boolean;templateTitle:string;templateVersion:string;resourceVersion:string;templateId:string;contentHash:string};instanceId?:string;itemId?:string;intentId?:string}
export type TeamCapabilityCatalog={categories:TeamCapabilityCategory[];rows:TeamCapabilityRow[]}

const categories:readonly TeamCapabilityCategoryId[]=CAPABILITY_ROW_IDS

/** 行业资源三档与 `composeFromWorkspace` 同一口径：装好了才算数，实例化了只差授权/连接，其余待安装。 */
const settled=(status:IndustryWorkspaceProjection['status'])=>status==='active'

export function teamCapabilityCatalog({snapshot,industryResources=[]}:{snapshot?:CapabilitySnapshot;industryResources?:readonly IndustryWorkspaceProjection[]}):TeamCapabilityCatalog{
 const rows:TeamCapabilityRow[]=[]
 for(const skill of snapshot?.skills??[])rows.push({key:'skill:'+skill.name,category:'skill',title:skill.name,...(skill.description?{detail:skill.description}:{}),source:skill.source,status:'installed',origin:'native'})
 for(const tool of snapshot?.connections.status==='observed'?snapshot.connections.tools:[])rows.push({key:'source:'+tool.name,category:'source',title:tool.name,...(tool.description?{detail:tool.description}:{}),status:'connected',origin:'native'})
 for(const resource of industryResources){
  if(resource.destination!=='team-capability')continue
  rows.push({
    key:'industry:'+resource.instanceId,
    category:resource.kind==='skill'?'skill':'source',
   title:resource.title,
   status:resource.kind==='mcp'
    ?(settled(resource.status)?'connected':'disconnected')
    :(settled(resource.status)?'installed':resource.status==='instantiated'?'pending-authorization':'pending-install'),
   origin:'industry',
   industry:{spaceName:resource.source.spaceName,required:resource.required,templateTitle:resource.source.templateTitle,templateVersion:resource.source.templateVersion,resourceVersion:resource.version,templateId:resource.source.templateId,contentHash:resource.source.contentHash},
   instanceId:resource.instanceId,
  })
 }
 return {categories:categories.map(id=>({id,count:rows.filter(row=>row.category===id).length})),rows}
}
