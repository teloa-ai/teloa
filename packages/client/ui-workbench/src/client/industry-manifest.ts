import {localizedMetadata,assertIndustryConfigurationResourceFormat,isIndustryPackageFormat,industryResourceModelDependencies,type IndustryPackageFormat,type IndustryModelDependency,type LocalizedMetadata} from '@teloa/contract'

/** 行业集合只描述资源与关联；读取、安装和授权由各自服务负责。 */
export const industryResourceKinds=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration'] as const
export type IndustryResourceKind=typeof industryResourceKinds[number]
export const industryResourceLabels:Record<IndustryResourceKind,string>={role:'员工模板',knowledge:'知识',skill:'技能',mcp:'MCP 连接',plugin:'扩展','data-source':'数据源','execution-tool':'执行工具','work-template':'任务模板',plan:'持续计划','object-type':'对象类型','business-view':'业务视图','business-action':'业务动作','business-configuration':'业务看板'}
export type IndustryResourceLocalizedMetadata={title?:LocalizedMetadata}
export type IndustryResource={id:string;kind:IndustryResourceKind;title:string;localized?:IndustryResourceLocalizedMetadata;version:string;required:boolean;source:{kind:'local';path:string}|{kind:'public';id:string;version:string};modelDependencies?:IndustryModelDependency[]}
const relationTargets={
 'role-knowledge':['knowledge'],
 'role-skill':['skill'],
 'role-connection':['mcp','data-source','execution-tool'],
 'role-work':['work-template','plan'],
} as const
export type IndustryRelation={kind:keyof typeof relationTargets;from:string;to:string}
export type IndustryLocalizedMetadata={title?:LocalizedMetadata;description?:LocalizedMetadata}
/**
 * `domain` 是市场中的行业归类，`scope` 是加载到本人工作空间后的业务范围。
 * 早期 v2 清单只写 domain；为了让既有私有模板仍可加载，省略 scope 时沿用 domain。
 */
export type IndustryManifest={format:IndustryPackageFormat;id:string;title:string;version:string;domain:string;scope:string;description:string;localized?:IndustryLocalizedMetadata;resources:IndustryResource[];relations:IndustryRelation[];entrypoints:string[]}

function object(input:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('行业定义必须为对象。')
 for(const key of Object.keys(input))if(!keys.includes(key))throw Error('未知字段：'+key)
 return input as Record<string,unknown>
}
function text(input:unknown,label:string,max=120):string{
 if(typeof input!=='string'||!input.trim()||input.length>max)throw Error(label+'必须填写且不超过 '+max+' 字。')
 return input.trim()
}
function id(input:unknown):string{
 const value=text(input,'资源标识')
 if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value))throw Error('资源标识仅允许字母、数字和连字符。')
 return value
}
function version(input:unknown):string{
 const value=text(input,'固定版本',80)
 if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value))throw Error('版本必须是固定的三段版本号，不接受范围或 latest。')
 return value
}
function list(input:unknown,label:string,max=500):unknown[]{
 if(!Array.isArray(input)||input.length>max)throw Error(label+'必须是列表且不超过 '+max+' 项。')
 return input
}
function resource(input:unknown,format:IndustryPackageFormat):IndustryResource{
 const row=object(input,['id','kind','title','localized','version','required','source',...(format!=='teloa.business-package/v2'?['modelDependencies']:[])])
 if(!industryResourceKinds.includes(row.kind as IndustryResourceKind))throw Error('不支持的行业资源类型。')
 assertIndustryConfigurationResourceFormat(format,row.kind)
 if(typeof row.required!=='boolean')throw Error('资源 required 必须为布尔值。')
 const base={id:id(row.id),kind:row.kind as IndustryResourceKind,title:text(row.title,'资源名称'),version:version(row.version),required:row.required}
 let localized:IndustryResourceLocalizedMetadata|undefined
 if(row.localized!==undefined){
  const value=object(row.localized,['title']);localized={}
  if(value.title!==undefined){
   const title=localizedMetadata(value.title)
   if(title.original!==base.title)throw Error('资源本地化元数据的稳定原文必须与资源名称一致。')
   localized.title=title
  }
 }
 const metadata={...(localized?{localized}:{}),...industryResourceModelDependencies(row.kind,row.modelDependencies)}
 const source=object(row.source,['kind','path','id','version'])
 if(source.kind==='local'){
  object(source,['kind','path'])
  const path=text(source.path,'资源路径',300)
  if(path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(path))throw Error('资源路径必须为安全的包内相对路径。')
  return {...base,...metadata,source:{kind:'local',path}}
 }
 if(source.kind==='public'){
  object(source,['kind','id','version'])
  const sourceVersion=version(source.version)
  if(sourceVersion!==base.version)throw Error('公共引用版本与资源版本不一致。')
  return {...base,...metadata,source:{kind:'public',id:id(source.id),version:sourceVersion}}
 }
 throw Error('资源来源必须为包内内容或固定公共引用。')
}
export function validateIndustryManifest(input:unknown):IndustryManifest{
 const hasScope=!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.hasOwn(input,'scope')
 const row=object(input,['format','id','title','version','domain','scope','description','localized','resources','relations','entrypoints'])
 if(!isIndustryPackageFormat(row.format))throw Error('不支持的行业模板版本。')
 const format=row.format
 const resources=list(row.resources,'行业资源').map(input=>resource(input,format))
 if(!resources.length)throw Error('行业资源集合不能为空。')
 const byId=new Map(resources.map(value=>[value.id,value]))
 if(byId.size!==resources.length)throw Error('行业资源标识重复。')
 const seen=new Set<string>()
 const relations=list(row.relations,'资源关联',2000).map(input=>{
  const relation=object(input,['kind','from','to'])
  if(typeof relation.kind!=='string'||!Object.hasOwn(relationTargets,relation.kind))throw Error('未知的资源关联类型。')
  const kind=relation.kind as IndustryRelation['kind'],from=id(relation.from),to=id(relation.to)
  const source=byId.get(from),target=byId.get(to)
  if(!source||!target)throw Error('关联的资源不存在：'+from+' 到 '+to)
  const allowed:readonly string[]=relationTargets[kind]
  if(source.kind!=='role'||!allowed.includes(target.kind))throw Error('资源关联类型不匹配：'+from+' 到 '+to)
  const key=kind+':'+from+':'+to
  if(seen.has(key))throw Error('资源关联重复：'+key)
  seen.add(key)
  return {kind,from,to}
 })
 const entrypoints=list(row.entrypoints,'业务入口').map(id)
 if(new Set(entrypoints).size!==entrypoints.length)throw Error('业务入口重复。')
 for(const entry of entrypoints)if(!['skill','work-template'].includes(byId.get(entry)?.kind??''))throw Error('业务入口须引用存在的技能或任务模板：'+entry)
 const title=text(row.title,'行业名称'),description=text(row.description,'行业定位',2000)
 let localized:IndustryLocalizedMetadata|undefined
 if(row.localized!==undefined){
  const localizedRow=object(row.localized,['title','description']);localized={}
  for(const field of ['title','description'] as const)if(localizedRow[field]!==undefined){
   const value=localizedMetadata(localizedRow[field])
   if(value.original!==(field==='title'?title:description))throw Error('本地化元数据的稳定原文必须与清单字段一致。')
   localized[field]=value
  }
 }
 const domain=text(row.domain,'行业分类',80)
 const scope=hasScope?text(row.scope,'业务范围',80):domain
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(scope))throw Error('业务范围只能是 1–64 位字母、数字、下划线或连字符。')
 return {format:row.format,id:id(row.id),title,version:version(row.version),domain,scope,description,...(localized?{localized}:{}),resources,relations,entrypoints}
}

/** 已解析清单的类型判别；不代替 validateIndustryManifest 对不可信输入的校验。 */
export function isIndustryManifest(value:{format:string}|null|undefined):value is IndustryManifest{return !!value&&isIndustryPackageFormat(value.format)}
