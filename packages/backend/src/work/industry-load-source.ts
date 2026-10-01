import {WorkError,readIndustryDataSourceDefinition,type IndustryModelDependency,type IndustryUpdateManifest} from '@teloa/contract'
import {validateManifest,type MarketContentStore,type MarketResourceKind} from '../market/content-store.ts'

export type IndustryLoadSourceSnapshot={
 /**
  * v2 清单上线前的来源快照没有该字段。加载服务会在边界按 domain 补齐，
  * 因此端口保留可选形态，避免历史来源因格式升级而不可读取。
  */
 templateId:string;templateVersion:string;title:string;domain:string;scope?:string;description:string
 resources:{localId:string;kind:MarketResourceKind;title:string;version:string;required:boolean;available:boolean;sourceNoun?:string;modelDependencies?:IndustryModelDependency[]}[]
 relations:{kind:string;from:string;to:string}[];entrypoints:string[]
}
/** 升级比较所需的固定内容切面：清单、包内文件摘要与公共引用解析结果，与客户端交给比较核的形状一致。 */
export type IndustryLoadContent={templateId:string;templateVersion:string;domain:string;scope:string;hash:string;manifestPath:string;manifest:IndustryUpdateManifest;files:{path:string;hash:string}[];resolved:{resourceId:string;sourceItemId:string;sourceResourceId:string;sourceHash:string}[]}
/** `content` 只有升级用；其余读写路径不需要，因此保持可选，缺省时升级显式失败而不静默降级。 */
export type IndustryLoadSource={
 read:(owner:string,contentId:string,contentHash:string)=>Promise<IndustryLoadSourceSnapshot>
 content?:(owner:string,contentId:string)=>Promise<IndustryLoadContent>
}

/** 只读取已持久化且复验过原始文件与公共引用的内容，不接收浏览器解析结果。 */
export function createIndustryLoadSource(store:Pick<MarketContentStore,'get'>):IndustryLoadSource{
 return {
  async content(owner,contentId){
   const content=await store.get({ownerId:owner,kind:'human'},{contentId})
   if(content.ownerId!==owner||content.id.toLowerCase()!==contentId.toLowerCase()||content.kind!=='industry-template')throw new WorkError('teloa/source-unavailable','行业模板固定来源不一致，请重新核对。')
   const manifest=validateManifest(content.metadata)
   return {templateId:manifest.id,templateVersion:manifest.version,domain:manifest.domain,scope:manifest.scope,hash:content.hash,manifestPath:content.manifestPath,manifest,files:content.files.map(file=>({path:file.path,hash:file.hash})),resolved:content.references.map(row=>({resourceId:row.resourceId,sourceItemId:row.sourceItemId,sourceResourceId:row.sourceResourceId,sourceHash:row.sourceHash}))}
  },
  async read(owner,contentId,contentHash){
   const content=await store.get({ownerId:owner,kind:'human'},{contentId})
   if(content.ownerId!==owner||content.id.toLowerCase()!==contentId.toLowerCase()||content.kind!=='industry-template'||content.hash!==contentHash)throw new WorkError('teloa/source-unavailable','行业模板固定来源不一致，请重新核对。')
   const manifest=validateManifest(content.metadata)
   const resources=manifest.resources.map(resource=>{
    // 模型暂不可用只影响使用它的入口；加载保留声明，准备清单及执行前探针负责报告和阻断。
    const available=resource.source.kind==='local'
     ?content.provides.some(item=>item.resourceId===resource.id&&item.kind===resource.kind&&item.version===resource.version)
     :content.references.some(item=>item.resourceId===resource.id)
    if(resource.required&&!available)throw new WorkError('teloa/source-unavailable','行业模板必需资源缺失：'+resource.title)
    // 这只是首页的展示称呼，不替代后续业务定义读取时的严格校验；正文还会在台账链路里按固定字节重验。
    let sourceNoun:string|undefined
    const localSource=resource.source.kind==='local'?resource.source:undefined
    if(available&&resource.kind==='data-source'&&localSource){
     const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
     const file=content.files.find(item=>item.path===root+localSource.path)
     if(file&&file.bytes.byteLength<=128*1024)try{sourceNoun=readIndustryDataSourceDefinition(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes))).sourceNoun}catch{/* 台账读取时会给出固定内容错误；首页只回落通用名词。 */}
    }
    return {localId:resource.id,kind:resource.kind,title:resource.title,version:resource.version,required:resource.required,available,...(sourceNoun===undefined?{}:{sourceNoun}),...(resource.modelDependencies?{modelDependencies:resource.modelDependencies}:{})}
   })
   return {templateId:manifest.id,templateVersion:manifest.version,title:manifest.title,domain:manifest.domain,scope:manifest.scope,description:manifest.description,resources,relations:manifest.relations,entrypoints:manifest.entrypoints}
  },
 }
}
