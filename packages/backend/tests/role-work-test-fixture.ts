import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

export const identity={id:randomUUID,now:()=>new Date().toISOString()}
export const ownerAuthority={authorize:async()=>({assertCurrent(){}})}
export async function setupRoleWork(){
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeTasks(pool);await pool.query('alter table teloa_tasks add column if not exists content_version integer not null default 1 check(content_version>0)')
 await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeResources(pool)
 return {pool,close:async()=>{await pool.end();await container.stop()}}
}
/** 新模块缺失时由用例的服务契约断言报失败，不用导入错误冒充行为失败。 */
export async function loadRoleWorkModule(name:string):Promise<Record<string,any>>{
 try{return await import('../src/work/'+name+'.ts')}
 catch(error){if((error as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND'&&String(error).includes('/work/'+name+'.ts'))return {};throw error}
}
export async function roleFixture(pool:Pool,kind:'employee'|'twin'='twin'){
 const owner=randomUUID(),roles=new RoleService(pool,identity)
 const role=kind==='twin'?await roles.ensurePersonalTwin(owner):await roles.create(owner,{requestId:randomUUID(),fields:{name:'研究同事',kind,scopes:['general','research'],duty:'查证',dataScope:'授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const taskId=randomUUID()
 await pool.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,content_version,state,assignee_role_id,assignee_role_version,created_at,updated_at)
 values($1,$2,$3,'{}',$4,1,1,'ready',$5,$6,now(),now())`,[taskId,owner,randomUUID(),JSON.stringify({title:'版本小结',goal:'核对材料',scope:'general',groupId:null,skills:[]}),role.id,role.version])
 return {owner,role,taskId,authorization:{kind:'task' as const,taskId,taskContentVersion:1}}
}
export async function insertRoleRun(pool:Pool,owner:string,roleId:string,taskId:string,state='accepted'){
 const id=randomUUID(),request=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,evidence)
 values($1,$2,$3,'{}',$4,$5,1,1,1,$6,$7,$8,'{}',now(),$9)`,[id,owner,request,taskId,roleId,randomUUID(),randomUUID(),state,state==='ended'?JSON.stringify({state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}):state==='accepted'?JSON.stringify({state:'accepted',turn:0,messageSeq:1}):null])
 return id
}
export const delegationFields={scope:'general',allowedTools:[],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false}
