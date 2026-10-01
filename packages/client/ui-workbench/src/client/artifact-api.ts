import {artifactInput,artifactContent,savedArtifactMessage,savedArtifactSource,savedArtifactFeedback,isArtifactFile,type SavedArtifactVersion,type ArtifactFile} from '@teloa/contract'
import type {Artifact} from './artifact-preview.js'
import {recoveryStorageError} from './recovery-error.ts'
type Call=(method:string,payload:unknown)=>Promise<unknown>
export type ArtifactSaveJournal={read:()=>string|null;write:(value:string)=>void;clear?:()=>void}
type Pending={intent:string;requestId:string;payload?:unknown}
const rejected=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&(error as {rejected?:unknown}).rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String((error as {code?:unknown}).code))
function prepared(key:string,value:unknown){
 if(key.startsWith('feedback:')){const row=artifactInput(value,['requestId','artifactId','version','sectionId','text','source']),source=savedArtifactSource(row.source);if(!['session','task'].includes(source.kind)||typeof row.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.requestId)||typeof row.artifactId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.artifactId)||!Number.isSafeInteger(row.version)||(row.version as number)<1||typeof row.sectionId!=='string'||!row.sectionId||typeof row.text!=='string'||!row.text.trim()||row.text.length>4000||key!=='feedback:'+row.artifactId+':'+row.version+':'+row.sectionId)throw Error('待核对反馈身份不正确。');return {creating:false,feedback:true,row,source,content:{title:'反馈 · '+source.title}}}
 const creating=key.startsWith('create:'),row=artifactInput(value,creating?['requestId','source','content']:['artifactId','expectedVersion','source','content']),source=savedArtifactSource(row.source),content=artifactContent(row.content)
 const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
 if(!['session','task'].includes(source.kind)||(creating?(!uuid(row.requestId)||key!=='create:'+(source.kind==='task'?'task:':'')+source.id):(!uuid(row.artifactId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1||key!=='revise:'+row.artifactId+':'+row.expectedVersion)))throw Error('待保存身份不正确。')
 return {creating,feedback:false,row,source,content}
}
/** 导出供 group-attachment-api.ts 复用：group 消息里 artifact 引用按 artifactId+version 读版本清单走同一条解析。 */
export function read(value:unknown):SavedArtifactVersion{
 const row=artifactInput(value,['artifactId','ownerId','number','source','content','createdAt'])
 if(typeof row.artifactId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.artifactId)||typeof row.ownerId!=='string'||!row.ownerId||!Number.isSafeInteger(row.number)||(row.number as number)<1||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw Error('成果响应格式不正确。')
 return {artifactId:row.artifactId,ownerId:row.ownerId,number:row.number as number,source:savedArtifactSource(row.source),content:artifactContent(row.content),createdAt:row.createdAt}
}
export type ArtifactApi=ReturnType<typeof createArtifactApi>
export function createArtifactApi(call:Call,journal?:ArtifactSaveJournal){
 const fileKey=(file:ArtifactFile)=>JSON.stringify([file.sessionId,file.id,file.path,file.sha256,file.capturedAt])
 const snapshotIdsByFile=new Map<string,string>(),snapshotIdsByMessage=new Map<string,string>()
 const pending=new Map<string,Pending>(),files=new Map<string,ArtifactFile>()
 let recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 const persist=(rows=pending)=>journal?.write(JSON.stringify({schema:'teloa.artifact-save/v1',requests:[...rows].filter(([,request])=>request.payload).map(([key,request])=>({key,...request}))}))
 try{
  const raw=journal?.read()
  if(raw){if(raw.length>2000000)throw Error();const envelope=artifactInput(JSON.parse(raw),['schema','requests']);if(envelope.schema!=='teloa.artifact-save/v1'||!Array.isArray(envelope.requests)||envelope.requests.length>100)throw Error()
   for(const value of envelope.requests){const row=artifactInput(value,['key','intent','requestId','payload']);if(typeof row.key!=='string'||typeof row.intent!=='string'||row.intent.length>150000||typeof row.requestId!=='string'||pending.has(row.key))throw Error();const request=prepared(row.key,row.payload);if((request.creating||request.feedback)&&request.row.requestId!==row.requestId)throw Error();pending.set(row.key,{intent:row.intent,requestId:row.requestId,payload:row.payload})}
  }
 }catch{pending.clear();recoveryError=recoveryStorageError()}
 const finish=(key:string)=>{const next=new Map(pending);next.delete(key);if(next.size)persist(next);else journal?.clear?.();pending.delete(key)}
 async function taskSessions(taskId:string):Promise<string[]>{const rows=await call('artifacts/task/sessions',{taskId});if(!Array.isArray(rows)||rows.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))||new Set(rows).size!==rows.length)throw Error('任务关联会话目录不正确。');return rows}
 async function snapshot(id:string){const value=await call('artifacts/snapshot',{snapshotId:id});if(!isArtifactFile(value))throw Error('成果文件快照格式不正确。');return value}
 async function hydrate(rows:SavedArtifactVersion[]):Promise<Artifact>{
  const first=rows[0];if(!first||(first.source.kind!=='session'&&first.source.kind!=='task'))throw Error('成果来源暂不支持或历史为空。')
  const versions=[]
  for(const [index,row] of rows.entries()){
   if(row.number!==index+1||row.artifactId!==first.artifactId||row.ownerId!==first.ownerId||row.source.id!==first.source.id||row.source.kind!==first.source.kind||row.source.scope!==first.source.scope)throw Error('成果历史版本不连续或来源不一致。')
   const snapshots=[]
   for(const id of row.content.snapshotIds){const file=files.get(id)??await snapshot(id);if(row.source.kind==='session'&&file.sessionId!==row.source.id)throw Error('文件与成果来源不一致。');files.set(id,file);snapshotIdsByFile.set(fileKey(file),id);snapshots.push(file)}
   const messages=[]
   for(const id of row.content.messageSnapshotIds??[]){const message=savedArtifactMessage(await call('artifacts/message/snapshot',{snapshotId:id}));if(row.source.kind==='session'&&message.sessionId!==row.source.id)throw Error('消息快照与成果来源不一致。');snapshotIdsByMessage.set(JSON.stringify(message),id);messages.push(message)}
   versions.push({messages,number:row.number,title:row.content.title,sections:row.content.sections.length?row.content.sections:[{id:'files-summary',title:'文件快照',text:snapshots.map(file=>file.path).join('、')}],source:{ref:{kind:row.source.kind as 'session'|'task',id:row.source.id},title:row.source.title,scope:row.source.scope,version:row.source.version,author:'本人',evidence:[],private:row.source.kind==='session'},note:row.content.note,author:'本人',at:row.createdAt,files:snapshots,...(row.content.feedbackId?{feedbackId:row.content.feedbackId}:{})})
  }
  return {id:first.artifactId,source:{kind:first.source.kind,id:first.source.id},primary:false,links:[],feedback:[],versions,storage:'persistent'}
 }
 async function comments(artifact:Artifact,ownerId:string){const value=await call('artifacts/feedback/list',{artifactId:artifact.id});if(!Array.isArray(value))throw Error('成果反馈目录格式不正确。');const rows=value.map(savedArtifactFeedback);if(new Set(rows.map(row=>row.id)).size!==rows.length||rows.some(row=>row.ownerId!==ownerId||row.artifactId!==artifact.id||!artifact.versions.find(v=>v.number===row.version)?.sections.some(s=>s.id===row.sectionId)))throw Error('成果反馈与版本不一致。');return {...artifact,feedback:rows.map(row=>({id:row.id,version:row.version,sectionId:row.sectionId,text:row.text,author:'本人',at:row.createdAt}))}}
 async function load(id:string){const value=await call('artifacts/versions',{artifactId:id});if(!Array.isArray(value))throw Error('成果历史格式不正确。');const rows=value.map(read);if(rows.some(row=>row.artifactId!==id))throw Error('成果响应身份不一致。');return comments(await hydrate(rows),rows[0]!.ownerId)}
 async function prepare(artifact:Artifact){
  const version=artifact.versions.at(-1)!
  if((artifact.source.kind!=='session'&&artifact.source.kind!=='task')||artifact.links.length)throw Error('选定消息、图片引用或对象关联的真实保存尚未接入，请先保留原稿；不会丢弃这些内容保存。')
  const source=savedArtifactSource(await call(artifact.source.kind==='task'?'artifacts/task/source':'artifacts/source',artifact.source.kind==='task'?{taskId:artifact.source.id}:{sessionId:artifact.source.id}));if(source.id!==artifact.source.id||source.kind!==artifact.source.kind)throw Error('成果来源响应不一致。')
  if(artifact.source.kind==='task'&&(source.version!==version.source.version||source.scope!==version.source.scope||source.title!==version.source.title))throw Error('任务来源已变化，请刷新任务并核对草稿。')
  if(artifact.source.kind==='task'&&(version.files?.length||version.messages?.length)){const ids=await taskSessions(artifact.source.id);if([...(version.files??[]),...(version.messages??[])].some(item=>!ids.includes(item.sessionId)))throw Error('引用会话未关联此任务，请核对当前关联。')}
  const snapshotIds=[]
  for(const file of version.files||[]){const existing=snapshotIdsByFile.get(fileKey(file));if(existing){snapshotIds.push(existing);continue}const captured=artifactInput(await call('artifacts/capture',{sessionId:file.sessionId,path:file.path,expectedSha256:file.sha256}),['snapshotId','file']);if(typeof captured.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(captured.snapshotId)||!isArtifactFile(captured.file)||captured.file.sha256!==file.sha256||captured.file.path!==file.path||captured.file.sessionId!==file.sessionId)throw Error('文件捕获响应与选定文件不一致。');files.set(captured.snapshotId,captured.file);snapshotIdsByFile.set(fileKey(file),captured.snapshotId);snapshotIdsByFile.set(fileKey(captured.file),captured.snapshotId);snapshotIds.push(captured.snapshotId)}
  const messageSnapshotIds=[]
  for(const selected of version.messages??[]){const message=savedArtifactMessage(selected),key=JSON.stringify(message),existing=snapshotIdsByMessage.get(key);if(existing){messageSnapshotIds.push(existing);continue}const captured=artifactInput(await call('artifacts/message/capture',{message}),['snapshotId','message']);if(typeof captured.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(captured.snapshotId)||JSON.stringify(savedArtifactMessage(captured.message))!==key)throw Error('捕获内容与选定原消息不一致。');snapshotIdsByMessage.set(key,captured.snapshotId);messageSnapshotIds.push(captured.snapshotId)}
  return {source,content:artifactContent({...(messageSnapshotIds.length?{messageSnapshotIds}:{}),title:version.title,sections:version.sections,snapshotIds,note:version.note,...(version.feedbackId?{feedbackId:version.feedbackId}:{})})}
 }
 return {
  get:load,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending.size>0||recoveryError!==undefined;try{journal?.clear?.()}catch{/* 清不掉不该变成第二道墙 */}pending.clear();recoveryError=undefined;return had},
  recoveryItems:()=>[...pending].flatMap(([key,request])=>{
   if(!request.payload||key.startsWith('create:'))return []
   const value=prepared(key,request.payload),artifactId=key.split(':')[1]
   const row=request.payload as {expectedVersion?:unknown;version?:unknown}
   const version=typeof row.expectedVersion==='number'?row.expectedVersion:row.version
   const source={kind:value.source.kind as 'session'|'task',id:value.source.id}
   return artifactId&&typeof version==='number'?[{key,artifactId,version,source,title:value.content.title}]:[]
  }),
  taskSessions,
  pendingFor:(sessionId:string,kind:'session'|'task'='session')=>[...pending].flatMap(([key,request])=>{if(!request.payload)return [];const value=prepared(key,request.payload);return value.source.id===sessionId&&value.source.kind===kind?[{key,title:value.content.title}]:[]}),
  async recover(key:string){
   if(recoveryError)throw recoveryError
   if(busy)throw Error('成果请求正在核对，请等待完成。')
   const request=pending.get(key);if(!request?.payload)throw Error('没有待核对的保存请求。')
   const value=prepared(key,request.payload);busy=true
   try{persist();if(value.feedback){const result=savedArtifactFeedback(await call('artifacts/feedback/add',request.payload));if(result.artifactId!==value.row.artifactId||result.version!==value.row.version||result.sectionId!==value.row.sectionId||result.text!==value.row.text)throw Error('反馈恢复响应不一致。');const saved=await load(result.artifactId);finish(key);return saved}const result=read(await call(value.creating?'artifacts/create':'artifacts/revise',request.payload));if(result.source.id!==value.source.id||result.number!==(value.creating?1:(value.row.expectedVersion as number)+1)||(!value.creating&&result.artifactId!==value.row.artifactId))throw Error('成果恢复响应不一致。');const saved=await load(result.artifactId);finish(key);return saved}catch(error){if(rejected(error))finish(key);throw error}finally{busy=false}
  },
  async list(sessionId:string,kind:'session'|'task'='session'){const value=await call(kind==='task'?'artifacts/task/list':'artifacts/list',kind==='task'?{taskId:sessionId}:{sessionId});if(!Array.isArray(value))throw Error('成果目录格式不正确。');const rows=value.map(read);if(rows.some(row=>row.source.kind!==kind||row.source.id!==sessionId)||new Set(rows.map(row=>row.artifactId)).size!==rows.length)throw Error('成果目录身份不一致。');return Promise.all(rows.map(row=>load(row.artifactId)))},
  async feedback(artifact:Artifact,version:number,sectionId:string,text:string){
   if(recoveryError)throw recoveryError;if(busy)throw Error('成果请求正在核对，请等待完成。')
   const target=artifact.versions.find(item=>item.number===version);if(!target||(target.source.ref.kind!=='session'&&target.source.ref.kind!=='task'))throw Error('反馈目标版本不存在。')
   const source={kind:target.source.ref.kind,id:target.source.ref.id,scope:target.source.scope,version:target.source.version,title:target.source.title},key='feedback:'+artifact.id+':'+version+':'+sectionId,intent=JSON.stringify({artifactId:artifact.id,version,sectionId,text:text.trim(),source})
   let request=pending.get(key);if(request&&request.intent!==intent)throw Error('先核对原反馈请求后再提交其他反馈。')
   if(!request){const requestId=crypto.randomUUID();request={requestId,intent,payload:{requestId,...JSON.parse(intent)}};prepared(key,request.payload);pending.set(key,request)}
   busy=true;try{persist();const result=savedArtifactFeedback(await call('artifacts/feedback/add',request.payload));if(result.artifactId!==artifact.id||result.version!==version||result.sectionId!==sectionId||result.text!==text.trim())throw Error('反馈保存响应不一致。');const saved=await load(artifact.id);finish(key);return saved}catch(error){if(rejected(error))finish(key);throw error}finally{busy=false}
  },
  async save(artifact:Artifact,creating:boolean){
   if(recoveryError)throw recoveryError
   if(busy)throw Error('成果请求正在核对，请等待完成。')
   busy=true
   try{
   const version=artifact.versions.at(-1)!,key=creating?'create:'+(artifact.source.kind==='task'?'task:':'')+artifact.source.id:'revise:'+artifact.id+':'+(version.number-1)
   const intent=JSON.stringify({source:artifact.source,title:version.title,sections:version.sections,note:version.note,feedbackId:version.feedbackId,messages:version.messages,files:version.files?.map(file=>[file.id,file.path,file.sha256])})
   let request=pending.get(key)
   if(request&&request.intent!==intent)throw Error('上次成果保存结果尚待核对，请先用原内容重试。')
   if(!request){request={intent,requestId:crypto.randomUUID()};pending.set(key,request)}
   if(!request.payload){try{const prepared=await prepare(artifact);request.payload=creating?{requestId:request.requestId,...prepared}:{artifactId:artifact.id,expectedVersion:version.number-1,...prepared}}catch(error){pending.delete(key);throw error}}
   persist()
   const result=read(await call(creating?'artifacts/create':'artifacts/revise',request.payload))
   if(result.source.id!==artifact.source.id||(!creating&&result.artifactId!==artifact.id)||result.number!==version.number)throw Error('成果保存响应身份或版本不一致。')
   const saved=await load(result.artifactId);finish(key);return saved
   }catch(error){if(rejected(error)){const version=artifact.versions.at(-1)!,key=creating?'create:'+(artifact.source.kind==='task'?'task:':'')+artifact.source.id:'revise:'+artifact.id+':'+(version.number-1);finish(key)}throw error}finally{busy=false}
  },
 }
}
