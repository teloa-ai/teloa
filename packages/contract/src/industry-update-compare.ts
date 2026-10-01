import type {IndustryModelDependency} from './industry-model-dependencies.ts'

/**
 * 行业模板升级的比较核：只吃两份固定内容的清单、包内文件摘要与公共引用解析结果，
 * 不认识浏览器的解析产物，也不认识服务端的实例表，因此客户端与服务端可以跑同一份判定。
 * 客户端在外层补上解析状态、本地岗位与关联工作，服务端在外层补上实例与回执。
 */
export type IndustryUpdateResourceSource={kind:'local';path:string}|{kind:'public';id:string;version:string}
export type IndustryUpdateResource={id:string;kind:string;title:string;version:string;required:boolean;source:IndustryUpdateResourceSource;modelDependencies?:IndustryModelDependency[]}
export type IndustryUpdateManifest={title:string;description:string;resources:readonly IndustryUpdateResource[];relations:readonly {kind:string;from:string;to:string}[];entrypoints:readonly string[]}
export type IndustryUpdateFile={path:string;hash:string}
/** 公共引用的解析结果；`sourceFiles` 只有浏览器侧取得过引用包时才有，两侧缺省时同样可比。 */
export type IndustryUpdateResolved={resourceId:string;sourceItemId:string;sourceResourceId:string;sourceHash:string;sourceFiles?:readonly IndustryUpdateFile[]}
export type IndustryUpdateSide={manifest:IndustryUpdateManifest;manifestPath:string;files:readonly IndustryUpdateFile[];resolved?:readonly IndustryUpdateResolved[]}
export type IndustryUpdateChange='added'|'removed'|'changed'|'unchanged'
export type IndustryUpdateResourceDiff={id:string;title:string;kind:string;change:IndustryUpdateChange;reasons:string[]}
export type IndustryUpdateLinkChange={kind:string;from:string;to:string;change:'added'|'removed'}
export type IndustryUpdateEntrypointChange={id:string;change:'added'|'removed'}
/** 同一资源标识换了类型：不能就地升级，必须换标识单独迁移，因此单列出来而不是混进 `changed`。 */
export type IndustryUpdateKindChange={id:string;title:string;before:string;after:string}
export type IndustryUpdateCoreDiff={
 resources:IndustryUpdateResourceDiff[];relationChanges:IndustryUpdateLinkChange[];entrypointChanges:IndustryUpdateEntrypointChange[]
 relationsChanged:boolean;entrypointsChanged:boolean;positioningChanged:boolean;kindChanges:IndustryUpdateKindChange[]
}
export type IndustryUpdateResourceChoice='keep'|'candidate'|'detach'|'skip'
export type IndustryUpdateRoleChoice='keep-local'|'use-template'
export type IndustryUpdateChoices={
 resources:Record<string,IndustryUpdateResourceChoice>
 roles:Record<string,IndustryUpdateRoleChoice>
 relations:'keep'|'candidate';entrypoints:'keep'|'candidate';positioning:'keep'|'candidate'
}

/** 稳定序列化：对象按键名排序后展开，`undefined` 也有确定写法，供摘要与逐项比较共用。 */
export function industryUpdateCanonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(industryUpdateCanonical).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+industryUpdateCanonical(item)).join(',')+'}'
 return JSON.stringify(value)??'undefined'
}
/**
 * 资源的内容指纹：包内资源按清单同级目录下的文件摘要，公共引用按解析结果；未解析的引用一律视作不可比。
 * 注意：`resolved.sourceFiles` 只有客户端有（服务端的引用记录里没有引用包的文件清单）。
 * 因此含公共引用资源的模板，客户端与服务端算出的规范化差异（以及它的 sha256 摘要）会不同——
 * 变化判定本身不受影响（由 `sourceHash` 捕获）。若将来要让客户端复核服务端的 `diffDigest`，
 * 必须先把 `sourceFiles` 一并传到服务端，否则两侧摘要永远对不上。
 */
export function industryUpdateContents(side:IndustryUpdateSide,resource:IndustryUpdateResource):string{
 if(resource.source.kind==='public'){
  const resolved=side.resolved?.find(row=>row.resourceId===resource.id)
  return resolved?industryUpdateCanonical([resolved.sourceItemId,resolved.sourceResourceId,resolved.sourceHash,resolved.sourceFiles?.map(file=>[file.path,file.hash])]):'unresolved'
 }
 const root=side.manifestPath.includes('/')?side.manifestPath.slice(0,side.manifestPath.lastIndexOf('/')+1):''
 const path=root+resource.source.path,folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):''
 return industryUpdateCanonical(side.files.filter(file=>file.path===path||(resource.kind==='skill'&&file.path.startsWith(folder))).map(file=>[file.path.slice(root.length),file.hash]).sort(([a],[b])=>a!.localeCompare(b!)))
}
/** 两份固定内容的资源级差异；不读取实例、不判断可用性，同一入参永远得到同一结果。 */
export function compareIndustryUpdateCore(before:IndustryUpdateSide,after:IndustryUpdateSide):IndustryUpdateCoreDiff{
 const ids=[...new Set([...before.manifest.resources.map(row=>row.id),...after.manifest.resources.map(row=>row.id)])]
 const resources=ids.map((id):IndustryUpdateResourceDiff=>{
  const old=before.manifest.resources.find(row=>row.id===id),next=after.manifest.resources.find(row=>row.id===id),reasons:string[]=[]
  if(old&&next){
   if(industryUpdateCanonical(old)!==industryUpdateCanonical(next))reasons.push('定义')
   if(industryUpdateCanonical(old.modelDependencies)!==industryUpdateCanonical(next.modelDependencies))reasons.push('模型依赖')
   if(industryUpdateContents(before,old)!==industryUpdateContents(after,next))reasons.push('内容')
  }
  return {id,title:(next||old)!.title,kind:(next||old)!.kind,change:!old?'added':!next?'removed':reasons.length?'changed':'unchanged',reasons}
 })
 const kindChanges=before.manifest.resources.flatMap((old):IndustryUpdateKindChange[]=>{
  const next=after.manifest.resources.find(row=>row.id===old.id)
  return next&&next.kind!==old.kind?[{id:old.id,title:next.title,before:old.kind,after:next.kind}]:[]
 })
 const relationChanges:IndustryUpdateLinkChange[]=[
  ...before.manifest.relations.filter(row=>!after.manifest.relations.some(next=>industryUpdateCanonical(row)===industryUpdateCanonical(next))).map(row=>({...row,change:'removed' as const})),
  ...after.manifest.relations.filter(row=>!before.manifest.relations.some(old=>industryUpdateCanonical(row)===industryUpdateCanonical(old))).map(row=>({...row,change:'added' as const})),
 ]
 const entrypointChanges:IndustryUpdateEntrypointChange[]=[
  ...before.manifest.entrypoints.filter(id=>!after.manifest.entrypoints.includes(id)).map(id=>({id,change:'removed' as const})),
  ...after.manifest.entrypoints.filter(id=>!before.manifest.entrypoints.includes(id)).map(id=>({id,change:'added' as const})),
 ]
 return {
  resources,relationChanges,entrypointChanges,kindChanges,
  relationsChanged:industryUpdateCanonical(before.manifest.relations.map(industryUpdateCanonical).sort())!==industryUpdateCanonical(after.manifest.relations.map(industryUpdateCanonical).sort()),
  entrypointsChanged:industryUpdateCanonical([...before.manifest.entrypoints].sort())!==industryUpdateCanonical([...after.manifest.entrypoints].sort()),
  positioningChanged:before.manifest.title!==after.manifest.title||before.manifest.description!==after.manifest.description,
 }
}
/**
 * 由行业资源实例骨架（industry-instance-kit）管理状态的四类资源：只有它们有"解除"这个终态。
 * 知识、岗位、能力、计划与任务的本地对象在模板移除后一律保留，因此移除时只能搁置。
 * 三类业务定制声明（object-type/business-view/business-action）故意不进这张表：它们没有实例行，
 * 移除时只能 skip（搁置），与 work-template、plan 一致。
 */
export const industryUpdateDetachableKinds:readonly string[]=['data-source','execution-tool','mcp','plugin']
/**
 * 每类变化允许的处理方式：新增只能取候选或跳过；移除时只有四类可解除的资源能选"解除"，其余只能搁置；
 * 其余变化可沿用、取候选或跳过。
 */
export function industryUpdateResourceOptions(change:IndustryUpdateChange,kind:string,reasons:readonly string[]=[]):readonly IndustryUpdateResourceChoice[]{
 // 继任加载固定采用候选清单；现有 keep 只保留本地实例，不能保留另一份模型声明。
 // 明确采用候选才可改变模型依赖，取消升级可继续使用旧方案，不能伪称已沿用旧依赖。
 if(change==='changed'&&reasons.includes('模型依赖'))return ['candidate']
 if(change==='added')return ['candidate','skip']
 if(change==='removed')return industryUpdateDetachableKinds.includes(kind)?['detach','skip']:['skip']
 return ['keep','candidate','skip']
}
const resourceChoices:readonly string[]=['keep','candidate','detach','skip']
const roleChoices:readonly string[]=['keep-local','use-template']
const sides:readonly string[]=['keep','candidate']
const stableId=(value:string)=>/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const record=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('升级选择格式不正确。')
 return value as Record<string,unknown>
}
/** 只校验形状：键是资源标识或岗位实例身份，值属于既定取值；与差异是否一致由 `industryUpdateChoiceProblem` 判定。 */
export function readIndustryUpdateChoices(value:unknown):IndustryUpdateChoices{
 const row=record(value)
 for(const key of Object.keys(row))if(!['resources','roles','relations','entrypoints','positioning'].includes(key))throw Error('升级选择格式不正确。')
 const resources=record(row.resources),roles=record(row.roles)
 if(Object.keys(resources).length>500||Object.keys(roles).length>500)throw Error('升级选择项数超出上限。')
 for(const [key,choice] of Object.entries(resources))if(!stableId(key)||typeof choice!=='string'||!resourceChoices.includes(choice))throw Error('资源处理方式不正确。')
 for(const [key,choice] of Object.entries(roles))if(!uuid(key)||typeof choice!=='string'||!roleChoices.includes(choice))throw Error('员工处理方式不正确。')
 for(const key of ['relations','entrypoints','positioning'] as const)if(typeof row[key]!=='string'||!sides.includes(row[key] as string))throw Error('关联、入口与行业说明必须选择保留或采用候选。')
 return {
  resources:{...resources} as IndustryUpdateChoices['resources'],roles:{...roles} as IndustryUpdateChoices['roles'],
  relations:row.relations as 'keep'|'candidate',entrypoints:row.entrypoints as 'keep'|'candidate',positioning:row.positioning as 'keep'|'candidate',
 }
}
/**
 * 选择必须逐项覆盖发生变化的资源、且只覆盖它们：未变化的资源一律沿用旧实例，不需要也不接受选择。
 * 返回第一处不一致的原因，全部合规时返回 undefined；调用方决定把它变成拒绝码还是界面提示。
 */
export function industryUpdateChoiceProblem(diff:IndustryUpdateCoreDiff,choices:IndustryUpdateChoices):string|undefined{
 const decided=diff.resources.filter(row=>row.change!=='unchanged')
 for(const row of decided){
  const choice=choices.resources[row.id]
  if(!choice)return row.title+'：请选择处理方式。'
  if(!industryUpdateResourceOptions(row.change,row.kind,row.reasons).includes(choice))return row.title+(row.reasons.includes('模型依赖')?'：模型依赖已变化，请明确采用候选版本；保留旧版请取消本次升级。':'：处理方式与资源变化不符。')
 }
 for(const id of Object.keys(choices.resources))if(!decided.some(row=>row.id===id))return '资源选择与当前差异不一致，请重新比较。'
 return undefined
}
