import {isRecord} from './resources.ts'
export const businessTemplateImpactReasons=['removed-object','removed-field','changed-type','changed-rule','changed-source','invalid-existing-value'] as const
export type BusinessTemplateUpgradeImpact={blocked:boolean;affectedRecords:number;fields:Array<{objectType:string;field:string;reason:typeof businessTemplateImpactReasons[number];affectedRecords:number}>;newSourceRequirements:string[]}
export function readBusinessTemplateUpgradeImpact(value:unknown):BusinessTemplateUpgradeImpact{
 const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0
 if(!isRecord(value)||Object.keys(value).some(key=>!['blocked','affectedRecords','fields','newSourceRequirements'].includes(key))||typeof value.blocked!=='boolean'||!count(value.affectedRecords)||value.blocked!==(Number(value.affectedRecords)>0)||!Array.isArray(value.fields)||value.fields.length>20000||!Array.isArray(value.newSourceRequirements)||value.newSourceRequirements.some(row=>typeof row!=='string'||!row||row.length>128))throw Error('业务模板影响报告不合法。')
 for(const row of value.fields)if(!isRecord(row)||Object.keys(row).length!==4||typeof row.objectType!=='string'||typeof row.field!=='string'||!(businessTemplateImpactReasons as readonly unknown[]).includes(row.reason)||!count(row.affectedRecords)||Number(row.affectedRecords)>Number(value.affectedRecords))throw Error('业务模板字段影响不合法。')
 return value as BusinessTemplateUpgradeImpact
}
