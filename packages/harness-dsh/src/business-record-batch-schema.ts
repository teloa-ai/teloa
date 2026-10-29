import type {ParameterPropertySpec} from '@deepseek-ai/dsh-tools'
import {businessRecordValueLimits,businessRecordDatetimeFormat,businessRecordDatetimeExample} from '@teloa/contract'

/**
 * 本地记录批次的模型可见协议（`contract/business-records.ts` 的 readBusinessRecordBatch 是唯一校验契约）。
 * 普通记录写入与业务修改草稿准备共用这一份参数形状与说明：模型在调用前就能看到 operation、顶层 type/title/summary 与
 * fields:[{name,value}]，官方参数校验先拦下形状错误；字段取值、版本与唯一性仍由契约与后端事务最终核验。
 * 不含 requestId/scope：两者由宿主按本人指令与当前业务固定。
 */
export const businessRecordFieldValueProtocol='每个 fields[].value 最多 '+businessRecordValueLimits.field+' 个 UTF-16 代码单元，保留字符串形式且不含首尾空白；这与摘要的 '+businessRecordValueLimits.summary+' 上限不同。datetime 必须是规范 UTC 字符串，含3位毫秒并以 Z 结尾，格式 '+businessRecordDatetimeFormat+'，例如 '+businessRecordDatetimeExample+'；须先按原时区转换为 UTC，不能只改后缀。'
export const businessRecordBatchProtocol='仅operations:[{operation:create|edit|archive,type,...}]，不接受requestId/scope。create需title/summary/fields；edit需id/expectedVersion及包含全部字段的fields，title/summary可选；archive需id/expectedVersion。fields=[{name,value}]为完整替换。'+businessRecordFieldValueProtocol

const text=(description:string)=>({type:'string' as const,description})
export const businessRecordOperationsParameter={
 type:'array',required:true,description:'1–50项本地记录操作；同一记录只能出现一次。',
 items:{type:'object',additionalProperties:false,properties:{
  operation:{type:'string',required:true,enum:['create','edit','archive'],description:'操作：create 新增、edit 修改、archive 归档。'},
  type:{...text('记录类型 id（对象类型定义里的 id，不是显示名称）。'),required:true},
  id:text('edit/archive 必填：要修改或归档的记录原 id。'),
  expectedVersion:{type:'integer',description:'edit/archive 必填：读取到的当前记录版本。'},
  title:text('create 必填；edit 可选：记录标题，最多 '+businessRecordValueLimits.title+' 个 UTF-16 代码单元。'),
  summary:text('create 必填（可为空字符串）；edit 可选：记录摘要，最多 '+businessRecordValueLimits.summary+' 个 UTF-16 代码单元。'),
  fields:{type:'array',description:'create/edit 必填，完整替换：每个字段一项，name 为字段定义里的 name（不是显示标签），value 为字符串，空字符串表示清空。',items:{type:'object',additionalProperties:false,properties:{name:{type:'string',required:true},value:{type:'string',required:true,description:businessRecordFieldValueProtocol}}}},
 }},
} as const satisfies ParameterPropertySpec
