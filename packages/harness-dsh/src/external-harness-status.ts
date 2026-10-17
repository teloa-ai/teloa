import {createHash} from 'node:crypto'
import {isAbsolute} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import {defineDomain,domainTable} from '@deepseek-ai/dsh-storage-domain'
import {z} from 'zod'
import {WorkError,externalHarnessStatuses,type ExternalHarnessWorkView} from '@teloa/contract'

const text=z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/)
const metadata=z.object({sessionId:text,runId:text.nullable(),provider:z.enum(['codex','claude-code']),runtimeId:text,requestId:text,reservationId:text,workspaceRoot:text.refine(isAbsolute),activationId:text.optional(),status:z.enum(externalHarnessStatuses)}).strict()
const record=metadata.extend({ownerId:text,observedAt:z.number().int().nonnegative()})
const spec=defineDomain({name:'teloa_external_harness',version:1,tables:{work:domainTable(record)}})
export type ExternalHarnessMetadata=z.infer<typeof metadata>
const terminal=(status:ExternalHarnessMetadata['status'])=>['completed','failed','aborted','unknown'].includes(status)

/** 只存业务状态侧车；执行、输出和恢复仍归官方 activation/父会话。 */
export async function openExternalHarnessStatus(ctx:Context,ownerId:string){
 const domain=await ctx.storageDomain.open(spec),table=domain.table('work')
 return Object.freeze({
  async save(input:ExternalHarnessMetadata){
   const value=record.parse({...metadata.parse(input),ownerId,observedAt:Date.now()})
   const key=createHash('sha256').update(JSON.stringify([ownerId,value.sessionId,value.reservationId])).digest('hex')
   const validate=(previous:z.infer<typeof record>)=>{
    for(const field of ['ownerId','sessionId','runId','runtimeId','provider','requestId','reservationId','workspaceRoot'] as const)if(previous[field]!==value[field])throw new WorkError('teloa/conflict','外部工作身份不能改写。')
    if(previous.activationId!==undefined&&previous.activationId!==value.activationId)throw new WorkError('teloa/conflict','外部 activation 身份不能改写。')
    if(previous.status!==value.status&&(terminal(previous.status)||value.status==='reserved'||previous.status==='stopping'&&value.status==='running'))throw new WorkError('teloa/conflict','外部工作终态不能回退。')
    return value
   }
   if(table.get(key))await table.update(key,validate)
   else await table.put(key,value)
  },
  list(sessionId:string,runtimeId:string):ExternalHarnessWorkView[]{
   return [...table.entries()].flatMap(([,value])=>{
    if(value.ownerId!==ownerId||value.sessionId!==sessionId||!value.activationId)return []
    const status=value.runtimeId!==runtimeId&&!terminal(value.status)?'unknown':value.status
    return [{activationId:value.activationId,provider:value.provider,status,canStop:false,observedAt:value.observedAt}]
   })
  },
  close:()=>domain.close(),
 })
}
