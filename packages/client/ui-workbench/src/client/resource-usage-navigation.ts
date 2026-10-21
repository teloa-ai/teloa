import type {ResourceUsageTarget} from '@teloa/contract'
import type {ResourceMessageTarget} from './native-resource-message.js'

export type ResourceUsageNavigation={
 previewMessage:(target:ResourceMessageTarget,current:()=>boolean)=>void
 openConversation:(id:string,current:()=>boolean)=>Promise<'opened'|'cancelled'>
 showConversation:()=>void
 openGroup:(id:string,rootId:string,messageId?:string)=>void
 openTask:(id:string)=>void
 openEmployee:(id:string)=>void
 openProject:(id:string,scope:string)=>void
}
/** 原消息与原会话分别打开；所有异步结果继续服从资料页的原对象/连接守卫。 */
export async function openResourceUsage(target:ResourceUsageTarget,current:()=>boolean,navigation:ResourceUsageNavigation):Promise<void>{
 if(!current())return
 if(target.kind==='conversation'){
  if(target.messageId){navigation.previewMessage({id:target.id,messageId:target.messageId},current);return}
  if(await navigation.openConversation(target.id,current)==='opened'&&current())navigation.showConversation()
 }else if(target.kind==='group')navigation.openGroup(target.id,target.rootId??'',target.messageId)
 else if(target.kind==='task')navigation.openTask(target.id)
 else if(target.kind==='employee')navigation.openEmployee(target.id)
 else if(target.scope)navigation.openProject(target.id,target.scope)
}
