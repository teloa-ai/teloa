import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkError, type Conversation, type DigitalRole } from '@teloa/contract'
/** 存储层内部字段，与 `requestedWorkspaceId`/`requestedSessionId` 同族：只用于同请求 ID 是否换了岗位的判据，不属对外契约，读回给调用方前一律经 `toPublic` 剥掉。 */
export type StoredConversation = Conversation & {requestedRoleId?:string}
export interface ConversationRepository { read():Promise<StoredConversation[]>; write(rows:StoredConversation[]):Promise<void> }
export interface SessionHost { create(sessionId:string,workspaceId?:string,agentPresetId?:string,signal?:AbortSignal):Promise<string>; inspect(sessionId:string):Promise<void> }

const fields=['id','ownerId','title','scopeIds','version','status','requestedSessionId','sessionId','createdAt','requestId','requestedWorkspaceId','purpose','run','requestedRoleId']
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const validRequestId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const validTitle=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=200
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const validPreset=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][-a-z0-9]{0,119}$/.test(v)
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
function validateRows(value:unknown):StoredConversation[] {
  const bad=()=>{throw new WorkError('teloa/storage-corrupt','公共会话存储损坏，已停止读取，请核对原文件。')}
  if(!object(value)||value.schema!=='teloa.conversations/v1'||Object.keys(value).some(k=>!['schema','rows'].includes(k))||!Array.isArray(value.rows))return bad()
  const ids=new Set<string>(), sessions=new Set<string>(), requests=new Set<string>()
  for(const row of value.rows) {
    const run=row.run
    if(!object(row)||Object.keys(row).some(k=>!fields.includes(k))||!validId(row.id)||!validId(row.sessionId)||!validId(row.requestedSessionId)||typeof row.ownerId!=='string'||!row.ownerId||!validTitle(row.title)||row.version!==1||!['pending','ready','failed'].includes(String(row.status))||!Array.isArray(row.scopeIds)||row.scopeIds.length!==1||row.scopeIds[0]!=='general'||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||(row.requestedWorkspaceId!==undefined&&!validId(row.requestedWorkspaceId))||(row.requestId!==undefined&&!validRequestId(row.requestId))||(row.requestedRoleId!==undefined&&!validRequestId(row.requestedRoleId)))return bad()
    if(row.purpose==='task-run'?(!object(run)||Object.keys(run).some(k=>!['taskId','taskVersion','roleId','roleVersion','agentPresetId'].includes(k))||!validRequestId(row.requestId)||!validRequestId(run.taskId)||!positive(run.taskVersion)||!validRequestId(run.roleId)||!positive(run.roleVersion)||!validPreset(run.agentPresetId)||row.requestedSessionId!==row.sessionId):row.purpose!==undefined||row.run!==undefined||row.status==='failed')return bad()
    if(ids.has(row.id)||sessions.has(row.sessionId))return bad()
    ids.add(row.id);sessions.add(row.sessionId)
    if(row.requestId){const key=JSON.stringify([row.ownerId,row.requestId]);if(requests.has(key))return bad();requests.add(key)}
  }
  return value.rows as StoredConversation[]
}
function inputObject(input:unknown,keys:string[]):Record<string,unknown> {
  if(!object(input)||Object.keys(input).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','请求包含未知字段或格式不正确。')
  return input
}
export function sessionInput(input:unknown):string {
  const row=inputObject(input,['sessionId'])
  if(!validId(row.sessionId))throw new WorkError('teloa/invalid-input','会话身份不合法。')
  return row.sessionId
}

export class FileConversationRepository implements ConversationRepository {
  readonly path:string
  constructor(path:string) {this.path=path}
  async read():Promise<StoredConversation[]> {
    let content:string
    try {content=await readFile(this.path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
    let value:unknown
    try {value=JSON.parse(content)}catch{throw new WorkError('teloa/storage-corrupt','公共会话存储损坏，原文件未修改。')}
    return validateRows(value)
  }
  async write(rows:StoredConversation[]):Promise<void> {
    const value={schema:'teloa.conversations/v1',rows};validateRows(value)
    await mkdir(dirname(this.path),{recursive:true})
    const temporary=this.path+'.'+randomUUID()+'.tmp'
    const handle=await open(temporary,'wx',0o600)
    try {
      try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync()}finally{await handle.close()}
      await rename(temporary,this.path)
    }catch(error){await unlink(temporary).catch(()=>{});throw error}
  }
}
export class ConversationService {
  readonly repository:ConversationRepository
  readonly host:SessionHost
  readonly identity:{id:()=>string;now:()=>string}
  /** 新增可选端口，与既有可选端口同级。未接线却传了 roleId ⇒ teloa/dependency-unavailable（判不出来就拒）。 */
  readonly readRole:((owner:string,roleId:string)=>Promise<DigitalRole|undefined>)|undefined
  private pending:Promise<unknown>=Promise.resolve()
  constructor(repository:ConversationRepository,host:SessionHost,identity:{id:()=>string;now:()=>string},readRole?:(owner:string,roleId:string)=>Promise<DigitalRole|undefined>) {this.repository=repository;this.host=host;this.identity=identity;this.readRole=readRole}
  private async resolveRoleAgentPresetId(owner:string,roleId:string):Promise<string|undefined> {
    if(!this.readRole)throw new WorkError('teloa/dependency-unavailable','当前环境未接线员工读取，暂不能按员工创建会话。')
    const role=await this.readRole(owner,roleId)
    if(!role||role.ownerId!==owner||role.state==='retired')throw new WorkError('teloa/forbidden','当前主体不能使用该员工创建会话。')
    return role.runtimeConfig?.agentPresetId
  }
  /** `requestedRoleId` 只是存储层内部指纹；任何要回给调用方的行都必须先经这里剥掉它。 */
  private toPublic(row:StoredConversation):Conversation {
    if(row.requestedRoleId===undefined)return row
    const {requestedRoleId,...rest}=row
    return rest
  }
  private serial<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.pending.then(operation);this.pending=result.catch(()=>{});return result
  }
  private authorize(owner:string,row:StoredConversation):StoredConversation {
    if(!owner||row.ownerId!==owner)throw new WorkError('teloa/forbidden','当前主体不能访问该工作会话。')
    return row
  }
  list(owner:string,input:unknown):Promise<Conversation[]> {
    return this.serial(async()=>{inputObject(input,[]);return (await this.repository.read()).filter(row=>row.ownerId===owner&&row.requestId!==undefined&&row.purpose!=='task-run').map(row=>this.toPublic(row))})
  }
  private createNow(owner:string,input:unknown,run?:{sessionId:string;taskId:string;taskVersion:number;roleId:string;roleVersion:number;agentPresetId:string;signal?:AbortSignal}):Promise<Conversation> {
    return (async()=>{
      const data=inputObject(input,['requestId','title','workspaceId','roleId'])
      if(!owner||!validRequestId(data.requestId)||!validTitle(data.title)||(data.workspaceId!==undefined&&!validId(data.workspaceId))||(data.roleId!==undefined&&!validRequestId(data.roleId))||(run!==undefined&&(!validId(run.sessionId)||!validRequestId(run.taskId)||!positive(run.taskVersion)||!validRequestId(run.roleId)||!positive(run.roleVersion)||!validPreset(run.agentPresetId))))throw new WorkError('teloa/invalid-input','创建需要有效的请求 ID 与工作标题。')
      const requestedRoleId=data.roleId as string|undefined
      const rows=await this.repository.read()
      let row=rows.find(item=>item.ownerId===owner&&item.requestId===data.requestId)
      const runSnapshot=run===undefined?undefined:{taskId:run.taskId,taskVersion:run.taskVersion,roleId:run.roleId,roleVersion:run.roleVersion,agentPresetId:run.agentPresetId}
      if(row&&(row.title!==data.title.trim()||row.requestedWorkspaceId!==data.workspaceId||row.requestedRoleId!==requestedRoleId||(run===undefined?row.purpose==='task-run':row.purpose!=='task-run'||row.requestedSessionId!==run.sessionId||JSON.stringify(row.run)!==JSON.stringify(runSnapshot))))throw new WorkError('teloa/conflict','同一请求 ID 不能改为另一项工作。')
      if(row?.status==='failed')throw new WorkError('teloa/preset-unavailable','运行专用会话预约已按配置失败收口。')
      if(row?.status==='ready'){
        if(run===undefined)await this.host.inspect(row.sessionId)
        else{
          const sessionId=await this.host.create(row.requestedSessionId,row.requestedWorkspaceId,run.agentPresetId,run.signal)
          if(sessionId!==row.sessionId)throw new WorkError('teloa/invalid-host-response','运行会话重放返回了不同身份。')
        }
        return this.toPublic(row)
      }
      if(!row) {
        const sessionId=run?.sessionId??this.identity.id()
        row={id:this.identity.id(),ownerId:owner,title:data.title.trim(),scopeIds:['general'],version:1,status:'pending',requestedSessionId:sessionId,sessionId,createdAt:this.identity.now(),requestId:data.requestId,...(data.workspaceId===undefined?{}:{requestedWorkspaceId:data.workspaceId}),...(requestedRoleId===undefined?{}:{requestedRoleId}),...(runSnapshot===undefined?{}:{purpose:'task-run' as const,run:runSnapshot})}
        rows.push(row);await this.repository.write(rows)
      }
      const roleAgentPresetId=run===undefined&&requestedRoleId!==undefined?await this.resolveRoleAgentPresetId(owner,requestedRoleId):undefined
      const sessionId=await this.host.create(row.requestedSessionId,row.requestedWorkspaceId,run?.agentPresetId??roleAgentPresetId,run?.signal)
      if(!validId(sessionId))throw new WorkError('teloa/invalid-host-response','宿主未返回合法会话身份。')
      if(run!==undefined&&sessionId!==row.requestedSessionId)throw new WorkError('teloa/invalid-host-response','运行专用会话身份与固定预约不一致。')
      if(rows.some(other=>other.id!==row.id&&other.sessionId===sessionId))throw new WorkError('teloa/conflict','宿主返回的会话已经绑定另一项工作。')
      const ready:StoredConversation={...row,sessionId,status:'ready'}
      await this.repository.write(rows.map(item=>item.id===ready.id?ready:item))
      return this.toPublic(ready)
    })()
  }
  create(owner:string,input:unknown):Promise<Conversation> {
    return this.serial(()=>this.createNow(owner,input))
  }
  /** 仅供宿主内的一键执行编排；preset 与预约身份不从客户端读取。 */
  createRun(owner:string,input:unknown,run:{sessionId:string;taskId:string;taskVersion:number;roleId:string;roleVersion:number;agentPresetId:string;signal?:AbortSignal}):Promise<Conversation> {
    return this.serial(()=>this.createNow(owner,input,run))
  }
  /** 精确读取首次派生的运行预约，供回包丢失后的同请求恢复。 */
  runReservation(owner:string,input:unknown):Promise<Conversation|null>{
    return this.serial(async()=>{const data=inputObject(input,['requestId']);if(!owner||!validRequestId(data.requestId))throw new WorkError('teloa/invalid-input','运行预约请求身份不合法。');const row=(await this.repository.read()).find(item=>item.ownerId===owner&&item.requestId===data.requestId);if(!row)return null;if(row.purpose!=='task-run'||!row.run)throw new WorkError('teloa/conflict','同一请求已用于普通工作会话。');return this.toPublic(row)})
  }
  /** 配置失败只收口服务端运行预约；保留身份用于权限守卫与审计。 */
  failRunReservation(owner:string,input:unknown):Promise<boolean>{
    return this.serial(async()=>{const data=inputObject(input,['requestId','sessionId']);if(!owner||!validRequestId(data.requestId)||!validId(data.sessionId))throw new WorkError('teloa/invalid-input','运行预约身份不合法。');const rows=await this.repository.read(),row=rows.find(item=>item.ownerId===owner&&item.requestId===data.requestId);if(!row)return false;this.authorize(owner,row);if(row.purpose!=='task-run'||row.sessionId!==data.sessionId)throw new WorkError('teloa/conflict','运行预约与失败回执不一致。');if(row.status==='failed')return true;const failed:StoredConversation={...row,status:'failed'};await this.repository.write(rows.map(item=>item.id===row.id?failed:item));return true})
  }
  /** 只回答服务端用途，不要求原生会话已经创建完成。 */
  isTaskRunReserved(owner:string,sessionId:string):Promise<boolean>{
    return this.serial(async()=>{if(!owner||!validId(sessionId))throw new WorkError('teloa/invalid-input','运行预约会话身份不合法。');const row=(await this.repository.read()).find(item=>item.sessionId===sessionId);if(!row)return false;this.authorize(owner,row);return row.purpose==='task-run'})
  }
  ensure(owner:string,input:unknown):Promise<Conversation> {
    return this.serial(async()=>{
      const sessionId=sessionInput(input)
      const rows=await this.repository.read(),existing=rows.find(item=>item.sessionId===sessionId)
      if(existing)this.authorize(owner,existing)
      if(existing?.purpose==='task-run'||existing?.status==='pending'||existing?.status==='failed')throw new WorkError('teloa/binding-pending','工作会话正在由任务执行编排，请从原任务恢复。')
      await this.host.inspect(sessionId)
      if(existing)return this.toPublic(existing)
      if(!owner)throw new WorkError('teloa/forbidden','缺少可信主体。')
      const row:StoredConversation={id:this.identity.id(),ownerId:owner,title:'通用工作会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:this.identity.now()}
      await this.repository.write([...rows,row]);return this.toPublic(row)
    })
  }
  /** 本人明确加入工作目录；普通 ensure 仍不将所有原生历史自动收进目录。 */
  adopt(owner:string,input:unknown):Promise<Conversation> {
    return this.serial(async()=>{
      const data=inputObject(input,['sessionId','requestId','title'])
      if(!owner||!validId(data.sessionId)||!validRequestId(data.requestId)||!validTitle(data.title))throw new WorkError('teloa/invalid-input','加入目录需要合法会话、请求 ID 与标题。')
      const rows=await this.repository.read(),existing=rows.find(row=>row.sessionId===data.sessionId)
      if(existing)this.authorize(owner,existing)
      if(existing?.purpose==='task-run'||existing?.status==='pending'||existing?.status==='failed')throw new WorkError('teloa/binding-pending','会话正在由任务执行编排，请从原任务恢复。')
      if(rows.some(row=>row.ownerId===owner&&row.requestId===data.requestId&&row.sessionId!==data.sessionId))throw new WorkError('teloa/conflict','此请求 ID 已关联另一项工作。')
      await this.host.inspect(data.sessionId)
      if(existing?.requestId)return this.toPublic(existing)
      const row:StoredConversation={...(existing??{id:this.identity.id(),ownerId:owner,scopeIds:['general'],version:1,status:'ready',requestedSessionId:data.sessionId,sessionId:data.sessionId,createdAt:this.identity.now()}),title:data.title.trim(),requestId:data.requestId}
      await this.repository.write(existing?rows.map(item=>item.id===existing.id?row:item):[...rows,row])
      return this.toPublic(row)
    })
  }
  /** 只读当前已落盘的完整快照，不等待可能正在借用数据库的创建队列。 */
  async snapshotBySession(owner:string,sessionId:string):Promise<Conversation&{status:'ready'}> {
    const rows=await this.repository.read(),row=rows.find(item=>item.sessionId===sessionId)
    if(!row)throw new WorkError('teloa/not-bound','当前原生会话尚未建立 Teloa 工作绑定。')
    this.authorize(owner,row)
    if(row.status!=='ready')throw new WorkError('teloa/binding-pending','工作会话绑定尚未就绪。')
    return this.toPublic(row) as Conversation&{status:'ready'}
  }
  bySession(owner:string,sessionId:string):Promise<Conversation&{status:'ready'}> {
    return this.serial(()=>this.snapshotBySession(owner,sessionId))
  }
  /** 仅供宿主拼装岗位上下文；公共会话回包继续剥掉这个创建请求指纹。 */
  requestedRoleId(owner:string,sessionId:string):Promise<string|null> {
    return this.serial(async()=>{
      if(!owner||!validId(sessionId))throw new WorkError('teloa/invalid-input','工作会话身份不合法。')
      const row=(await this.repository.read()).find(item=>item.sessionId===sessionId)
      if(!row)throw new WorkError('teloa/not-bound','当前原生会话尚未建立 Teloa 工作绑定。')
      this.authorize(owner,row)
      if(row.status!=='ready')throw new WorkError('teloa/binding-pending','工作会话绑定尚未就绪。')
      return row.requestedRoleId??null
    })
  }
}
