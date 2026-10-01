import { readBusinessDashboardResource, type BusinessDashboardResourceDefinition, readBusinessActionDefinition, readBusinessObjectTypeDefinition, readBusinessViewDefinition, readIndustryDataSourceDefinition, readIndustryMcpConnectionDefinition, readIndustryPluginDefinition, type BusinessActionDefinition, type BusinessObjectTypeDefinition, type BusinessViewDefinition, type IndustryDataSourceDefinition, type IndustryMcpConnectionDefinition, type IndustryPluginDefinition } from '@teloa/contract'
import { parseIndustryPlan, type IndustryPlanDefinition } from './industry-plan-definition.ts'
import { validateManifest, type MarketManifest } from './market-preview.ts'
import type { IndustryContent } from './industry-directory.ts'
import type { IndustryManifest } from './industry-manifest.ts'
import type { RoleFields } from './role-preview.ts'

export type IndustryDefinition={kind:'skill';text:string;files:{path:string;hash:string;size:number}[]}|IndustryPlanDefinition|{kind:'role';fields:Pick<RoleFields,'name'|'kind'|'duty'|'dataScope'|'executionScope'>}|{kind:'knowledge';text:string}|{kind:'work-template';manifest:Extract<MarketManifest,{format:'teloa.work-template/v1'}>}|{kind:'data-source';definition:IndustryDataSourceDefinition}|{kind:'mcp';definition:IndustryMcpConnectionDefinition}|{kind:'plugin';definition:IndustryPluginDefinition}|{kind:'object-type';definition:BusinessObjectTypeDefinition}|{kind:'business-view';definition:BusinessViewDefinition}|{kind:'business-action';definition:BusinessActionDefinition}|{kind:'business-configuration';definition:BusinessDashboardResourceDefinition}
export type IndustryInspection={id:string;state:'parsed'|'invalid'|'pending'|'missing'|'unresolved';message:string;definition?:IndustryDefinition}
/**
 * 三类业务声明的身份判据，与既有 `plugin` / `work-template` 两支同形。
 * 为什么两条都要核：读取层按清单项的 `resource.id` 当 `source.localId` 落库，却按正文的 `definition.id`
 * 建跨引用索引（视图的 `objectType`、动作的 `objectType`、对象类型的 `defaultAction`）；两者不等时
 * 清单上点得到的那一项与被引用的那一项就不是同一个，加载之后整条引用链错位。版本同理：
 * 清单版本参与 `definitionHash`，与正文版本不一致会让「声明已更新」的判据指向一份不存在的正文。
 */
function businessIdentity<T extends {id:string;version:string}>(definition:T,resource:{id:string;version:string}):T{
 if(definition.id!==resource.id)throw Error('业务声明标识与行业声明不一致。')
 if(definition.version!==resource.version)throw Error('业务声明版本与行业声明不一致。')
 return definition
}
function parseRole(raw:string):IndustryDefinition{
 let value:unknown
 try{value=JSON.parse(raw)}catch{throw Error('员工文件不是有效 JSON。')}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('员工定义必须为对象。')
 const row=value as Record<string,unknown>
 for(const key of Object.keys(row))if(!['format','name','kind','duty','dataScope','executionScope'].includes(key))throw Error('员工包含未知字段：'+key)
 if(row.format!=='teloa.role/v1')throw Error('不支持的员工格式。')
 if(row.kind!=='employee'&&row.kind!=='twin')throw Error('员工身份类型必须为员工或分身。')
 const text=(key:string,max=4000)=>{const value=row[key];if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('员工 '+key+' 必须填写且不超过 '+max+' 字。');return value.trim()}
 return {kind:'role',fields:{name:text('name',80),kind:row.kind,duty:text('duty'),dataScope:text('dataScope'),executionScope:text('executionScope')}}
}

/** 只解析内容，不由模板正文产生权限，也不运行任何脚本。 */
export function inspectIndustryContent(manifest:IndustryManifest,content:IndustryContent):IndustryInspection[]{
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
 const files=new Map(content.files.map(file=>[file.path,file]))
 const rows=manifest.resources.map((resource):IndustryInspection=>{
  const id=resource.id
  if(resource.source.kind==='public'){
   const reference=resource.source
   const resolved=content.resolved?.find(row=>row.resourceId===id&&row.sourceResourceId===reference.id&&row.kind===resource.kind&&row.version===resource.version)
   if(resolved)return {...structuredClone(resolved.inspection),id,message:resolved.inspection.state==='parsed'?'引用内容已解析，未授予运行权限。':'引用内容已取得，仍待宿主核验。'}
   return {id,state:'unresolved',message:'公共资源版本尚待解析。'}
  }
  const file=files.get(root+resource.source.path)
  if(!file)return {id,state:'missing',message:'缺少资源文件：'+resource.source.path}
  if(resource.kind==='execution-tool')return {id,state:'pending',message:'内容已读取，待对应宿主适配器核验。'}
  try{
   if(resource.kind==='knowledge'&&!/\.(md|txt)$/i.test(resource.source.path))return {id,state:'pending',message:'此知识格式尚待专用解析器处理。'}
   let raw:string
   try{raw=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)}catch{throw Error('文件不是有效 UTF-8 文本。')}
   if(!raw.trim())throw Error('资源内容不能为空。')
   if(resource.kind==='skill'){
    const path=root+resource.source.path,folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):''
    const files=content.files.filter(value=>value.path.startsWith(folder)).map(value=>({path:value.path.slice(folder.length),hash:value.hash,size:value.bytes.length}))
    return {id,state:'pending',message:'技能原文已读取；格式、依赖和运行条件还没检查，尚未安装。',definition:{kind:'skill',text:raw,files}}
   }
   let definition:IndustryDefinition
   if(resource.kind==='data-source')definition={kind:'data-source',definition:readIndustryDataSourceDefinition(JSON.parse(raw))}
   else if(resource.kind==='mcp')definition={kind:'mcp',definition:readIndustryMcpConnectionDefinition(JSON.parse(raw))}
   else if(resource.kind==='plugin'){
    const value=readIndustryPluginDefinition(JSON.parse(raw))
    if(value.version!==resource.version)throw Error('扩展版本与行业声明不一致。')
    definition={kind:'plugin',definition:value}
   }
   /**
    * 三类业务声明必须各自单独分支，不能落到末尾的 `else`：落过去会被当成 `{kind:'knowledge',text:raw}`，
    * 预览就用 `<pre>` 把整份 JSON 原文打在页面上——字段的 `from`（别人快照里的字段标签）、`values`
    * （枚举取值）、动作 `from:'literal'` 的字面量全都跟着露出来，与规格 §7.3「摘要只显示结构，
    * 不显示任何取值样例」正好相反。正文一律走契约 `read*` 重建，不自己 `JSON.parse` 后取属性。
    */
   else if(resource.kind==='object-type')definition={kind:'object-type',definition:businessIdentity(readBusinessObjectTypeDefinition(JSON.parse(raw)),resource)}
   else if(resource.kind==='business-view')definition={kind:'business-view',definition:businessIdentity(readBusinessViewDefinition(JSON.parse(raw)),resource)}
   else if(resource.kind==='business-action')definition={kind:'business-action',definition:businessIdentity(readBusinessActionDefinition(JSON.parse(raw)),resource)}
   else if(resource.kind==='business-configuration'){
    const value=businessIdentity(readBusinessDashboardResource(JSON.parse(raw)),resource)
    if(value.configuration.scope!==manifest.scope)throw Error('业务看板范围与行业声明不一致。')
    definition={kind:'business-configuration',definition:value}
   }
   else if(resource.kind==='plan')definition=parseIndustryPlan(raw,resource.version)
   else if(resource.kind==='work-template'){
    let value:unknown;try{value=JSON.parse(raw)}catch{throw Error('任务模板不是有效 JSON。')}
    const work=validateManifest(value)
    if(work.format!=='teloa.work-template/v1')throw Error('工作入口必须引用任务模板。')
    if(work.version!==resource.version)throw Error('任务模板版本与行业声明不一致。')
    if(work.domain!=='general'&&work.domain!==manifest.scope)throw Error('任务模板的业务范围不匹配。')
    definition={kind:'work-template',manifest:work}
   }else definition=resource.kind==='role'?parseRole(raw):{kind:'knowledge',text:raw}
   return {id,state:'parsed',message:'内容已解析，尚未加载到工作空间。',definition}
  }catch(error){return {id,state:'invalid',message:resource.source.path+'：'+(error instanceof Error?error.message:'资源解析失败。')}}
 })
 return rows.map(row=>{
  if(row.definition?.kind!=='plan')return row
  const definition=row.definition,work=rows.find(item=>item.id===definition.workTemplate)
  const owners=manifest.relations.filter(link=>link.kind==='role-work'&&link.to===row.id).map(link=>rows.find(item=>item.id===link.from))
  if(work?.definition?.kind!=='work-template'||owners.length!==1||owners[0]?.definition?.kind!=='role'||owners[0].definition.fields.kind!=='employee')return {id:row.id,state:'invalid',message:'计划须引用已解析任务模板，并关联一个员工。'}
  return row
 })
}
