import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'

/** 模型用途与聊天模型选择分开；声明只引用市场固定版本，不携带下载地址、凭据或执行代码。 */
export const industryModelUsages=['speech-to-text','text-to-speech','embedding','rerank','ocr','classification','extraction','chat'] as const
export type IndustryModelDependency={catalogId:string;version:string;usage:typeof industryModelUsages[number];required:boolean}
export const industryPackageFormats=['teloa.business-package/v2','teloa.business-package/v3','teloa.business-package/v4'] as const
export type IndustryPackageFormat=typeof industryPackageFormats[number]
export const isIndustryPackageFormat=(value:unknown):value is IndustryPackageFormat=>industryPackageFormats.some(format=>format===value)

/** 新完整配置资源仅进入显式 v4；旧格式继续按原资源白名单读取，不能悄悄忽略页面。 */
export function assertIndustryConfigurationResourceFormat(format:unknown,kind:unknown):void{
 if(kind==='business-configuration'&&format!=='teloa.business-package/v4')throw new WorkError('teloa/invalid-input','完整业务配置资源仅支持 teloa.business-package/v4。')
}

/** 缺省与显式空列表不能混同：v2 不允许携带这个字段，v3 的声明一旦存在就必须有内容。 */
export function readIndustryModelDependencies(value:unknown):IndustryModelDependency[]{
 const bad=()=>new WorkError('teloa/invalid-input','模型依赖须包含 1～16 项固定目录版本、用途及必需标记，不能包含下载地址或运行配置。')
 if(!Array.isArray(value)||!value.length||value.length>16)throw bad()
 const seen=new Set<string>()
 return value.map(input=>{
  if(!isRecord(input)||Object.keys(input).length!==4||Object.keys(input).some(key=>!['catalogId','version','usage','required'].includes(key)))throw bad()
  if(typeof input.catalogId!=='string'||!/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,2}$/.test(input.catalogId)||typeof input.version!=='string'||input.version.length>80||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input.version)||!industryModelUsages.includes(input.usage as IndustryModelDependency['usage'])||typeof input.required!=='boolean')throw bad()
  // 同一用途不能在一个入口里同时绑定同一模型的两个版本；版本切换须走方案升级。
  const key=input.catalogId+'\0'+input.usage
  if(seen.has(key))throw bad()
  seen.add(key)
  return {catalogId:input.catalogId,version:input.version,usage:input.usage as IndustryModelDependency['usage'],required:input.required}
 })
}

/** 清单、固定快照和 RPC 读取共用边界，避免某条链忽略新依赖后继续执行。 */
export function industryResourceModelDependencies(kind:unknown,value:unknown):{modelDependencies?:IndustryModelDependency[]}{
 if(value===undefined)return {}
 if(kind!=='skill'&&kind!=='work-template')throw new WorkError('teloa/invalid-input','模型依赖只能声明在技能或任务模板上。')
 return {modelDependencies:readIndustryModelDependencies(value)}
}

export const industryModelPhases=['unsupported','disabled','unprepared','checking','downloading','loading','waking','ready','standby','cancelling','cancelled','failed','unavailable'] as const
export type IndustryModelPhase=typeof industryModelPhases[number]
export type IndustryModelProbe=(dependency:IndustryModelDependency)=>Promise<IndustryModelPhase>
export const industryModelReady=(phase:IndustryModelPhase)=>phase==='ready'||phase==='standby'

/** 入口在创建与再次执行前重验；未接入探针不能被当作模型就绪。准备和下载始终属于独立的用户操作。 */
export async function assertIndustryModelsReady(dependencies:readonly IndustryModelDependency[]|undefined,probe?:IndustryModelProbe):Promise<void>{
 for(const dependency of dependencies??[]){
  if(!dependency.required)continue
  const phase=probe?await probe(dependency):'unavailable'
  if(!industryModelReady(phase))throw new WorkError('teloa/dependency-unavailable','此入口需要的本地模型尚未就绪，请先到方案准备清单处理。',{model:dependency.catalogId,version:dependency.version,usage:dependency.usage,phase})
 }
}

export type IndustryModelObservation=IndustryModelDependency&{title:string;phase:IndustryModelPhase}
export function readIndustryModelObservations(value:unknown):IndustryModelObservation[]{
 if(!Array.isArray(value)||!value.length||value.length>16)throw new WorkError('teloa/invalid-input','模型状态清单格式不正确。')
 const dependencies=readIndustryModelDependencies(value.map(row=>{
  if(!isRecord(row)||Object.keys(row).some(key=>!['catalogId','version','usage','required','title','phase'].includes(key))||typeof row.title!=='string'||!row.title.trim()||row.title.length>120||!industryModelPhases.includes(row.phase as IndustryModelPhase))throw new WorkError('teloa/invalid-input','模型状态清单格式不正确。')
  return {catalogId:row.catalogId,version:row.version,usage:row.usage,required:row.required}
 }))
 return dependencies.map((dependency,index)=>({...dependency,title:value[index].title,phase:value[index].phase}))
}
