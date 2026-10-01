import type {BindingClient} from './binding-client.ts'
import type {TaskArtifactPort} from './TaskArtifactPicker.tsx'

export function taskArtifactPort(work:BindingClient,listSessions:(taskId:string)=>Promise<string[]>):TaskArtifactPort{
 return {
  async list(taskId){
   const ids=await listSessions(taskId)
   await work.refreshDirectory()
   const rows=work.getDirectorySnapshot().rows
   return ids.map(id=>({id,title:rows.find(row=>row.sessionId===id)?.title??id}))
  },
  async open(sessionId){
   // 执行会话不在普通会话目录中；由可信读口解析，沿用受管会话只读边界。
   await work.openSession(sessionId)
   if(work.getSnapshot().sessionId!==sessionId||work.getSnapshot().status!=='ready')throw Error('来源会话不可用。')
  },
 }
}
