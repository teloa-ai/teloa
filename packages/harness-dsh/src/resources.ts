import { createHash,randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BusinessScopeService,openResourceDatabase,type ConversationService,type ResourceActor } from '@teloa/backend'
import { isRecord,promptFullTextMaxBytes,WorkError } from '@teloa/contract'
import { sessionInput } from '@teloa/backend'
import type {} from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendResourceContext } from './resource-context.ts'
import { recoveryPage } from './resource-recovery.ts'
import { resourceHistoryPage } from './resource-history.ts'
import {createHostShutdown} from './host-shutdown.ts'
import {resolveTeloaRuntime} from './runtime-paths.ts'
import {securityEnv} from './launch-env.ts'
import {readSessionEvents} from './session-events.ts'

export const resourceEndpoints=['resources/sources','resources/list','resources/candidates','resources/create','resources/update','resources/apply','resources/withdraw','resources/recovery','resources/history','knowledge/tree','knowledge/create-folder','knowledge/rename-node','knowledge/move-node','knowledge/list-versions','knowledge/read-version','knowledge/revise-resource','knowledge/restore-resource']
const empty=(value:unknown)=>{if(!isRecord(value)||Object.keys(value).length)throw new WorkError('teloa/invalid-input','此查询不接受其他参数。')}
function requestIdentity(sessionId:string,callId:string):string {
  const hash=createHash('sha256').update(sessionId+'\0'+callId).digest('hex')
  return hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32)
}
export function registerResources(ctx:Context,projectRoot:string,owner:string,conversations:ConversationService,readHistory:(sessionId:string)=>Promise<Session>){
  // 运行目录与部署形态只认启动时继承的进程环境（launch-env.ts）：决定数据库口令文件位置与数据库主机白名单。
  const trusted=securityEnv(ctx),runtimeRoot=resolveTeloaRuntime(projectRoot,trusted)
  let loading:ReturnType<typeof openResourceDatabase>|undefined,disposed=false
  const get=()=>{
    if(disposed)throw new WorkError('teloa/host-unavailable','资料服务正在关闭。')
    if(!loading){loading=openResourceDatabase(resolve(runtimeRoot,'database.json'),{id:randomUUID,now:()=>new Date().toISOString()},{deployment:trusted.TELOA_DEPLOYMENT});void loading.catch(()=>{loading=undefined})}
    return loading
  }
  const shutdown=createHostShutdown(async()=>{disposed=true;const connection=await loading?.catch(()=>undefined);await connection?.close()})
  ctx.effect(()=>shutdown.stop,'teloa: 后台循环与资料数据库连接')
  // 本人管理目录覆盖其全部已登记业务范围；Agent 仍按会话绑定范围逐次授权，不能继承本人的全量视野。
  const human=async():Promise<ResourceActor>=>{
    const {pool}=await get(),hasScopes=(await pool.query("select to_regclass('public.teloa_business_scopes') name")).rows[0]?.name
    const registered=hasScopes?(await new BusinessScopeService(pool).list(owner)).map(item=>item.scope):[]
    return {ownerId:owner,kind:'human',scopeIds:[...new Set(['general',...registered])]}
  }
  const candidates=async(sessionId:string)=>{
    const binding=await conversations.bySession(owner,sessionId)
    const {service}=await get(),actor=await human(),directory=await service.list(actor)
    const rows=directory.resources.filter(resource=>resource.status==='active'&&resource.scopeIds.every(scope=>binding.scopeIds.includes(scope as 'general')))
    // 超过整段进提示词上限的资料只能加入本地检索；发出去也会被拒，所以不列为消息引用候选。
    const sizes=await service.fullTextBytes(actor,rows)
    return rows.filter(resource=>(sizes.get(resource.id)??0)<=promptFullTextMaxBytes)
  }
  const handle=async(endpoint:string,payload:unknown)=>{
    if(endpoint==='resources/recovery'||endpoint==='resources/history'){
      if(!isRecord(payload)||Object.keys(payload).some(key=>!['sessionId','beforeSeq'].includes(key))||(payload.beforeSeq!==undefined&&(!Number.isSafeInteger(payload.beforeSeq)||Number(payload.beforeSeq)<0)))throw new WorkError('teloa/invalid-input','恢复记录的会话或分页参数不正确。')
      const sessionId=sessionInput({sessionId:payload.sessionId})
      await conversations.bySession(owner,sessionId)
      const session=await readHistory(sessionId)
      if(session.id!==sessionId)throw new WorkError('teloa/invalid-host-response','原生历史与目标会话不一致。')
      return endpoint==='resources/history'?resourceHistoryPage(owner,sessionId,readSessionEvents(session),payload.beforeSeq as number|undefined,session.inheritedEventCount):recoveryPage(sessionId,readSessionEvents(session),payload.beforeSeq as number|undefined,session.inheritedEventCount)
    }
    const {service,knowledge,knowledgeTree,knowledgeResources}=await get(),humanActor=await human()
    switch(endpoint){
      case 'resources/sources':empty(payload);return service.sourceDirectory(humanActor)
      case 'resources/list':empty(payload);return service.list(humanActor)
      case 'resources/candidates':return candidates(sessionInput(payload))
      case 'resources/create':return service.create(humanActor,payload)
      case 'resources/update':return service.update(humanActor,payload)
      case 'resources/apply':return service.apply(humanActor,payload)
      case 'resources/withdraw':return service.withdraw(humanActor,payload)
      case 'knowledge/tree':return knowledgeTree.list(humanActor,payload)
      case 'knowledge/create-folder':return knowledgeTree.createFolder(humanActor,payload)
      case 'knowledge/rename-node':return knowledgeTree.renameNode(humanActor,payload)
      case 'knowledge/move-node':return knowledgeTree.moveNode(humanActor,payload)
      case 'knowledge/list-versions':return knowledge.listVersions(humanActor,payload)
      case 'knowledge/read-version':return knowledge.readVersion(humanActor,payload)
      case 'knowledge/revise-resource':return knowledgeResources.revise(humanActor,payload)
      case 'knowledge/restore-resource':return knowledgeResources.restore(humanActor,payload)
      default:throw new WorkError('teloa/not-found','未提供此资料接口。')
    }
  }
  const parameters={title:{type:'string',required:true},sourceId:{type:'string',required:true},sourceVersion:{type:'string',required:true},scopeIds:{type:'array',items:{type:'string'},required:true}} as const
  for(const operation of ['sources','list','create','update'] as const){
    ctx.tools.register(defineTool({
      name:'teloa_resources_'+operation,
      description:operation==='sources'?'列出可用于 Teloa 工作资料的受控来源及 SHA-256 版本。':operation==='list'?'列出本人工作资料与配置草案。草案尚不可引用，提交需要本人在工作资料界面完成。':operation==='create'?'创建工作资料草案。使用来源目录的 sourceId、sourceVersion；当前范围为 general。只保存草案，不授予读取权限；请本人打开工作资料核对后提交。':'编辑未提交的工作资料草案，必须带上当前 expectedVersion。不能修改已提交资料或跳过本人提交。',
      parameters:operation==='create'?parameters:operation==='update'?{draftId:{type:'string',required:true},expectedVersion:{type:'integer',required:true},...parameters}:{},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
      execute:async(args,exec)=>{
        if(!exec.agent)throw new WorkError('teloa/not-bound','资料操作需要已绑定的工作会话。')
        const binding=await conversations.bySession(owner,exec.agent.session.id)
        const principal:ResourceActor={ownerId:owner,kind:'agent',scopeIds:binding.scopeIds},{service}=await get()
        const value=operation==='sources'?await service.sourceDirectory(principal):operation==='list'?await service.list(principal):operation==='create'?await service.create(principal,{...args,requestId:requestIdentity(exec.agent.session.id,exec.callId)}):await service.update(principal,args)
        return JSON.stringify(value)
      },
    }))
  }
  ctx.on('agent/pre-step',async({agent,signal},next)=>{
    const decision=await next()
    if(decision.kind==='reject')return decision
    try{
      const messages=await appendResourceContext(decision.messages,async input=>{
        const binding=await conversations.bySession(owner,agent.session.id)
        const {service}=await get()
        return service.resolve({ownerId:owner,kind:'agent',scopeIds:binding.scopeIds},{sessionId:agent.session.id,scopeIds:binding.scopeIds},input,signal)
      },signal)
      return {...decision,messages}
    }catch(error){
      if(signal.aborted)throw error
      const code=error instanceof WorkError?error.code.replace(/^teloa\//,''):'unavailable'
      throw new LlmError(error instanceof WorkError?error.message:'工作资料读取失败，请检查来源后重试。','teloa/resources/'+code,{cause:error})
    }
  })
  return {handle,candidates,database:get,human,beforeDatabaseClose:shutdown.beforeClose}
}
