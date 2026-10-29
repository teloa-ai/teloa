import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readResourceRelations,BusinessScopeService,openResourceDatabase,AuthorizedLocalMaterialCatalog,initializeAuthorizedLocalMaterials,type AuthorizedLocalMaterialPorts,type ConversationService,type ResourceActor } from '@teloa/backend'
import { isRecord,resourceId,resourceVersion,promptFullTextMaxBytes,WorkError } from '@teloa/contract'
import { sessionInput } from '@teloa/backend'
import type {} from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendResourceContext } from './resource-context.ts'
import { recoveryPage } from './resource-recovery.ts'
import { resourceHistoryPage } from './resource-history.ts'
import {resourceUsagePage} from './resource-usage.ts'
import {createHostShutdown} from './host-shutdown.ts'
import {resolveTeloaRuntime} from './runtime-paths.ts'
import {securityEnv} from './launch-env.ts'
import {readSessionEvents} from './session-events.ts'

export const resourceEndpoints=['resources/register-local-material','resources/read-content','resources/sources','resources/list','resources/candidates','resources/create','resources/update','resources/prepare-adoption','resources/apply','resources/withdraw','resources/recovery','resources/history','resources/usage','knowledge/tree','knowledge/create-folder','knowledge/rename-node','knowledge/move-node','knowledge/list-versions','knowledge/read-version','knowledge/revise-resource','knowledge/restore-resource','knowledge/revise-standalone','knowledge/restore-standalone']
const empty=(value:unknown)=>{if(!isRecord(value)||Object.keys(value).length)throw new WorkError('teloa/invalid-input','此查询不接受其他参数。')}
export function registerResources(ctx:Context,projectRoot:string,owner:string,conversations:ConversationService,readHistory:(sessionId:string)=>Promise<Session>,localMaterialPorts?:AuthorizedLocalMaterialPorts){
  // 运行目录与部署形态只认启动时继承的进程环境（launch-env.ts）：决定数据库口令文件位置与数据库主机白名单。
  const trusted=securityEnv(ctx),runtimeRoot=resolveTeloaRuntime(projectRoot,trusted)
  let loading:ReturnType<typeof openResourceDatabase>|undefined,disposed=false,localMaterials:AuthorizedLocalMaterialCatalog|undefined
  const get=()=>{
    if(disposed)throw new WorkError('teloa/host-unavailable','资料服务正在关闭。')
    if(!loading){const identity={id:randomUUID,now:()=>new Date().toISOString()};loading=openResourceDatabase(resolve(runtimeRoot,'database.json'),identity,{deployment:trusted.TELOA_DEPLOYMENT,...(localMaterialPorts?{localMaterialCatalog:async pool=>{await initializeAuthorizedLocalMaterials(pool);localMaterials=new AuthorizedLocalMaterialCatalog(pool,identity,localMaterialPorts);return localMaterials}}:{})});void loading.catch(()=>{loading=undefined;localMaterials=undefined})}
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
      case 'resources/usage':{
        if(!isRecord(payload)||Object.keys(payload).some(key=>!['resourceId','version','cursor'].includes(key))||!resourceId(payload.resourceId)||!resourceVersion(payload.version))throw new WorkError('teloa/invalid-input','资料引用查询参数不正确。')
        const cursor=payload.cursor===undefined?undefined:sessionInput({sessionId:payload.cursor})
        const resource=(await service.list(humanActor)).resources.find(row=>row.id===payload.resourceId&&row.version===payload.version)
        if(!resource)throw new WorkError('teloa/not-found','资料版本不存在或不可访问。')
        const [usage,related]=await Promise.all([resourceUsagePage(owner,resource,await conversations.resourceHistoryCandidates(owner),async id=>{await conversations.bySession(owner,id);return readHistory(id)},cursor),readResourceRelations((await get()).pool,owner,resource.id,humanActor.scopeIds)])
        return {...usage,related:related.items,relatedMore:related.more}
      }
      case 'resources/register-local-material':if(!localMaterials)throw new WorkError('teloa/unavailable','当前宿主尚不支持跟踪本机原件。');return localMaterials.register(humanActor,payload)
      case 'resources/read-content':return service.readContent(humanActor,payload)
      case 'resources/sources':empty(payload);return service.sourceDirectory(humanActor)
      case 'resources/list':empty(payload);return service.list(humanActor)
      case 'resources/candidates':return candidates(sessionInput(payload))
      case 'resources/create':return service.create(humanActor,payload)
      case 'resources/update':return service.update(humanActor,payload)
      case 'resources/prepare-adoption':return service.prepareAdoption(humanActor,payload)
      case 'resources/apply':return service.apply(humanActor,payload)
      case 'resources/withdraw':return service.withdraw(humanActor,payload)
      case 'knowledge/tree':return knowledgeTree.list(humanActor,payload)
      case 'knowledge/create-folder':return knowledgeTree.createFolder(humanActor,payload)
      case 'knowledge/rename-node':return knowledgeTree.renameNode(humanActor,payload)
      case 'knowledge/move-node':return knowledgeTree.moveNode(humanActor,payload)
      case 'knowledge/list-versions':return knowledge.listVersions(humanActor,payload)
      case 'knowledge/read-version':return knowledge.readVersion(humanActor,payload)
      case 'knowledge/revise-standalone':return knowledgeResources.reviseStandalone(humanActor,payload)
      case 'knowledge/restore-standalone':return knowledgeResources.restoreStandalone(humanActor,payload)
      case 'knowledge/revise-resource':return knowledgeResources.revise(humanActor,payload)
      case 'knowledge/restore-resource':return knowledgeResources.restore(humanActor,payload)
      default:throw new WorkError('teloa/not-found','未提供此资料接口。')
    }
  }
  // 创建和修改由 library-tools 统一固定本人指令及受管任务边界；这里保留原会话范围的只读查询。
  for(const operation of ['sources','list'] as const){
    ctx.tools.register(defineTool({
      name:'teloa_resources_'+operation,
      description:operation==='sources'?'列出可用于 Teloa 工作资料的受控来源及 SHA-256 版本。':'列出当前会话范围内本人工作资料与配置草案。草案尚不可引用；本人要求提交时可在原会话调用 teloa_library_apply。',
      parameters:{},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
      execute:async(args,exec)=>{
        if(!exec.agent)throw new WorkError('teloa/not-bound','资料操作需要已绑定的工作会话。')
        const binding=await conversations.bySession(owner,exec.agent.session.id)
        const principal:ResourceActor={ownerId:owner,kind:'agent',scopeIds:binding.scopeIds},{service}=await get()
        empty(args)
        const value=operation==='sources'?await service.sourceDirectory(principal):await service.list(principal)
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
