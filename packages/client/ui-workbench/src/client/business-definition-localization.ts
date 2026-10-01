import {resolveLocalizedMetadata,type BusinessActionDefinition,type BusinessRichFieldDefinition,type BusinessObjectFieldDefinition,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessViewDefinition,type BusinessViewMeasure,type BusinessViewResult,type LocalizedMetadata} from '@teloa/contract'

function text(metadata:LocalizedMetadata|undefined,original:string,locale:string):string{
 return metadata?resolveLocalizedMetadata(metadata,locale).value:original
}

export function localizedBusinessObjectType(definition:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2,locale:string){
 return {
  title:text(definition.localized?.title,definition.title,locale),
  unit:text(definition.localized?.unit,definition.unit,locale),
  lead:text(definition.localized?.lead,definition.lead,locale),
 }
}

export function localizedBusinessFieldLabel(field:BusinessObjectFieldDefinition|BusinessRichFieldDefinition,locale:string):string{
 return text('localized'in field?field.localized?.label:undefined,field.label,locale)
}

export function localizedBusinessFieldValue(field:BusinessObjectFieldDefinition|BusinessRichFieldDefinition,value:string,locale:string):string{
 if(field.type!=='enum'||!field.values)return value
 const index=field.values.indexOf(value)
 if(index<0)return value
 return text(field.localized?.values?.[index],value,locale)
}

export function localizedBusinessActionTitle(definition:BusinessActionDefinition,locale:string):string{
 return text(definition.localized?.title,definition.title,locale)
}

export function localizedBusinessViewTitle(definition:Pick<BusinessViewDefinition,'title'|'localized'>,locale:string):string{
 return text(definition.localized?.title,definition.title,locale)
}

export function localizedBusinessMeasureLabel(measure:Pick<BusinessViewMeasure,'label'|'localized'>,locale:string):string{
 return text(measure.localized?.label,measure.label,locale)
}

/** 布尔维度的人话：服务端分组键是 `'true'/'false'`，界面按字段类型换成本地化的是/否。 */
export type BusinessBooleanLabels={yes:string;no:string}
function dimensionLabel(field:BusinessObjectFieldDefinition,value:string,locale:string,labels?:BusinessBooleanLabels):string{
 if(field.type==='boolean'&&labels&&(value==='true'||value==='false'))return value==='true'?labels.yes:labels.no
 return localizedBusinessFieldValue(field,value,locale)
}

export function localizedBusinessView(view:BusinessViewResult,definition:BusinessObjectTypeDefinition,locale:string,labels?:BusinessBooleanLabels):BusinessViewResult{
 const title=text(view.localized?.title,view.title,locale)
 const dimension=view.dimensionField===undefined?undefined:definition.fields.find(field=>field.name===view.dimensionField)
 return {
  ...view,
  title,
  measures:view.measures.map(measure=>({...measure,label:text(measure.localized?.label,measure.label,locale)})),
  rows:view.rows.map(row=>({...row,label:view.kind==='board-card'?title:dimension?dimensionLabel(dimension,row.dimension,locale,labels):row.label})),
 }
}

/**
 * 时长（秒）按最大整单位写：天、小时、分钟、秒，最多一位小数；单位词由 `Intl` 按界面语言给出，不另建词条。
 * `number` 即 `useI18n().number`，测试里可换成任意 `Intl.NumberFormat`。
 */
export function durationText(seconds:number,number:(value:number,options?:Intl.NumberFormatOptions)=>string):string{
 const magnitude=Math.abs(seconds)
 const [unit,size]=magnitude>=86400?['day',86400] as const:magnitude>=3600?['hour',3600] as const:magnitude>=60?['minute',60] as const:['second',1] as const
 return number(seconds/size,{style:'unit',unit,unitDisplay:'long',maximumFractionDigits:1})
}
