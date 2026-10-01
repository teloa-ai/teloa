import {industryUpdateCanonical,readPageCreateBody,type BusinessActionDefinition,type BusinessObjectTypeDefinition,type BusinessViewDefinition,type IndustryDataSourceDefinition,type IndustryMcpConnectionDefinition} from '@teloa/contract'
import {readIndustryDirectory,type IndustryFileInput} from './industry-directory.ts'
import {validateIndustryManifest,type IndustryManifest,type IndustryResourceKind} from './industry-manifest.ts'
import type {MarketItem} from './market-preview.ts'

type ConnectorBody={manifest:IndustryManifest;resource:IndustryDataSourceDefinition|IndustryMcpConnectionDefinition}
type BusinessDefinition=BusinessObjectTypeDefinition|BusinessViewDefinition|BusinessActionDefinition
type BusinessDomainBody={manifest:IndustryManifest;definitions:BusinessDefinition[]}

const bytes=(value:unknown)=>new TextEncoder().encode(industryUpdateCanonical(value))
const input=(path:string,value:unknown):IndustryFileInput=>{
 const content=bytes(value)
 return {path,size:content.byteLength,read:async()=>content}
}
const manifestId=/^[a-zA-Z0-9][a-zA-Z0-9-]*$/

/**
 * 模型只提交可审阅正文；这里把已经过契约读取的连接器声明变成真正的 v2 包文件，
 * 再复用目录读取器固定文件摘要。确认后仍须走现有的市场导入、行业加载和本人授权，
 * 本函数绝不携带地址、凭据或连接动作。
 */
export async function pageCreateConnectorIndustryItem(value:unknown,name:string,scope:string):Promise<MarketItem>{
 const body=readPageCreateBody('connector',value,{manifest:validateIndustryManifest}) as ConnectorBody
 const {manifest,resource}=body
 if(manifest.scope!==scope)throw Error('连接草案的业务范围与当前业务空间不一致。')
 const kind:IndustryResourceKind=resource.format==='teloa.data-source/v1'?'data-source':'mcp'
 const id=resource.format==='teloa.data-source/v1'?resource.sourceId:resource.serverName
 const matches=manifest.resources.filter(candidate=>candidate.id===id&&candidate.kind===kind)
 if(manifest.resources.length!==1||matches.length!==1)throw Error('连接草案必须只声明一项对应的包内连接资源。')
 const declared=matches[0]!
 if(declared.source.kind!=='local')throw Error('连接草案必须只声明一项对应的包内连接资源。')
 if(resource.format==='teloa.data-source/v1'&&(!resource.scopes.includes(scope)||resource.scopes.some(item=>item!==scope)))throw Error('连接数据源范围必须与当前业务空间一致。')
 return readIndustryDirectory([input('teloa.json',manifest),input(declared.source.path,resource)],'teloa.json',name)
}

const definitionKind=(value:BusinessDefinition):IndustryResourceKind=>value.format==='teloa.business-object-type/v1'?'object-type':value.format==='teloa.business-view/v1'?'business-view':'business-action'
const sourceDefinition=(sourceId:string,scope:string):IndustryDataSourceDefinition=>({format:'teloa.data-source/v1',sourceId,scopes:[scope]})

/**
 * 新业务不是客户端临时拼出的空间：确认时固定为完整 v2 资源包，再由行业加载服务建立映射。
 * 清单只能包含这次草案的业务声明和其明确引用的数据源，避免模型把无关资源夹带进一次确认。
 */
export async function pageCreateBusinessDomainIndustryItem(value:unknown,name:string,scope:string):Promise<MarketItem>{
 const body=readPageCreateBody('business-domain',value,{manifest:validateIndustryManifest}) as BusinessDomainBody
 const {manifest,definitions}=body
 if(manifest.scope!==scope||definitions.some(definition=>definition.domain!==scope))throw Error('新业务草案的范围与当前业务空间不一致。')
 const definitionIds=new Set<string>()
 const sourceIds=new Set<string>()
 for(const definition of definitions){
  if(definitionIds.has(definition.id))throw Error('新业务草案中的业务声明标识重复。')
  definitionIds.add(definition.id)
  if(definition.format==='teloa.business-object-type/v1')sourceIds.add(definition.sourceId)
 }
 if([...sourceIds].some(sourceId=>!manifestId.test(sourceId)))throw Error('业务对象的数据源标识不能转换为行业资源标识。')
 const expected=new Map<string,IndustryResourceKind>()
 for(const definition of definitions)expected.set(definition.id,definitionKind(definition))
 for(const sourceId of sourceIds)expected.set(sourceId,'data-source')
 if(manifest.resources.length!==expected.size)throw Error('新业务草案的清单只能包含业务声明和其数据源。')
 const resources=new Map(manifest.resources.map(resource=>[resource.id,resource]))
 if(resources.size!==manifest.resources.length||[...expected].some(([id,kind])=>resources.get(id)?.kind!==kind||resources.get(id)?.source.kind!=='local'))throw Error('新业务草案的清单资源与声明不一致。')
 const files:IndustryFileInput[]=[input('teloa.json',manifest)]
 for(const definition of definitions){
  const resource=resources.get(definition.id)!
  files.push(input((resource.source as {kind:'local';path:string}).path,definition))
 }
 for(const sourceId of sourceIds){
  const resource=resources.get(sourceId)!
  files.push(input((resource.source as {kind:'local';path:string}).path,sourceDefinition(sourceId,scope)))
 }
 return readIndustryDirectory(files,'teloa.json',name)
}
