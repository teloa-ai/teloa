import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createGithubSourceHandler} from '../src/github-source.ts'

const requestId='11111111-1111-4111-8111-111111111111',commit='0123456789abcdef0123456789abcdef01234567',archiveHash='a'.repeat(64),bytes=new TextEncoder().encode('{}')
const request={requestId,owner:'teloa-ai',repo:'starter',ref:'main'}
const receipt={requestId,ownerId:'local:teloa-owner',stage:'ready' as const,provenance:{kind:'github' as const,owner:request.owner,repo:request.repo,requestedRef:request.ref,resolvedCommit:commit,archiveHash},files:[{path:'teloa.json',hash:createHash('sha256').update(bytes).digest('hex'),bytes}],createdAt:'2026-09-12T08:00:00.000Z',updatedAt:'2026-09-12T08:01:00.000Z'}

test('固定认证本人调用服务，并将字节编码为严格工作台回包',async()=>{
 const calls:unknown[][]=[],handler=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async(owner,input)=>{calls.push([owner,input]);return receipt}}))
 assert.deepEqual(await handler('market/github/resolve',request),{...receipt,ownerId:'self',files:[{path:'teloa.json',hash:receipt.files[0]!.hash,base64:'e30='}]})
 assert.deepEqual(calls,[['local:teloa-owner',request]])
})

test('未知字段和错误宿主回包在边界拒绝',async()=>{
 let calls=0
 const handler=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>{calls++;return receipt}}))
 await assert.rejects(handler('market/github/resolve',{...request,url:'https://github.com/teloa-ai/starter'}),{code:'teloa/invalid-input'});assert.equal(calls,0)
 const make=(value:unknown)=>createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>value}))
 await assert.rejects(make({...receipt,ownerId:'other'})('market/github/resolve',request),{code:'teloa/invalid-host-response'})
 await assert.rejects(make({...receipt,files:[{...receipt.files[0],hash:'b'.repeat(64)}]})('market/github/resolve',request),{code:'teloa/invalid-host-response'})
})

test('宿主入口初始化数据库并注册固定来源 RPC',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(source,/await initializeTeloaDatabase\(database\.pool[,)]/)
 assert.match(sequence,/await initializeGithubSources\(pool\)/)
 assert.match(source,/\.\.\.githubSourceEndpoints/)
 assert.match(source,/githubSourceHandler\(endpoint,payload\)/)
})

test('子目录请求透传 path，回包的 path 必须与请求一致',async()=>{
 const withPath={...request,path:'skills/pdf'},calls:unknown[]=[]
 const good=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async(_owner,input)=>{calls.push(input);return {...receipt,provenance:{...receipt.provenance,path:'skills/pdf'}}}}))
 const result=await good('market/github/resolve',withPath) as {provenance:{path?:string}}
 assert.equal(result.provenance.path,'skills/pdf');assert.deepEqual(calls,[withPath])
 const drifted=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>({...receipt,provenance:{...receipt.provenance,path:'skills/other'}})}))
 await assert.rejects(drifted('market/github/resolve',withPath),{code:'teloa/invalid-host-response'})
 const missing=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>receipt}))
 await assert.rejects(missing('market/github/resolve',withPath),{code:'teloa/invalid-host-response'})
 const extra=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>({...receipt,provenance:{...receipt.provenance,path:'x'}})}))
 await assert.rejects(extra('market/github/resolve',request),{code:'teloa/invalid-host-response'})
 for(const path of ['../x','/x','x/','a//b'])await assert.rejects(good('market/github/resolve',{...request,path}),{code:'teloa/invalid-input'})
})
