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
