import {isRecord} from './resources.ts'
export const businessTemplateImpactReasons=['removed-object','removed-field','changed-type','changed-rule','changed-source','invalid-existing-value'] as const
export type BusinessTemplateImpactField={objectType:string;field:string;reason:typeof businessTemplateImpactReasons[number];affectedRecords:number}
export type BusinessTemplateUpgradeImpact={blocked:boolean;affectedRecords:number;fields:BusinessTemplateImpactField[];newSourceRequirements:string[];warnings?:BusinessTemplateImpactField[]}
export function readBusinessTemplateUpgradeImpact(value:unknown):BusinessTemplateUpgradeImpact{
 const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0
 if(!isRecord(value)||Object.keys(value).some(key=>!['blocked','affectedRecords','fields','newSourceRequirements','warnings'].includes(key))||typeof value.blocked!=='boolean'||!count(value.affectedRecords)||value.blocked!==(Number(value.affectedRecords)>0)||!Array.isArray(value.fields)||value.fields.length>20000||!Array.isArray(value.newSourceRequirements)||value.newSourceRequirements.some(row=>typeof row!=='string'||!row||row.length>128))throw Error('业务模板影响报告不合法。')
 for(const row of value.fields)if(!isRecord(row)||Object.keys(row).length!==4||typeof row.objectType!=='string'||typeof row.field!=='string'||!(businessTemplateImpactReasons as readonly unknown[]).includes(row.reason)||!count(row.affectedRecords)||Number(row.affectedRecords)>Number(value.affectedRecords))throw Error('业务模板字段影响不合法。')
 if(value.warnings!==undefined){
  if(!Array.isArray(value.warnings)||value.warnings.length>20000)throw Error('历史数据警告不合法。')
  for(const row of value.warnings)if(!isRecord(row)||Object.keys(row).length!==4||typeof row.objectType!=='string'||typeof row.field!=='string'||row.reason!=='invalid-existing-value'||!count(row.affectedRecords)||Number(row.affectedRecords)<1)throw Error('历史数据警告不合法。')
 }
 return value as BusinessTemplateUpgradeImpact
}
