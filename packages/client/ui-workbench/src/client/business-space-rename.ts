import {createElement} from 'react'
import type {BusinessSpaceChange} from './business-directory.js'

/**
 * 提交工作空间改名：成功返回空串（关闭表单由调用方在 `save` 里做），
 * 失败返回本地化错误文案——本地校验与宿主版本冲突走同一条路径，表单一律留在原地。
 */
export async function submitBusinessSpaceRename(
 save:(change:BusinessSpaceChange)=>Promise<void>|void,
 value:{expectedVersion:number;name:string;description:string},
 localize:(error:unknown)=>string,
):Promise<string>{
 try{
  await save({type:'rename',expectedVersion:value.expectedVersion,name:value.name,description:value.description})
  return ''
 }catch(error){return localize(error)}
}

/** 表单里的错误区域：没有错误就不占位，有错误时用 `role="alert"` 播报。 */
export function BusinessSpaceRenameAlert({message}:{message:string}){
 return message?createElement('p',{role:'alert'},message):null
}
