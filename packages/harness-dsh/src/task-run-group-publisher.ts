import type {TaskRun} from '@teloa/backend'
import {groupModelNoVisionNotice} from '@teloa/backend'
import {WorkError,type GroupRunFileClaim} from '@teloa/contract'

type GroupRunPublisherPorts={
 post:(input:{requestId:string;runId:string;text:string;files?:GroupRunFileClaim[]})=>Promise<unknown>
 /** 本次运行登记的声明文件与无视觉判定；登记表按 (sessionId, nativeRequestId) 归集。 */
 run?:(sessionId:string,nativeRequestId:string)=>{files:readonly GroupRunFileClaim[];noVision:boolean}
 /** 回帖已有定论（写入成功或被授权判据挡住）后清空登记表，不跨轮次残留。 */
 clear?:(sessionId:string,nativeRequestId:string)=>void
 /**
  * 回帖**落库成功之后**的后置编排：这条新消息同样要过一次「谁该回」路由（接力就是这么来的）。
  * 服务端 post 已把路由 wake 与消息同事务保存；这里仅作即时唤醒提示。
  * 路由失败由持久 wake 恢复，不能让运行观察循环把已确认的回帖重试一遍。
  */
 route?:(messageId:string)=>void
 report:(code:string)=>void
}

/**
 * 群授权的拒绝只阻止回传，不改写已确认的运行结果。
 * 其它故障仍交给运行观察循环重试，不能伪装成授权变化。
 */
export function createTaskRunGroupPublisher(ports:GroupRunPublisherPorts){
 return async(run:TaskRun,text:string):Promise<void>=>{
  const registered=ports.run?.(run.sessionId,run.nativeRequestId)
  const files=registered?.files??[]
  // 无视觉这句由宿主拼：模型自陈「我没看到图片」不可信，且它未必知道自己没收到图。
  // 「有 N 件文件未能贴出」那句在服务端拼（它才知道哪几条现读失败），两句不在同一处。
  const body=registered?.noVision?`${groupModelNoVisionNotice}\n\n${text}`:text
  // 空数组不进入参：服务端的幂等指纹按「有没有 files 键」分路，多给一个空键会把旧回执判成换内容。
  const input={requestId:run.nativeRequestId,runId:run.id,text:body,...(files.length?{files:files.map(claim=>({...claim}))}:{})}
  let posted:unknown
  try{posted=await ports.post(input)}
  catch(error){
   if(error instanceof WorkError&&['teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(error.code)){
    ports.report(error.code)
    ports.clear?.(run.sessionId,run.nativeRequestId)
    return
   }
   // 故障上抛时不清登记表：观察循环还会再来一次，这一轮的声明必须留到写成功或被判据挡住为止。
   throw error
  }
  ports.clear?.(run.sessionId,run.nativeRequestId)
  // 新消息的 id 只从回包里取：重放命中回执分支时拿到的也是同一条消息，路由那边按 messageId 幂等。
  const messageId=(posted as {id?:unknown}|null|undefined)?.id
  // 后置编排的任何失败都不能回到这里：回帖已经确认写入，观察循环绝不该为路由再重试一次。
  if(typeof messageId==='string')try{ports.route?.(messageId)}catch{}
 }
}
