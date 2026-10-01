import test from 'node:test'
import assert from 'node:assert/strict'
import {createArtifactApi} from '../src/client/artifact-api.ts'
import type {Artifact} from '../src/client/artifact-preview.ts'
import {createHash} from 'node:crypto'
const id='12345678-1234-4234-8234-123456789012',source={kind:'session' as const,id:'s1',scope:'general',version:'binding',title:'来源'},at='2026-09-11T00:00:00Z'
const input:Artifact={id:'temporary',source:{kind:'session',id:'s1'},primary:false,links:[],feedback:[],versions:[{number:1,title:'成果',sections:[{id:'p1',title:'正文',text:'结果'}],source:{ref:{kind:'session',id:'s1'},scope:'general',version:'binding',title:'来源',author:'本人',private:true,evidence:[]},note:'保存',author:'本人',at}]}
test('任务消息保存使用关联会话并可读回，未关联消息不捕获',async()=>{
 const artifact=structuredClone(input);artifact.source={kind:'task',id};artifact.versions[0]!.source.ref=artifact.source
 const message={sessionId:'s1',messageId:'m1',seq:1,role:'assistant' as const,at,text:'原结论',images:[],interrupted:false,omittedBlocks:0};artifact.versions[0]!.messages=[message]
 const taskSource={...source,kind:'task',id},snapshot='a'.repeat(64);let saved:any,allowed=true,captures=0
 const api=createArtifactApi(async(method,payload:any)=>{if(method==='artifacts/task/source')return taskSource;if(method==='artifacts/task/sessions')return allowed?['s1']:[];if(method==='artifacts/message/capture'){captures++;return {snapshotId:snapshot,message}}if(method==='artifacts/create'){saved={artifactId:id,ownerId:'owner',number:1,source:taskSource,content:payload.content,createdAt:at};return saved}if(method==='artifacts/versions')return [saved];if(method==='artifacts/message/snapshot')return message;if(method==='artifacts/feedback/list')return [];throw Error(method)})
 allowed=false;await assert.rejects(api.save(artifact,true),/关联/);assert.equal(captures,0)
 allowed=true;const result=await api.save(artifact,true);assert.deepEqual(result.versions[0]!.messages,[message])
})
test('未知创建结果重试保留原请求并读取持久身份，禁止换内容重试',async()=>{
 let saved:any,first=true;const requests:unknown[]=[]
 const api=createArtifactApi(async(method,payload:any)=>{
  if(method==='artifacts/feedback/list')return []
  if(method==='artifacts/source')return source
  if(method==='artifacts/create'){requests.push(payload);saved={artifactId:id,ownerId:'owner',number:1,source,content:payload.content,createdAt:at};if(first){first=false;throw Error('回包丢失')}return saved}
  if(method==='artifacts/versions')return [saved]
  throw Error('不应调用 '+method)
 })
 await assert.rejects(api.save(input,true),/回包丢失/)
 const changed=structuredClone(input);changed.versions[0]!.title='另一个成果'
 await assert.rejects(api.save(changed,true),/原内容/)
 const result=await api.save(input,true);assert.equal(result.id,id);assert.equal(result.storage,'persistent');assert.deepEqual(requests[0],requests[1])
})
test('目录不能把其他会话的成果或不连续历史混入当前会话',async()=>{
 const version={artifactId:id,ownerId:'owner',number:1,source:{...source,id:'other'},content:{title:'成果',sections:[{id:'p1',title:'正文',text:'结果'}],note:'保存',snapshotIds:[]},createdAt:at}
 await assert.rejects(createArtifactApi(async()=>[version]).list('s1'),/身份不一致/)
 const api=createArtifactApi(async(method)=>method==='artifacts/list'?[{...version,source}]:[{...version,source,number:2}])
 await assert.rejects(api.list('s1'),/不连续/)
})
test('纯文件成果可读取，正文修订继续引用旧快照而不重新读取原文件',async()=>{
 const snapshotId='a'.repeat(64),file={schema:'teloa.file-snapshot/v1',sessionId:'s1',id:'b'.repeat(64),path:'out.py',sha256:createHash('sha256').update('x').digest('hex'),bytes:1,capturedAt:at,contentBase64:'eA=='}
 const rows:any[]=[{artifactId:id,ownerId:'owner',number:1,source,content:{title:'文件成果',sections:[],snapshotIds:[snapshotId],note:'保存文件'},createdAt:at}]
 const api=createArtifactApi(async(method,payload:any)=>{
  if(method==='artifacts/list')return [rows.at(-1)]
  if(method==='artifacts/versions')return rows
  if(method==='artifacts/snapshot')return file
  if(method==='artifacts/feedback/list')return []
  if(method==='artifacts/source')return source
  if(method==='artifacts/revise'){assert.deepEqual(payload.content.snapshotIds,[snapshotId]);const row={...rows[0],number:2,content:payload.content};rows.push(row);return row}
  throw Error('原文件已不存在，不能调用 '+method)
 })
 const [loaded]=await api.list('s1');assert.equal(loaded!.versions[0]!.sections[0]!.text,'out.py')
 const revised=structuredClone(loaded!);revised.versions.push({...revised.versions[0]!,number:2,sections:[{id:'files-summary',title:'说明',text:'补充交付说明'}],note:'修改正文'})
 const result=await api.save(revised,false);assert.equal(result.versions.length,2);assert.equal(result.versions[1]!.files![0]!.contentBase64,'eA==')
})
test('丢回包后重建客户端仍用原请求恢复，日志写入失败不能发送保存',async()=>{
 let record:string|null=null,saved:any,first=true;const requests:unknown[]=[]
 const journal={read:()=>record,write:(value:string)=>{record=value},clear:()=>{record=null}}
 const call=async(method:string,payload:any)=>{
  if(method==='artifacts/feedback/list')return []
  if(method==='artifacts/source')return source
  if(method==='artifacts/create'){requests.push(payload);saved={artifactId:id,ownerId:'owner',number:1,source,content:payload.content,createdAt:at};if(first){first=false;throw Error('回包丢失')}return saved}
  if(method==='artifacts/versions')return [saved]
  throw Error('不应调用 '+method)
 }
 await assert.rejects(createArtifactApi(call,journal).save(input,true),/回包丢失/)
 const restored=createArtifactApi(call,journal),items=restored.pendingFor('s1')
 assert.equal(items.length,1);assert.deepEqual(restored.pendingFor('other'),[])
 const result=await restored.recover(items[0]!.key);assert.equal(result.id,id);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(restored.pendingFor('s1'),[])
 assert.equal(record,null)
 const blocked=createArtifactApi(call,{read:()=>null,write:()=>{throw Error('存储不可用')}})
 await assert.rejects(blocked.save(input,true),/存储不可用/);assert.equal(requests.length,2)
})
test('损坏的恢复日志阻止保存，但已保存目录仍可查看',async()=>{
 let writes=0
 const api=createArtifactApi(async(method)=>{assert.equal(method,'artifacts/list');return []},{read:()=>'{broken',write:()=>{writes++}})
 assert.equal(api.recoveryMessage()?.code,'teloa/storage-corrupt')
 assert.deepEqual(await api.list('s1'),[])
 await assert.rejects(api.save(input,true),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt');assert.equal(writes,0)
})
test('恢复目录只暴露能定位到真实成果和来源的保存请求',()=>{
 const journal={read:()=>JSON.stringify({schema:'teloa.artifact-save/v1',requests:[{key:'revise:'+id+':1',intent:'revision',requestId:'87654321-1234-4234-8234-123456789012',payload:{artifactId:id,expectedVersion:1,source,content:{title:'成果',sections:[{id:'p1',title:'正文',text:'结果'}],note:'保存',snapshotIds:[]}}}]}),write:()=>{}}
 const api=createArtifactApi(async()=>{throw Error('恢复目录不应请求网络')},journal)
 assert.deepEqual(api.recoveryItems(),[{key:'revise:'+id+':1',artifactId:id,version:1,source:{kind:'session',id:'s1'},title:'成果'}])
})
test('成果恢复收到确定性拒绝时移除最后一条本机存储记录',async()=>{
 const request={key:'revise:'+id+':1',intent:'revision',requestId:'87654321-1234-4234-8234-123456789012',payload:{artifactId:id,expectedVersion:1,source,content:{title:'成果',sections:[{id:'p1',title:'正文',text:'结果'}],note:'保存',snapshotIds:[]}}}
 let record:string|null=JSON.stringify({schema:'teloa.artifact-save/v1',requests:[request]})
 const api=createArtifactApi(async()=>{throw Object.assign(Error('版本已失效'),{rejected:true,code:'teloa/version-conflict'})},{read:()=>record,write:value=>{record=value},clear:()=>{record=null}})
 await assert.rejects(api.recover('revise:'+id+':1'),/版本已失效/)
 assert.equal(record,null)
 assert.deepEqual(api.recoveryItems(),[])
})
test('反馈丢回包后刷新仍固定原版本与请求，不能漂移到新版本',async()=>{
 let record:string|null=null,first=true;const requests:unknown[]=[]
 const rows=[{artifactId:id,ownerId:'owner',number:1,source,content:{title:'成果',sections:[{id:'p1',title:'正文',text:'结果'}],note:'保存',snapshotIds:[]},createdAt:at}]
 let feedback:any
 const journal={read:()=>record,write:(value:string)=>{record=value}}
 const call=async(method:string,payload:any)=>{
  if(method==='artifacts/feedback/add'){requests.push(payload);feedback={id:'87654321-1234-4234-8234-123456789012',artifactId:id,ownerId:'owner',version:payload.version,sectionId:payload.sectionId,text:payload.text,createdAt:at};if(first){first=false;throw Error('回包丢失')}return feedback}
  if(method==='artifacts/feedback/list')return feedback?[feedback]:[]
  if(method==='artifacts/versions')return rows
  throw Error('不应调用 '+method)
 }
 const artifact={...structuredClone(input),id,storage:'persistent' as const}
 await assert.rejects(createArtifactApi(call,journal).feedback(artifact,1,'p1','补充依据'),/回包丢失/)
 rows.push({...rows[0]!,number:2,content:{...rows[0]!.content,sections:[{id:'p1',title:'正文',text:'新正文'}]}})
 const restored=createArtifactApi(call,journal),pending=restored.pendingFor('s1')
 assert.equal(pending.length,1)
 const loaded=await restored.recover(pending[0]!.key)
 assert.equal(loaded.versions.length,2);assert.equal(loaded.feedback.length,1);assert.equal(loaded.feedback[0]!.version,1)
 assert.deepEqual(requests[0],requests[1]);assert.deepEqual(restored.pendingFor('s1'),[])
})
test('任务成果使用真实任务来源，旧任务版本不能被保存时静默替换',async()=>{
 const artifact=structuredClone(input);artifact.source={kind:'task',id:'task-1'};artifact.versions[0]!.source={...artifact.versions[0]!.source,ref:artifact.source,private:false}
 const taskSource={...source,kind:'task',id:'task-1'};let saved:any
 const api=createArtifactApi(async(method,payload:any)=>{
  if(method==='artifacts/task/source')return taskSource
  if(method==='artifacts/create'){saved={artifactId:id,ownerId:'owner',number:1,source:taskSource,content:payload.content,createdAt:at};return saved}
  if(method==='artifacts/versions')return [saved]
  if(method==='artifacts/feedback/list')return []
  throw Error(method)
 })
 const result=await api.save(artifact,true);assert.equal(result.source.kind,'task');assert.equal(result.storage,'persistent')
 await assert.rejects(createArtifactApi(async()=>({...taskSource,version:'changed'})).save(artifact,true),/来源已变化/)
})
