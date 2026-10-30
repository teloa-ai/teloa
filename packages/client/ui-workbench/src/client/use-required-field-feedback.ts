import {useId,useState,type RefObject} from 'react'
import {useI18n} from './i18n/provider.js'

type RequiredField={label:string;value:string;ref:RefObject<HTMLInputElement|HTMLTextAreaElement>}

/** 失焦后提示，提交时定位首个缺项；仅校验输入，不触碰草稿或持久化。 */
export function useRequiredFieldFeedback<Name extends string>(fields:Record<Name,RequiredField>){
 const {t}=useI18n(),prefix=useId()
 const [errors,setErrors]=useState<ReadonlySet<Name>>(new Set())
 const id=(name:Name)=>`${prefix}-${name}-error`
 const clear=(name:Name,value:string)=>{
  if(value.trim())setErrors(current=>{if(!current.has(name))return current;const next=new Set(current);next.delete(name);return next})
 }
 const check=(name:Name)=>setErrors(current=>{
  const next=new Set(current)
  if(fields[name].value.trim())next.delete(name);else next.add(name)
  return next
 })
 const validate=(form:HTMLFormElement)=>{
  const missing=(Object.keys(fields) as Name[]).filter(name=>!fields[name].value.trim())
  setErrors(new Set(missing))
  const node=missing.length?fields[missing[0]!].ref.current:form.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input:invalid,textarea:invalid,select:invalid')
  // 任务名称和项目日期位于可折叠选项里，先展开再聚焦，避免隐藏错误拦住提交。
  if(node){const details=node.closest('details');if(details)details.open=true;node.focus();node.scrollIntoView({block:'nearest'})}
  // 日期等原生输入仍交给浏览器检查，避免产品必填提示绕过原生约束。
  return missing.length===0&&form.reportValidity()
 }
 return {id,clear,validate,
  message:(name:Name)=>errors.has(name)?t('form.required',{field:fields[name].label}):undefined,
  props:(name:Name)=>({'aria-invalid':errors.has(name)||undefined,'aria-describedby':errors.has(name)?id(name):undefined,onBlur:()=>check(name)}),
 }
}
