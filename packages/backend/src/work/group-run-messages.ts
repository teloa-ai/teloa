import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,artifactContent,artifactFileTotalBytes,groupRunMessageInput,isGroupMessage,normalizeReferences,type ArtifactFile,type GroupMessage,type GroupRunFileClaim,type MessageReference} from '@teloa/contract'
import {ArtifactSnapshotStore} from './artifact-snapshots.ts'
import {taskArtifactSessions,taskArtifactSource} from './artifact-task-source.ts'
import {ArtifactService} from './artifacts.ts'
import {readGroupAgentGrant} from './group-agent-grants.ts'
import {readStoredRole} from './roles.ts'
import {readStoredTask} from './tasks.ts'
import {runEvidence} from './task-run-evidence.ts'
import {groupContextNotice,groupPartialAttachFailedNotice,readRunGroupContext,readStoredRunGroupContext,runGroupContextHash,type RunGroupFilePorts} from './task-run-group-context.ts'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw Error();return value.toISOString()}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

function readMessage(row:Record<string,unknown>):GroupMessage{
 try{
  const base={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,text:row.text,references:normalizeReferences(row.reference_snapshot),createdAt:stamp(row.created_at)}
  const value=base.authorId==='self'?base:{...base,taskId:row.task_id,runId:row.run_id}
  if(!isGroupMessage(value))throw Error()
  return value
 }catch{throw new WorkError('teloa/storage-corrupt','员工群内回传记录损坏，已停止读取。')}
}

function storedContext(row:Record<string,unknown>){
 try{
  if(typeof row.input_text!=='string'||typeof row.group_context_hash!=='string'||!uuid(row.task_id)||!uuid(row.role_id)||!uuid(row.id))throw Error()
  const input=JSON.parse(row.input_text) as unknown
  if(!record(input)||!record(input.groupContext))throw Error()
  const {notice,...fields}=input.groupContext
  const context=readStoredRunGroupContext(fields)
  if(notice!==groupContextNotice||!context||context.taskId!==row.task_id||context.roleId!==row.role_id||runGroupContextHash(context)!==row.group_context_hash)throw Error()
  return context
 }catch{throw new WorkError('teloa/storage-corrupt','任务运行缺少正确的群执行上下文，不能回传群消息。')}
}

function isEndedNativeEvidence(value:unknown):boolean{
 try{return runEvidence(value).state==='ended'}
 catch{throw new WorkError('teloa/storage-corrupt','任务运行原生证据损坏，不能回传群消息。')}
}

/** 员工声明的文件只按本次运行的会话现读：读取与核对都在宿主侧，本服务只接受核对过的快照。 */
export type GroupRunArtifactPorts={
 /** 按本次 run 的 sessionId 走既有三道路径闸现读并比对 sha256；失败逐条给既有位置码。 */
 readClaimedFile:(sessionId:string,claim:GroupRunFileClaim)=>Promise<ArtifactFile>
 report:(code:string)=>void
}

const runSessionId=(value:unknown):string=>{
 if(typeof value!=='string'||!/^[\w-]{1,128}$/.test(value))throw new WorkError('teloa/storage-corrupt','任务运行的会话身份损坏，不能回传群消息。')
 return value
}

const runCreatedAt=(value:unknown):string=>{
 try{return stamp(value)}catch{throw new WorkError('teloa/storage-corrupt','任务运行的创建时刻损坏，不能回传群消息。')}
}

/** 按 UTF-16 长度截断（与 `isGroupMessage`、`artifactContent` 同一把尺），但不把代理对切成半个字符。 */
const cut=(value:string,max:number):string=>value.length<=max?value:value.slice(0,/[\uD800-\uDBFF]/.test(value[max-1] as string)?max-1:max)

/**
 * 同一个运行贴同一组文件重放只得到同一版成果：请求身份由 owner、runId 与声明文件的摘要集合派生，不用随机数。
 * 摘要集合进派生源，所以同一个运行换一组文件是另一次定版，不会被判成「同请求换内容」。
 */
function runArtifactRequestId(owner:string,runId:string,claims:readonly GroupRunFileClaim[]):string{
 // 派生源与消息层指纹同尺（路径＋摘要），否则同内容异路径的两帖会互撞成同一个请求身份。
 const keys=claims.map(claim=>`${claim.path}\0${claim.sha256}`).sort()
 const digest=createHash('sha256').update(['teloa/group-run-artifact/v1',owner,runId,...keys].join('\0')).digest('hex')
 const variant=((parseInt(digest.slice(16,17),16)&0x3)|0x8).toString(16)
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-${variant}${digest.slice(17,20)}-${digest.slice(20,32)}`
}

/**
 * 这个服务没有浏览器 RPC。它只供宿主在收到原生运行证据后调用，避免客户端伪造AI 员工发言。
 * 每次写入都重读群、岗位、资料和 canPost 授权；已结束运行也保留这条核验，不让过期授权补发消息。
 */
export class GroupRunMessageService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly artifacts:GroupRunArtifactPorts|undefined
 readonly files:RunGroupFilePorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},artifacts?:GroupRunArtifactPorts,files?:RunGroupFilePorts){this.pool=pool;this.identity=identity;this.artifacts=artifacts;this.files=files}

 /**
  * 声明的文件逐条现读、核对后落快照；核对不过的只剔除该条并记一次宿主日志，绝不因此丢掉已确认的正文。
  * 定版与员工消息写在同一个事务里，且排在任务结项之前——任务一进结项态 `taskArtifactSource` 就拒为 teloa/conflict，
  * 那一支与别的定版失败同等降级：只丢文件、正文照发，绝不因此回滚整条 post。
  */
 private async version(client:PoolClient,owner:string,ports:GroupRunArtifactPorts,taskId:string,sessionId:string,runId:string,title:string,claims:readonly GroupRunFileClaim[]):Promise<{reference?:MessageReference;failed:number}>{
  const requestId=runArtifactRequestId(owner,runId,claims)
  // 同一个运行、同一组声明重放时直接复用已定的那一版：不再现读，两次现读的 capturedAt 不同也不会判冲突。
  const done=(await client.query('select versions.artifact_id,versions.number,versions.content from teloa_artifacts artifacts join teloa_artifact_versions versions on versions.owner_id=artifacts.owner_id and versions.artifact_id=artifacts.id and versions.number=1 where artifacts.owner_id=$1 and artifacts.request_id=$2 for share of artifacts,versions',[owner,requestId])).rows[0]
  if(done){
   if(typeof done.artifact_id!=='string'||done.number!==1)throw new WorkError('teloa/storage-corrupt','群内运行自动定版的记录损坏。')
   let saved:number
   try{saved=artifactContent(done.content).snapshotIds.length}catch{throw new WorkError('teloa/storage-corrupt','群内运行自动定版的记录损坏。')}
   // 复用那一版时失败件数按它实际收了几件反推：第一帖漏掉的文件，第二帖不能谎报成全都贴出了。
   return {reference:{kind:'artifact',id:done.artifact_id,version:1},failed:Math.max(claims.length-saved,0)}
  }
  // 保存点让「定版失败但正文照发」的降级不留下孤儿快照，也不影响同事务里后续的写入。
  await client.query('savepoint teloa_group_run_artifact')
  const snapshotIds:string[]=[];let failed=0,bytes=0
  for(const claim of claims){
   let file:ArtifactFile
   try{
    file=await ports.readClaimedFile(sessionId,claim)
    // 端口已核对过一次；这里再核一次身份与摘要，未核对过的字节绝不进成果版本。
    if(file.sessionId!==sessionId||file.path!==claim.path||file.sha256!==claim.sha256)throw new WorkError('teloa/file-changed','声明的文件在本次运行结束后已变化，未贴出。')
    if(bytes+file.bytes>artifactFileTotalBytes)throw new WorkError('teloa/file-too-large','声明的文件合计超过成果文件总量上限，未贴出。')
   }catch(error){failed++;ports.report(error instanceof WorkError?error.code:'teloa/file-unavailable');continue}
   bytes+=file.bytes
   snapshotIds.push(await new ArtifactSnapshotStore(client).save(owner,file))
  }
  if(!snapshotIds.length){await client.query('release savepoint teloa_group_run_artifact');return {failed}}
  try{
  const source=await taskArtifactSource(client,owner,taskId,true)
  const artifacts=new ArtifactService(this.pool,this.identity,async(actor,expected,db)=>{
   if(actor!==owner||expected.kind!=='task'||expected.id!==taskId)throw new WorkError('teloa/forbidden','群内运行只能为本次任务定版。')
   // 来源已在本事务里读过一次并持有共享锁，这里复用同一份，不再读第二次。
   return {source,sessionIds:await taskArtifactSessions(db,actor,expected.id,true)}
  })
  // 标题、段落与说明全部由固定模板生成，没有一个字段来自模型自由文本；时间位取运行自身的时刻，不取当前时钟。
  const content={title:cut(title,200),sections:[],snapshotIds,note:'由群内运行自动定版。'}
  const saved=await artifacts.createInTransaction(client,owner,{requestId,source,content})
  await client.query('release savepoint teloa_group_run_artifact')
  return {reference:{kind:'artifact',id:saved.artifactId,version:saved.number},failed}
  }catch(error){
   // 定版失败只丢文件、不丢已确认的正文（规格 §4.4）：任务已结项（`taskArtifactSource(…,true)` 抛
   // `teloa/conflict`）也走这一支——它是最常见的一种定版失败，若上抛就会回滚整条 post、被发布器吞掉，
   // 连员工的正文一起丢。降级后正文照发，前置「有 N 件文件未能贴出。」。名单外的码仍原样上抛。
   if(!(error instanceof WorkError)||!['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict'].includes(error.code))throw error
   await client.query('rollback to savepoint teloa_group_run_artifact')
   ports.report(error.code)
   return {failed:failed+snapshotIds.length}
  }
 }

 async post(owner:string,input:unknown):Promise<GroupMessage>{
  ownerId(owner)
  const request=groupRunMessageInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-run-message',owner,request.requestId])])
   const runRow=(await client.query('select * from teloa_task_runs where id=$1 and owner_id=$2 for share',[request.runId,owner])).rows[0]
   if(!runRow)throw new WorkError('teloa/forbidden','运行不存在或不属于当前本人。')
   if(runRow.state!=='ended'||!isEndedNativeEvidence(runRow.evidence))throw new WorkError('teloa/conflict','员工只能在原生运行已结束后回传群消息。')
   const context=storedContext(runRow)
   // 声明的文件进幂等指纹：同一个 requestId 换一组文件必须判冲突，不能命中旧回执后静默丢文件。
   const claims=[...(request.files??[])].sort((a,b)=>{const left=`${a.path}\0${a.sha256}`,right=`${b.path}\0${b.sha256}`;return left<right?-1:left>right?1:0})
   // 空数组不进 JSON（先例 runGroupContextHash）：本次变更之前落库的回执重放仍判同一请求，不因多一个键变成冲突。
   const spec=JSON.stringify(claims.length?{kind:'teloa.group-run-message/v1',runId:request.runId,text:request.text,files:claims}:{kind:'teloa.group-run-message/v1',runId:request.runId,text:request.text})
   const prior=(await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_messages where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])).rows[0]
   if(prior){
    if(!prior.same_request)throw new WorkError('teloa/conflict','同一员工回传请求不能更换内容。')
    const message=readMessage(prior)
    if(!('runId' in message)||message.runId!==request.runId)throw new WorkError('teloa/storage-corrupt','员工回传幂等记录与运行不一致。')
    await client.query('commit');return message
   }
   const taskRow=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2 for share',[context.taskId,owner])).rows[0]
   const roleRow=(await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[context.roleId,owner])).rows[0]
   if(!taskRow||!roleRow)throw new WorkError('teloa/forbidden','任务或员工已不存在，不能回传群消息。')
   const task=readStoredTask(taskRow),role=readStoredRole(roleRow)
   const current=await readRunGroupContext(client,owner,task,role,this.files)
   if(!current||JSON.stringify(current)!==JSON.stringify(context))throw new WorkError('teloa/version-conflict','群任务授权或资料已变化，不能回传群消息。')
   const grantRow=(await client.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for share',[context.groupId,context.roleId])).rows[0]
   if(!grantRow)throw new WorkError('teloa/forbidden','员工没有当前群内发言授权。')
   const grant=readGroupAgentGrant(grantRow)
   if(grant.state!=='active'||grant.grantVersion!==context.grantVersion||!grant.canPost)throw new WorkError('teloa/forbidden','员工没有当前群内发言授权。')
   const now=this.identity.now(),references:MessageReference[]=context.materials.map(material=>({kind:'group-resource',id:material.resourceId,version:material.resourceVersion}))
   let failed=0
   if(claims.length){
    const ports=this.artifacts
    if(!ports)throw new WorkError('teloa/dependency-unavailable','员工声明文件的读取端口未接入，不能回传群消息。')
    // 引用已满 8 条时整段跳过定版：宁可一件都不贴，也不挤掉已授权的资料引用，更不留没人引用的成果。
    if(references.length>=8){failed=claims.length;ports.report('teloa/conflict')}
    else{
     const versioned=await this.version(client,owner,ports,context.taskId,runSessionId(runRow.session_id),request.runId,`${task.title} · ${role.name} · ${runCreatedAt(runRow.created_at)}`,claims)
     failed=versioned.failed
     if(versioned.reference)references.push(versioned.reference)
    }
   }
   // 前置区与正文合起来仍受 8000 字上限约束；宁可截去正文末尾，也不让整条回帖因超长写不进去，且不切断代理对。
   const text=cut(failed?`${groupPartialAttachFailedNotice(failed)}\n\n${request.text}`:request.text,8000)
   const saved=await client.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,task_id,run_id,text,reference_snapshot,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[this.identity.id(),owner,context.groupId,request.requestId,spec,context.source.rootId,context.roleId,context.taskId,request.runId,text,JSON.stringify(references),now])
   const message=readMessage(saved.rows[0])
   await client.query('commit');return message
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}
