import test from 'node:test'
import assert from 'node:assert/strict'
import {createArtifactHandler} from '../src/artifacts.ts'
test('成果来源使用宿主工作绑定，拒绝外部作者和错误主体',async()=>{
 const binding={id:'binding',ownerId:'owner',title:'真实来源',scopeIds:['general'] as ['general'],version:1 as const,status:'ready' as const,requestedSessionId:'s1',sessionId:'s1',createdAt:'2026-09-11T00:00:00Z'}
 let actor='owner',read=false
 const handle=createArtifactHandler('owner',{pool:async()=>{throw Error('不应访问数据库')},conversation:async()=>({...binding,ownerId:actor}),readFile:async()=>{read=true;throw Error('不应读取文件')},id:()=>'',now:()=>''}),signal=new AbortController().signal
 assert.deepEqual(await handle('artifacts/source',{sessionId:'s1'},signal),{kind:'session',id:'s1',scope:'general',version:'binding',title:'真实来源'})
 await assert.rejects(handle('artifacts/source',{sessionId:'s1',ownerId:'other'},signal),{code:'teloa/invalid-input'})
 actor='other';await assert.rejects(handle('artifacts/capture',{sessionId:'s1',path:'out.py',expectedSha256:'a'.repeat(64)},signal),{code:'teloa/not-bound'});assert.equal(read,false)
})
test('捕获必须匹配重新读取的文件版本，不能由客户端提交字节或绕过运行目录限制',async()=>{
 let reads=0
 const handle=createArtifactHandler('owner',{pool:async()=>{throw Error('不应访问数据库')},conversation:async()=>({id:'binding',ownerId:'owner',title:'来源',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'s1',sessionId:'s1',createdAt:'2026-09-11T00:00:00Z'}),readFile:async()=>{reads++;return {schema:'teloa.file-snapshot/v1',sessionId:'s1',id:'a'.repeat(64),path:'out.py',sha256:'b'.repeat(64),bytes:1,capturedAt:'2026-09-11T00:00:00Z',contentBase64:'eA=='}},id:()=>'',now:()=>''}),signal=new AbortController().signal
 const input={sessionId:'s1',path:'out.py',expectedSha256:'a'.repeat(64)}
 await assert.rejects(handle('artifacts/capture',{...input,contentBase64:'eA=='},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handle('artifacts/capture',{...input,path:'.runtime/private'},signal),{code:'teloa/invalid-input'});assert.equal(reads,0)
 await assert.rejects(handle('artifacts/capture',input,signal),{code:'teloa/version-conflict'});assert.equal(reads,1)
})
test('会话成果目录先验证本人就绪绑定，不能客户端指定任务或他人身份绕过来源',async()=>{
 let databaseReads=0
 const handle=createArtifactHandler('owner',{pool:async()=>{databaseReads++;throw Error('未授权前不应读取数据库')},conversation:async()=>({id:'binding',ownerId:'other',title:'来源',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'s1',sessionId:'s1',createdAt:'2026-09-11T00:00:00Z'}),readFile:async()=>{throw Error('不应读取文件')},id:()=>'',now:()=>''}),signal=new AbortController().signal
 await assert.rejects(handle('artifacts/conversation/list',{sessionId:'s1'},signal),{code:'teloa/not-bound'})
 await assert.rejects(handle('artifacts/conversation/list',{sessionId:'s1',taskId:'forged'},signal),{code:'teloa/invalid-input'})
 assert.equal(databaseReads,0)
})
test('会话成果目录返回当前会话身份；读取中工作绑定变化则不交付目录',async()=>{
 let reads=0,change=false
 const pool={query:async()=>({rows:[]})} as unknown as Awaited<ReturnType<Parameters<typeof createArtifactHandler>[1]['pool']>>
 const handle=createArtifactHandler('owner',{pool:async()=>pool,conversation:async()=>({id:change&&++reads>1?'new-binding':'binding',ownerId:'owner',title:'来源',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'s1',sessionId:'s1',createdAt:'2026-09-11T00:00:00Z'}),readFile:async()=>{throw Error('不应读取文件')},id:()=>'',now:()=>''}),signal=new AbortController().signal
 assert.deepEqual(await handle('artifacts/conversation/list',{sessionId:'s1'},signal),{sessionId:'s1',artifacts:[]})
 change=true;await assert.rejects(handle('artifacts/conversation/list',{sessionId:'s1'},signal),{code:'teloa/version-conflict'})
})
test('员工成果目录只接受员工身份，返回宿主核对后的只读引用',async()=>{
 const roleId='11111111-1111-4111-8111-111111111111',artifactId='22222222-2222-4222-8222-222222222222',queries:string[]=[]
 const pool={query:async(sql:string,args:unknown[])=>{
  queries.push(sql)
  if(sql.startsWith('select 1 from teloa_roles'))return {rows:args[1]===roleId?[{'?column?':1}]:[]}
  if(sql.includes('from teloa_artifacts h'))return {rows:[{artifact_id:artifactId,number:2,title:'周报',source:{kind:'task',id:'33333333-3333-4333-8333-333333333333',scope:'general',version:'1',title:'周报任务'},created_at:new Date('2026-10-01T00:00:00Z'),updated_at:new Date('2026-10-02T00:00:00Z'),attribution:'task'}]}
  throw Error('未预期的查询：'+sql)
 }} as unknown as Awaited<ReturnType<Parameters<typeof createArtifactHandler>[1]['pool']>>
 const handle=createArtifactHandler('owner',{pool:async()=>pool,conversation:async()=>{throw Error('不应读取会话')},readFile:async()=>{throw Error('不应读取文件')},id:()=>'',now:()=>''}),signal=new AbortController().signal
 await assert.rejects(handle('artifacts/role/list',{roleId,ownerId:'other'},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handle('artifacts/role/list',{roleId:'not-a-role'},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handle('artifacts/role/list',{},signal),{code:'teloa/invalid-input'})
 assert.equal(queries.length,0,'入参不对不访问数据库')
 assert.deepEqual(await handle('artifacts/role/list',{roleId},signal),[{artifactId,number:2,title:'周报',source:{kind:'task',id:'33333333-3333-4333-8333-333333333333',scope:'general',version:'1',title:'周报任务'},createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-02T00:00:00.000Z',attribution:'task'}])
 await assert.rejects(handle('artifacts/role/list',{roleId:'44444444-4444-4444-8444-444444444444'},signal),{code:'teloa/forbidden'})
})
