import {ArtifactService,ArtifactSnapshotStore,ArtifactFeedbackService,ArtifactMessageStore,taskArtifactSource,taskArtifactSessions} from '@teloa/backend'
import {artifactInput,artifactFilePath,savedArtifactMessage,type SavedArtifactMessage,WorkError,type Conversation,type ArtifactFile,type SavedArtifactSource} from '@teloa/contract'
export const artifactEndpoints=['artifacts/task/sessions','artifacts/task/source','artifacts/task/list','artifacts/message/capture','artifacts/message/snapshot','artifacts/source','artifacts/capture','artifacts/create','artifacts/revise','artifacts/versions','artifacts/snapshot','artifacts/list','artifacts/feedback/add','artifacts/feedback/list']
export function createArtifactHandler(owner:string,ports:{pool:()=>Promise<ArtifactService['pool']>;conversation:(sessionId:string)=>Promise<Conversation>;readFile:(sessionId:string,path:string,signal:AbortSignal)=>Promise<ArtifactFile>;readMessage?:(message:SavedArtifactMessage)=>Promise<SavedArtifactMessage>;id:()=>string;now:()=>string}){
 const source=async(sessionId:unknown):Promise<SavedArtifactSource>=>{
  if(typeof sessionId!=='string'||!/^[\w-]{1,128}$/.test(sessionId))throw new WorkError('teloa/invalid-input','会话身份不正确。')
  const binding=await ports.conversation(sessionId)
  if(binding.ownerId!==owner||binding.sessionId!==sessionId||binding.status!=='ready')throw new WorkError('teloa/not-bound','成果来源不是本人已就绪的工作会话。')
  return {kind:'session',id:sessionId,scope:binding.scopeIds[0],version:binding.id,title:binding.title}
 }
 return async(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>=>{
  if(!artifactEndpoints.includes(endpoint))throw new WorkError('teloa/invalid-input','未知成果接口。')
  if(endpoint==='artifacts/task/sessions'){const row=artifactInput(payload,['taskId']);return taskArtifactSessions(await ports.pool(),owner,row.taskId as string,false)}
  if(endpoint==='artifacts/task/source'){const row=artifactInput(payload,['taskId']);return taskArtifactSource(await ports.pool(),owner,row.taskId as string,false)}
  if(endpoint==='artifacts/source'){const row=artifactInput(payload,['sessionId']);return source(row.sessionId)}
  if(endpoint==='artifacts/message/capture'){
   const row=artifactInput(payload,['message']),expected=savedArtifactMessage(row.message);await source(expected.sessionId)
   if(!ports.readMessage)throw new WorkError('teloa/session-unavailable','原消息捕获尚不可用。')
   const message=savedArtifactMessage(await ports.readMessage(expected));if(JSON.stringify(message)!==JSON.stringify(expected))throw new WorkError('teloa/version-conflict','原消息内容不一致，请重新核对。')
   signal.throwIfAborted();const snapshotId=await new ArtifactMessageStore(await ports.pool()).save(owner,message);return {snapshotId,message}
  }
  if(endpoint==='artifacts/capture'){
   const row=artifactInput(payload,['sessionId','path','expectedSha256']);await source(row.sessionId)
   if(!artifactFilePath(row.path)||typeof row.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.expectedSha256))throw new WorkError('teloa/invalid-input','文件路径或待保存版本不正确。')
   const file=await ports.readFile(row.sessionId as string,row.path,signal)
   if(file.sessionId!==row.sessionId||file.path!==row.path||file.sha256!==row.expectedSha256)throw new WorkError('teloa/version-conflict','文件内容已变化，请重新读取核对后保存。')
   signal.throwIfAborted();const store=new ArtifactSnapshotStore(await ports.pool()),snapshotId=await store.save(owner,file)
   return {snapshotId,file}
  }
  const pool=await ports.pool()
  if(endpoint==='artifacts/feedback/add'||endpoint==='artifacts/feedback/list'){const feedback=new ArtifactFeedbackService(pool,{id:ports.id,now:ports.now});return endpoint==='artifacts/feedback/add'?feedback.add(owner,payload):feedback.list(owner,payload)}
  if(endpoint==='artifacts/message/snapshot'){const row=artifactInput(payload,['snapshotId']);if(typeof row.snapshotId!=='string')throw new WorkError('teloa/invalid-input','快照身份不正确。');return new ArtifactMessageStore(pool).read(owner,row.snapshotId)}
  if(endpoint==='artifacts/snapshot'){const row=artifactInput(payload,['snapshotId']);if(typeof row.snapshotId!=='string')throw new WorkError('teloa/invalid-input','快照身份不正确。');return new ArtifactSnapshotStore(pool).read(owner,row.snapshotId)}
  const service=new ArtifactService(pool,{id:ports.id,now:ports.now},async(actor,expected,client)=>{
   if(actor===owner&&expected.kind==='task'){const taskSource=await taskArtifactSource(client,owner,expected.id,true),sessionIds=await taskArtifactSessions(client,owner,expected.id,true);for(const id of sessionIds)await source(id);return {source:taskSource,sessionIds}}
   if(actor!==owner||expected.kind!=='session')throw new WorkError('teloa/forbidden','此来源的真实成果服务尚未接入。')
   return {source:await source(expected.id),sessionIds:[expected.id]}
  })
  if(endpoint==='artifacts/task/list'){const row=artifactInput(payload,['taskId']);return service.listSource(owner,await taskArtifactSource(pool,owner,row.taskId as string,false))}
  if(endpoint==='artifacts/list'){const row=artifactInput(payload,['sessionId']);return service.listSource(owner,await source(row.sessionId))}
  if(endpoint==='artifacts/create'||endpoint==='artifacts/revise'){
   // 服务保留严格命令校验，不能把客户端作者或状态字段透传进数据库。
   return endpoint==='artifacts/create'?service.create(owner,payload):service.revise(owner,payload)
  }
  return service.list(owner,payload)
 }
}
