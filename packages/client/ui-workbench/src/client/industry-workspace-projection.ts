import type {IndustryLoadRecord} from './industry-load-api.js'

export const industryWorkspaceDestinations=['digital-employee','knowledge','team-capability','task','continuous-work','business-data','business-execution','extension'] as const
export type IndustryWorkspaceDestination=typeof industryWorkspaceDestinations[number]

export const industryWorkspaceDestinationLabels:Record<IndustryWorkspaceDestination,string>={
 'digital-employee':'员工',knowledge:'资料','team-capability':'技能',task:'任务','continuous-work':'自动化','business-data':'数据与对象','business-execution':'执行记录',extension:'扩展',
}

export type IndustryWorkspaceProjection={
 destination:IndustryWorkspaceDestination
 kind:IndustryLoadRecord['items'][number]['kind']
 instanceId:string
 localId:string
 title:string
 version:string
 required:boolean
 status:IndustryLoadRecord['items'][number]['status']
 state:'registered'
 readiness:string
 source:{
  loadId:string
  contentId:string
  contentHash:string
  templateId:string
  templateTitle:string
  templateVersion:string
  spaceId:string
  spaceName:string
  spaceScope:string
  spaceVersion:number
 }
}

// 扩展（plugin）落 `extension`：它装在工作室层、不属于某个业务，但业务包可以带，加载后必须看得见
// （业务结构七行分类法第七行）。此前漏了这个落点，插件加载完在任何目录里都找不到。
// 三类业务定制声明（object-type / business-view / business-action）故意不在这两张表里：它们没有实例行，
// 也没有正式目录落点——读它们的是业务页台账本身（规格 §十 Q3），与 industry-template-presentation.ts 的
// destinationByKind 同一条裁定。没有落点的加载项在下面的投影里整项跳过，不冒充某个目录里的一行。
const destinationByKind:Partial<Record<IndustryLoadRecord['items'][number]['kind'],IndustryWorkspaceDestination>>={
 role:'digital-employee',
 knowledge:'knowledge',
 skill:'team-capability',
 mcp:'team-capability',
 'work-template':'task',
 plan:'continuous-work',
 'data-source':'business-data',
 'execution-tool':'business-execution',
 plugin:'extension',
}

const readinessByKind:Partial<Record<IndustryLoadRecord['items'][number]['kind'],string>>={
 role:'已登记，待创建员工',
 knowledge:'已登记，待加入资料',
 skill:'已登记，待安装',
 mcp:'已登记，待连接',
 'work-template':'已登记，可创建任务',
 plan:'已登记，可创建自动化',
 'data-source':'已登记，待接入',
 'execution-tool':'已登记，待授权',
 plugin:'已登记，待安装扩展',
}

/** 把真实加载记录投影到各正式目录；跳过项不成为工作空间资源。 */
export function projectIndustryWorkspace(loads:readonly IndustryLoadRecord[],filter:{scope?:string;destination?:IndustryWorkspaceDestination}={}):IndustryWorkspaceProjection[]{
 const rows:IndustryWorkspaceProjection[]=[]
 for(const load of loads){
  if(filter.scope&&load.space.scope!==filter.scope)continue
  for(const item of load.items){
   if(item.status==='skipped')continue
   const destination=destinationByKind[item.kind],readiness=readinessByKind[item.kind]
   // 没有正式目录落点的加载项（三类业务定制声明）整项跳过：它们由业务页台账直接读声明，不进任何目录列表。
   if(!destination||readiness===undefined)continue
   if(filter.destination&&destination!==filter.destination)continue
   rows.push({
    destination,kind:item.kind,instanceId:item.instanceId,localId:item.localId,title:item.title,version:item.version,required:item.required,status:item.status,state:'registered',readiness,
    source:{loadId:load.id,contentId:load.contentId,contentHash:load.contentHash,templateId:load.templateId,templateTitle:load.templateTitle,templateVersion:load.templateVersion,spaceId:load.space.id,spaceName:load.space.name,spaceScope:load.space.scope,spaceVersion:load.targetVersion},
   })
  }
 }
 return rows
}

export type IndustryWorkspaceDestinationSummary={destination:IndustryWorkspaceDestination;label:string;count:number;pending:string}

const pendingByDestination:Record<IndustryWorkspaceDestination,string>={
 'digital-employee':'待创建员工',knowledge:'待加入资料','team-capability':'待安装或连接',task:'可创建任务','continuous-work':'可创建自动化','business-data':'待接入数据源','business-execution':'待授权执行工具',extension:'待安装扩展',
}

/** 业务概览固定呈现八个落点；零资源的落点也保留，避免把未声明误认成已就绪。 */
export function summarizeIndustryWorkspace(loads:readonly IndustryLoadRecord[],scope:string):IndustryWorkspaceDestinationSummary[]{
 const rows=projectIndustryWorkspace(loads,{scope})
 return industryWorkspaceDestinations.map(destination=>({destination,label:industryWorkspaceDestinationLabels[destination],count:rows.filter(row=>row.destination===destination).length,pending:pendingByDestination[destination]}))
}
