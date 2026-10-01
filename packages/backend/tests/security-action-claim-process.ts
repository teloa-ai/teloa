import {Pool} from 'pg'
import {SecurityActionExecutionService} from '../src/security/action-executions.ts'
import {SecurityApprovalService} from '../src/security/approvals.ts'
import {SecurityRequestJournal} from '../src/security/request-journal.ts'
import {catalog,identity} from './security-action-fixture.ts'
import type {SecurityPrincipal} from '@teloa/contract'

// 提交 claim 后停在 IPC 上，由父测试 SIGKILL；这里没有 HTTP adapter，第一次 POST 尚未发生。
process.once('message',(input:{connectionString:string;principal:SecurityPrincipal;request:unknown})=>{
 void (async()=>{
  const pool=new Pool({connectionString:input.connectionString}),journal=new SecurityRequestJournal(pool)
  const service=new SecurityActionExecutionService(pool,identity,new SecurityApprovalService(pool,identity,catalog,journal),journal)
  const result=await service.claim(input.principal,input.request)
  process.send?.({pid:process.pid,result})
 })().catch(()=>process.send?.({error:true}))
})
