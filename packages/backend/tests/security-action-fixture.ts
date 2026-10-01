import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type SecurityAction,type SecurityActionDefinitionCatalog} from '@teloa/contract'
import {initializeRoles} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {BusinessDataService,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {createSecurityEndpointIsolateDefinition} from '../src/security/action-authorization.ts'
import {initializeSecurityRequests,SecurityRequestJournal} from '../src/security/request-journal.ts'
import {initializeSecurityActions,SecurityActionService} from '../src/security/actions.ts'
import {initializeSecurityApprovals,SecurityApprovalService} from '../src/security/approvals.ts'

export const identity={id:randomUUID,now:()=> '2026-09-13T01:00:00.000Z'}
export const definition=createSecurityEndpointIsolateDefinition()
export const catalog:SecurityActionDefinitionCatalog={require(tool){if(tool!==definition.tool)throw new WorkError('teloa/forbidden','未授权的工具。');return definition}}
export async function database(name='test'){
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase(name).start(),pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeBusinessData(pool);await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool)
 return {pool,close:async()=>{await pool.end();await container.stop()}}
}
export async function fixture(pool:Pool,sourceId='security-alert-http',scope='SOC'){
 const principal={ownerId:randomUUID(),approverId:'local-self',scopeIds:[scope]},tasks=new TaskService(pool,identity)
 const alert={scope,type:'alert',id:'evt-1842',version:1,title:'prod-03 异常脚本',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'调查外联。',fields:[{label:'资产',value:'prod-03'}]}
 const data=new BusinessDataService(pool,{id:sourceId,scopes:[scope],query:async()=>({schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:'2026-09-12T01:00:02.000Z',items:[alert]})})
 const snapshot=(await data.query(principal,{scope,limit:10})).items[0]!
 const {task,source}=await new BusinessTaskService(pool,identity,tasks).create(principal,{requestId:randomUUID(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对资产风险'})
 const journal=new SecurityRequestJournal(pool),execution={exists:false,existsForAction:async()=>execution.exists}
 const actions=new SecurityActionService(pool,identity,catalog,journal,execution),approvals=new SecurityApprovalService(pool,identity,catalog,journal)
 const proposal={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,title:'隔离 prod-03',goal:'阻断异常外联',tool:definition.tool,targetSet:['prod-03'],params:{reason:'已核对异常进程'}}
 return {principal,tasks,task,source,snapshot,journal,actions,approvals,proposal,execution}
}
export const command=(action:SecurityAction)=>({requestId:randomUUID(),actionId:action.id,expectedActionVersion:action.version})
export const decision=(action:SecurityAction)=>({...command(action),decision:'approved' as const,reason:'已核对生产影响',impactConfirmed:true})
