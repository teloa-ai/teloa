import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {TaskRunService} from '../src/work/task-runs.ts'

// 提交 claim 后停在 IPC 上，由父测试 SIGKILL；这里没有原生会话驱动，第一次发送尚未发生。
// inspect 不能跨进程传函数，父测试把 owner/sessionId/conversationId 一并送来，本地重建同形只读闭包。
process.once('message',(input:{connectionString:string;owner:string;sessionId:string;conversationId:string;request:{runId:string}})=>{
 void (async()=>{
  const pool=new Pool({connectionString:input.connectionString})
  const inspect=async()=>({id:input.conversationId,sessionId:input.sessionId,ownerId:input.owner,status:'ready'})
  const service=new TaskRunService(pool,{id:randomUUID,now:()=>new Date().toISOString()},inspect)
  const result=await service.claim(input.owner,input.request)
  process.send?.({pid:process.pid,result})
 })().catch(()=>process.send?.({error:true}))
})
