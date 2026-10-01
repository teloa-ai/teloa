import {Pool} from 'pg'
import {SecurityActionExecutionService} from '../src/security/action-executions.ts'
import {SecurityApprovalService} from '../src/security/approvals.ts'
import {SecurityRequestJournal} from '../src/security/request-journal.ts'
import {catalog} from './security-action-fixture.ts'
import type {SecurityPrincipal} from '@teloa/contract'

// 与 security-action-claim-process.ts 同形，但用于本包 E2E 用例：任务与安全动作都由真实
// 宿主（apply()）以真实 now() 建出，claim 若沿用 security-action-fixture.ts 的固定
// identity.now()（早于 created_at 的旧时间戳），会被 teloa_security_actions 的
// updated_at>=created_at 检查约束拒绝。这里的 identity 必须用真实时间。
process.once('message',(input:{connectionString:string;principal:SecurityPrincipal;request:unknown})=>{
 void (async()=>{
  const pool=new Pool({connectionString:input.connectionString}),journal=new SecurityRequestJournal(pool)
  const identity={id:()=>crypto.randomUUID(),now:()=>new Date().toISOString()}
  const service=new SecurityActionExecutionService(pool,identity,new SecurityApprovalService(pool,identity,catalog,journal),journal)
  const result=await service.claim(input.principal,input.request)
  process.send?.({pid:process.pid,result})
 })().catch(()=>process.send?.({error:true}))
})
