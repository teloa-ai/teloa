import { inspectIndustryContent } from '../src/client/industry-content.ts'
import { changeTeamPreview } from '../src/client/team-preview.ts'
import { emptyTaskPreview, type TaskPreview } from '../src/client/task-preview.ts'
import type { IndustryLoad, LoadedIndustryResource } from '../src/client/industry-load.ts'
import type { MarketItem } from '../src/client/market-preview.ts'

/**
 * 测试夹具：把一份行业目录摆成"已加载"的页面状态。
 *
 * 个人版下加载只走宿主：页面提交后由 `IndustryLoadRecord` 回来，页面内不再有"就地加载"函数
 * （它带着新建空间的分支，与单空间相抵触，已删除）。仍按页面态读取的 `createIndustryTask`
 * 与 `industryPlanTemplate` 需要一份等价的固定状态，这里就地造出来，不进生产代码。
 */
export function loadedIndustryPreview(item:MarketItem,command:{id:string;scope:string;title:string;now:string},state:TaskPreview=emptyTaskPreview()):TaskPreview{
 const manifest=item.manifest,content=item.packageContent
 if(manifest?.format!=='teloa.business-package/v2'||!content)throw Error('夹具需要完整的行业目录。')
 const byId=new Map(inspectIndustryContent(manifest,content).map(row=>[row.id,row]))
 const resources:LoadedIndustryResource[]=manifest.resources.map(row=>({id:command.id+':'+row.id,localId:row.id,kind:row.kind,title:row.title,version:row.version,inspection:byId.get(row.id)!}))
 const instances=new Map(resources.map(row=>[row.localId,row.id]))
 const record:IndustryLoad={
  id:command.id,requestKey:JSON.stringify([item.id,content.hash,command.scope]),spaceId:command.scope,itemId:item.id,sourceHash:content.hash,
  title:manifest.title,version:manifest.version,createdAt:command.now,resources,
  relations:manifest.relations.filter(row=>instances.has(row.from)&&instances.has(row.to)).map(row=>({kind:row.kind,from:instances.get(row.from)!,to:instances.get(row.to)!})),
  entrypoints:manifest.entrypoints.flatMap(id=>instances.has(id)?[instances.get(id)!]:[]),skipped:[],
 }
 let next:TaskPreview={...state,industryLoads:[...state.industryLoads,record],business:{...state.business,spaces:[...state.business.spaces,{scope:command.scope,title:command.title,kind:'domain',loads:1,activeLoads:1,tasks:0,groups:0}]}}
 for(const resource of resources){
  const definition=resource.inspection.definition
  if(definition?.kind!=='role')continue
  const links=manifest.relations.filter(row=>row.from===resource.localId)
  const titles=(kind:string)=>links.filter(row=>row.kind===kind&&instances.has(row.to)).map(row=>manifest.resources.find(item=>item.id===row.to)!.title)
  next=changeTeamPreview(next,{type:'create',id:resource.id,fields:{...definition.fields,scopes:[command.scope],skills:titles('role-skill'),knowledge:titles('role-knowledge')},now:command.now})
 }
 return next
}
