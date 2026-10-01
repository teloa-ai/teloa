import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidateV2} from './business-configuration-v2.ts'

export const businessDashboardResourceFormat='teloa.business-dashboard-resource/v1' as const
/**
 * 可复用资源固定自己的身份与版本；完整页面和定义沿用业务配置 v2。
 * scope、sourceId 是模板身份，采用前须由接收方显式选择目标并核对映射，不能当成现有业务授权。
 */
export type BusinessDashboardResourceDefinition={
 format:typeof businessDashboardResourceFormat
 id:string
 version:string
 configuration:BusinessConfigurationCandidateV2
}
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)

export function readBusinessDashboardResource(value:unknown):BusinessDashboardResourceDefinition{
 if(!isRecord(value)||Object.keys(value).length!==4||!['format','id','version','configuration'].every(key=>Object.hasOwn(value,key))||value.format!==businessDashboardResourceFormat)throw bad('业务看板资源格式不正确或包含未知字段。')
 if(typeof value.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value.id))throw bad('业务看板资源标识不合法。')
 if(typeof value.version!=='string'||value.version.length>80||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version))throw bad('业务看板资源版本必须是固定的三段版本号。')
 const configuration=readBusinessConfigurationCandidateV2(value.configuration)
 if(!configuration.pages.some(page=>page.kind==='dashboard'))throw bad('业务看板资源必须包含可预览的看板页面。')
 // 同步参数是开放集合，可含账号材料和宿主岗位身份；不可依靠参数名黑名单来猜脱敏。
 if(configuration.definitions.some(row=>row.kind==='source-mapping'))throw bad('业务看板资源不携带已有同步绑定；请在目标业务另行准备。')
 if(configuration.definitions.some(row=>row.kind==='object-type'&&row.definition.defaultAction!==undefined))throw bad('业务看板资源不携带已有默认动作；请在目标业务另行配置。')
 return {format:businessDashboardResourceFormat,id:value.id,version:value.version,configuration}
}
