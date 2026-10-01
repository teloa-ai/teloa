import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import {industryOwner,industryPredicates} from './industry-instance-kit.ts'
import type {IndustryDataSourceReadiness} from './industry-data-sources.ts'
import type {IndustryDataSourceSource} from './industry-data-source-source.ts'
import type {IndustryMcpConnectionReadiness} from './industry-mcp-connections.ts'
import type {IndustryMcpConnectionSource} from './industry-mcp-connection-source.ts'
import type {IndustryExecutionToolReadiness} from './industry-execution-tools.ts'
import type {IndustryExecutionToolSource} from './industry-execution-tool-source.ts'

export type ConnectorKind='data-source'|'mcp'|'execution-tool'
export type ConnectorProbeResult={kind:ConnectorKind;instanceId:string;probedAt:string}&({ok:true}|{ok:false;reason:string})

export type ConnectorProbePorts={
 'data-source':{read:IndustryDataSourceSource['read'];ready:IndustryDataSourceReadiness['ready']}
 mcp:{read:IndustryMcpConnectionSource['read'];ready:IndustryMcpConnectionReadiness['ready']}
 'execution-tool':{read:IndustryExecutionToolSource['read'];ready:IndustryExecutionToolReadiness['ready']}
}

const {uuid,exact}=industryPredicates
const invalid=()=>new WorkError('teloa/invalid-input','连接测试连接请求格式不正确。')
const forbidden=()=>new WorkError('teloa/forbidden','连接实例不存在或不属于当前本人。')
const isKind=(value:unknown):value is ConnectorKind=>value==='data-source'||value==='mcp'||value==='execution-tool'
const TABLE:Record<ConnectorKind,string>={'data-source':'teloa_industry_data_source_instances',mcp:'teloa_industry_mcp_instances','execution-tool':'teloa_industry_execution_tool_instances'}

export class ConnectorProbeService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly ports:ConnectorProbePorts
 constructor(pool:Pool,identity:{now:()=>string},ports:ConnectorProbePorts){this.pool=pool;this.identity=identity;this.ports=ports}

 /**
  * 定位映射身份并回读固定来源：与 IndustryInstanceKit.advance 的预检段一致，
  * 只读事务内一次查询、一次来源回读，读不出来的来源直接把 `teloa/source-unavailable` 原样透出，不掩盖。
  */
 private async preview<TSnapshot>(kind:ConnectorKind,ownerId:string,instanceId:string,read:(db:PoolClient,owner:string,input:{loadId:string;itemInstanceId:string})=>Promise<TSnapshot>):Promise<{scope:string;snapshot:TSnapshot}>{
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const found=(await db.query(`select load_id,item_instance_id,scope from ${TABLE[kind]} where id=$1 and owner_id=$2`,[instanceId,ownerId])).rows[0]
   if(!found)throw forbidden()
   const scope=found.scope as string,snapshot=await read(db,ownerId,{loadId:found.load_id as string,itemInstanceId:found.item_instance_id as string})
   await db.query('commit')
   return {scope,snapshot}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 测试连接必须只读：它是用户在“要不要真的授权”之前的一次试探。
  * 复用 authorize / connect 会走 IndustryInstanceKit.advance 写 revision 与绑定，
  * 一次试探就变成一次真授权，这正是本模块存在的唯一理由——全程不发一条 update。
  * 连接器只是用户侧统称：契约与代码内部的落点（数据源、MCP 连接、执行工具）一个字不改名。
  */
 async probe(ownerId:string,input:unknown,signal:AbortSignal):Promise<ConnectorProbeResult>{
  industryOwner(ownerId)
  const value=exact(input,['kind','instanceId'],invalid)
  if(!isKind(value.kind)||!uuid(value.instanceId))throw invalid()
  const kind=value.kind,instanceId=value.instanceId.toLowerCase()
  signal.throwIfAborted()
  if(kind==='data-source'){
   const {scope,snapshot}=await this.preview(kind,ownerId,instanceId,this.ports['data-source'].read)
   signal.throwIfAborted();const probedAt=this.identity.now(),result=await this.ports['data-source'].ready(snapshot.definition,scope,signal)
   return result.ready?{kind,instanceId,probedAt,ok:true}:{kind,instanceId,probedAt,ok:false,reason:result.reason}
  }
  if(kind==='mcp'){
   const {snapshot}=await this.preview(kind,ownerId,instanceId,this.ports.mcp.read)
   signal.throwIfAborted();const probedAt=this.identity.now(),result=await this.ports.mcp.ready(snapshot.definition,signal)
   return result.ready?{kind,instanceId,probedAt,ok:true}:{kind,instanceId,probedAt,ok:false,reason:result.reason}
  }
  const {snapshot}=await this.preview(kind,ownerId,instanceId,this.ports['execution-tool'].read)
  signal.throwIfAborted();const probedAt=this.identity.now()
  for(const tool of snapshot.definition.tools){
   const result=await this.ports['execution-tool'].ready(tool,signal)
   if(!result.ready)return {kind,instanceId,probedAt,ok:false,reason:result.reason}
  }
  return {kind,instanceId,probedAt,ok:true}
 }
}
