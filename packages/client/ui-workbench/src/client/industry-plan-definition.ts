import { validatePlanTrigger, type PlanTrigger } from './continuous-preview.ts'
export type IndustryPlanDefinition={kind:'plan';title:string;workTemplate:string;dataScope:string;trigger:PlanTrigger}
export function parseIndustryPlan(raw:string,version:string):IndustryPlanDefinition{
 let input:unknown;try{input=JSON.parse(raw)}catch{throw Error('计划文件不是有效 JSON。')}
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('计划定义必须为对象。')
 const row=input as Record<string,unknown>
 for(const key of Object.keys(row))if(!['format','version','title','workTemplate','dataScope','trigger'].includes(key))throw Error('计划包含未知字段：'+key)
 if(row.format!=='teloa.plan/v1'||row.version!==version)throw Error('计划格式或版本不匹配。')
 const text=(key:string,max:number)=>{const value=row[key];if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('计划 '+key+' 必须填写且不超过 '+max+' 字。');return value.trim()}
 if(!row.trigger||typeof row.trigger!=='object'||Array.isArray(row.trigger))throw Error('计划触发方式无效。')
 const trigger=row.trigger as Record<string,unknown>,keys=trigger.kind==='schedule'?['kind','cadence','weekday','time','timezone']:['kind','source','event']
 for(const key of Object.keys(trigger))if(!keys.includes(key))throw Error('计划触发包含未知字段：'+key)
 return {kind:'plan',title:text('title',120),workTemplate:text('workTemplate',120),dataScope:text('dataScope',8000),trigger:validatePlanTrigger(trigger as PlanTrigger)}
}
