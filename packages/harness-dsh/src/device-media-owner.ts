import {WorkError} from '@teloa/contract'

/** 本人宿主唯一媒体预约；不提供抢占、挂断或取消工作端口。 */
export function createDeviceMediaOwner(){
 let current:object|undefined
 return Object.freeze({acquire(_source:'web'|'device'){
  if(current)throw new WorkError('teloa/conflict','当前语音正在使用，请结束原通话后再试。')
  const token={};current=token
  return Object.freeze({release(){if(current===token)current=undefined}})
 }})
}
export type DeviceMediaOwner=ReturnType<typeof createDeviceMediaOwner>
