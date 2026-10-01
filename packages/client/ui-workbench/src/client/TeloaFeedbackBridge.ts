import type {StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
export type NativeFeedbackDialog={
  getSnapshot:()=>Readonly<{target:unknown|null}>
  subscribe:(listener:()=>void)=>(()=>void)
}
export type NativeFeedbackBridge={nativeDialog:NativeFeedbackDialog;dismissNative:()=>void}
/** DSH 0.1.7-rc.1 公开注册注入面；只借用状态与关闭能力，不传递 submit。 */
export function nativeFeedbackDialog(entries:readonly StoredEntry[],sessionId:string):NativeFeedbackBridge|null{
  const source=entries.find(entry=>entry.options.id==='feedback-dialog'&&(entry.options.priority??0)===0)
  if(!source?.inject)return null
  const face=source.inject(sessionId as never)
  const hooks=face.hooks as {dialog?:NativeFeedbackDialog}|undefined
  if(typeof hooks?.dialog?.getSnapshot!=='function'||typeof hooks.dialog.subscribe!=='function'||typeof face.dismiss!=='function')return null
  return {nativeDialog:hooks.dialog,dismissNative:face.dismiss as ()=>void}
}
