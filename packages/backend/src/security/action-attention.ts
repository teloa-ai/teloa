import type {Pool} from 'pg'
import {taskInput,type SecurityPrincipal,type SecurityActionDefinitionCatalog} from '@teloa/contract'
import {securityPrincipal,securityStorageError} from './actions.ts'
import {readSecurityActionGraph,securityReadSnapshot,type SecurityActionReadinessPort} from './action-panel.ts'

export const securityActionAttentionReasons=['approval-required','execution-required','adapter-unavailable','execution-dispatching','external-accepted','effect-unknown','execution-failed','approval-expired'] as const
export type SecurityActionAttentionItem={taskId:string;actionId:string;kind:'security-action';reason:typeof securityActionAttentionReasons[number]}

/** 只投影持久事实；确认失败仍复用 ActionService 的同一请求账本。 */
export class SecurityActionAttentionService{
 private readonly pool:Pool
 private readonly catalog:SecurityActionDefinitionCatalog
 private readonly readiness:SecurityActionReadinessPort
 private readonly now:()=>string
 constructor(pool:Pool,catalog:SecurityActionDefinitionCatalog,readiness:SecurityActionReadinessPort,now:()=>string){this.pool=pool;this.catalog=catalog;this.readiness=readiness;this.now=now}
 async list(principal:SecurityPrincipal,input:unknown,signal:AbortSignal):Promise<SecurityActionAttentionItem[]>{
  securityPrincipal(principal);taskInput(input,[])
  const graph=await securityReadSnapshot(this.pool,signal,db=>readSecurityActionGraph(db,principal,this.catalog)),items:SecurityActionAttentionItem[]=[],ids=new Set<string>(),readyByTool=new Map<string,boolean>(),now=this.now()
  for(const action of graph.actions){
   signal.throwIfAborted();this.catalog.require(action.tool)
   const execution=graph.executions.find(e=>e.actionId===action.id)
   let reason:SecurityActionAttentionItem['reason']|undefined
   if(action.state==='pending_approval')reason='approval-required'
   else if(action.state==='approved'){
    const expiresAt=graph.approvalExpiry.get(action.id)
    // 过期优先于适配器就绪：执行器在不在线已经不影响结论，这条批准无论如何派发不出去。
    if(expiresAt!==undefined&&expiresAt<=now)reason='approval-expired'
    else{
     if(!readyByTool.has(action.tool)){const status=await this.readiness.ready(action.tool,signal);signal.throwIfAborted();readyByTool.set(action.tool,status.ready)}
     reason=readyByTool.get(action.tool)?'execution-required':'adapter-unavailable'
    }
   }else if(execution?.state==='dispatching')reason='execution-dispatching'
   else if(execution?.state==='accepted')reason='external-accepted'
   else if(action.state==='effect_unknown')reason='effect-unknown'
   else if(action.state==='failed'&&!graph.acknowledged.has(action.id)&&!graph.actions.some(next=>next.supersedesActionId===action.id))reason='execution-failed'
   if(reason){if(ids.has(action.id))throw securityStorageError();ids.add(action.id);items.push({taskId:action.taskId,actionId:action.id,kind:'security-action',reason})}
  }
  signal.throwIfAborted();return items
 }
}
