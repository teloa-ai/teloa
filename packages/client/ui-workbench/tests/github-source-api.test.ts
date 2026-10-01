import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createGithubSourceApi} from '../src/client/github-source-api.ts'

const requestId='11111111-1111-4111-8111-111111111111',commit='0123456789abcdef0123456789abcdef01234567',archiveHash='a'.repeat(64)
const input={owner:'teloa-ai',repo:'starter',ref:'main'},data=Buffer.from('{}'),fileHash=createHash('sha256').update(data).digest('hex')
const result={requestId,ownerId:'self',stage:'ready',provenance:{kind:'github',owner:input.owner,repo:input.repo,requestedRef:input.ref,resolvedCommit:commit,archiveHash},files:[{path:'teloa.json',hash:fileHash,base64:data.toString('base64')}],createdAt:'2026-09-12T08:00:00.000Z',updatedAt:'2026-09-12T08:01:00.000Z'}
const journal=()=>{let raw:string|null=null;return {port:{read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},raw:()=>raw}}

test('只调用固定 RPC，以 self 回执和原请求来源核对文件字节',async()=>{
 const saved=journal(),calls:unknown[]=[]
 const api=createGithubSourceApi(async(method,payload)=>{calls.push([method,payload,saved.raw()]);return result},saved.port,()=>requestId)
 const receipt=await api.resolve(input)
 assert.deepEqual(calls,[['market/github/resolve',{requestId,...input},JSON.stringify({schema:'teloa.github-source/v1',request:{requestId,...input}})]])
 assert.equal(receipt.ownerId,'self');assert.equal(receipt.files[0]?.path,'teloa.json');assert.deepEqual([...receipt.files[0]!.bytes],[123,125]);assert.equal(saved.raw(),null);assert.equal(api.pending(),undefined)
})

test('网络未知结果保留同一 requestId，重建客户端后恢复相同请求',async()=>{
 const saved=journal(),calls:unknown[]=[];let fail=true
 const call=async(method:string,payload:unknown)=>{calls.push([method,payload]);if(fail){fail=false;throw Error('断线')}return result}
 await assert.rejects(createGithubSourceApi(call,saved.port,()=>requestId).resolve(input),/断线/)
 const api=createGithubSourceApi(call,saved.port,()=>crypto.randomUUID());assert.deepEqual(api.pending(),{requestId,...input});assert.deepEqual((await api.recover()).provenance,result.provenance)
 assert.deepEqual(calls,[['market/github/resolve',{requestId,...input}],['market/github/resolve',{requestId,...input}]]);assert.equal(saved.raw(),null)
})

test('pending 存在时新来源不能覆盖，原来源继续使用固定请求',async()=>{
 const saved=journal();let calls=0
 const first=createGithubSourceApi(async()=>{calls++;throw Error('未知')},saved.port,()=>requestId);await assert.rejects(first.resolve(input))
 const api=createGithubSourceApi(async(_method,payload)=>{calls++;assert.deepEqual(payload,{requestId,...input});return result},saved.port,()=>crypto.randomUUID())
 await assert.rejects(api.resolve({...input,ref:'v2'}),/先恢复/);assert.equal(calls,1)
 assert.equal((await api.resolve(input)).requestId,requestId);assert.equal(calls,2)
})

test('坏回包、来源暂不可用和普通拒绝保留请求，只有明确无副作用拒绝释放',async()=>{
 for(const failure of [
  async()=>({...result,ownerId:'other'}),
  async()=>({...result,extra:true}),
  async()=>{throw Object.assign(Error('来源失败'),{rejected:true,code:'teloa/source-unavailable'})},
  async()=>{throw Object.assign(Error('存储失败'),{rejected:true,code:'teloa/storage-unavailable'})},
 ]){const saved=journal(),api=createGithubSourceApi(failure,saved.port,()=>requestId);await assert.rejects(api.resolve(input));assert.deepEqual(api.pending(),{requestId,...input});assert.ok(saved.raw())}
 for(const code of ['teloa/invalid-input','teloa/forbidden','teloa/conflict']){const saved=journal(),api=createGithubSourceApi(async()=>{throw Object.assign(Error('已拒绝'),{rejected:true,code})},saved.port,()=>requestId);await assert.rejects(api.resolve(input));assert.equal(api.pending(),undefined);assert.equal(saved.raw(),null)}
})

test('严格拒绝错误 provenance、文件、摘要、时间与重复路径',async()=>{
 const bad=[
  {...result,requestId:'22222222-2222-4222-8222-222222222222'},
  {...result,stage:'downloading'},
  {...result,provenance:{...result.provenance,requestedRef:'other'}},
  {...result,provenance:{...result.provenance,resolvedCommit:'abc'}},
  {...result,createdAt:'not-a-date'},
  {...result,updatedAt:'2026-09-12T07:00:00.000Z'},
  {...result,files:[{...result.files[0],path:'../teloa.json'}]},
  {...result,files:[{...result.files[0],hash:'b'.repeat(64)}]},
  {...result,files:[result.files[0],result.files[0]]},
  {...result,files:[{...result.files[0],extra:true}]},
 ]
 for(const value of bad){const saved=journal(),api=createGithubSourceApi(async()=>value,saved.port,()=>requestId);await assert.rejects(api.resolve(input),/格式|一致|摘要|时间|路径|重复/);assert.ok(api.pending())}
})

test('仓库名按契约共用规则：.github 与 -/_ 结尾可提交，.git 结尾拒绝',async()=>{
 for(const repo of ['.github','tools-','notes_']){
  const saved=journal(),calls:unknown[]=[],reply={...result,provenance:{...result.provenance,repo}}
  const receipt=await createGithubSourceApi(async(method,payload)=>{calls.push([method,payload]);return reply},saved.port,()=>requestId).resolve({...input,repo})
  assert.deepEqual(calls,[['market/github/resolve',{requestId,...input,repo}]]);assert.equal(receipt.provenance.repo,repo)
 }
 for(const repo of ['skills.git','SKILLS.GIT','..']){let calls=0;await assert.rejects(createGithubSourceApi(async()=>{calls++;return result},journal().port,()=>requestId).resolve({...input,repo}),/repo 标识不合法/);assert.equal(calls,0)}
})

test('输入和恢复日志只接受 owner/repo/ref，不保存 URL、token 或身份覆盖',async()=>{
 for(const value of [{...input,url:'https://evil.example/x.zip'},{...input,token:'secret'},{...input,ownerId:'other'},{...input,owner:'bad/name'},{...input,repo:'repo.git'},{...input,ref:'main..next'}]){let calls=0;const saved=journal();await assert.rejects(createGithubSourceApi(async()=>{calls++;return result},saved.port,()=>requestId).resolve(value),/格式|标识|ref/);assert.equal(calls,0);assert.equal(saved.raw(),null)}
 const damaged=createGithubSourceApi(async()=>result,{read:()=>JSON.stringify({schema:'teloa.github-source/v1',request:{requestId,...input,token:'secret'}}),write:()=>{},clear:()=>{}},()=>requestId)
 assert.equal(damaged.recoveryMessage()?.code,'teloa/storage-corrupt');await assert.rejects(damaged.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('日志写入失败不调用服务并释放 busy，非法新 requestId 不产生请求',async()=>{
 let calls=0,writes=0;const api=createGithubSourceApi(async()=>{calls++;return result},{read:()=>null,write:()=>{if(!writes++)throw Error('写入失败')},clear:()=>{}},()=>requestId)
 await assert.rejects(api.resolve(input),/写入失败/);assert.equal(calls,0);assert.equal((await api.recover()).requestId,requestId);assert.equal(calls,1)
 await assert.rejects(createGithubSourceApi(async()=>{calls++;return result},undefined,()=> 'bad').resolve(input),/requestId/);assert.equal(calls,1)
})

test('子目录请求带 path，回执 path 必须与请求一致，恢复记录保留 path',async()=>{
 const withPath={...input,path:'skills/pdf'},saved=journal(),calls:unknown[]=[]
 const good=createGithubSourceApi(async(method,payload)=>{calls.push([method,payload]);return {...result,provenance:{...result.provenance,path:'skills/pdf'}}},saved.port,()=>requestId)
 const receipt=await good.resolve(withPath)
 assert.deepEqual(calls,[['market/github/resolve',{requestId,...withPath}]]);assert.equal(receipt.provenance.path,'skills/pdf')
 const drift=createGithubSourceApi(async()=>({...result,provenance:{...result.provenance,path:'skills/other'}}),journal().port,()=>requestId)
 await assert.rejects(drift.resolve(withPath),/GitHub/)
 const missing=createGithubSourceApi(async()=>result,journal().port,()=>requestId)
 await assert.rejects(missing.resolve(withPath),/GitHub/)
 for(const path of ['../x','/x','x/','a//b'])await assert.rejects(createGithubSourceApi(async()=>result,journal().port,()=>requestId).resolve({...input,path}))
 const pendingJournal=journal()
 await assert.rejects(createGithubSourceApi(async()=>{throw Error('断线')},pendingJournal.port,()=>requestId).resolve(withPath))
 assert.deepEqual(createGithubSourceApi(async()=>result,pendingJournal.port,()=>crypto.randomUUID()).pending(),{requestId,...withPath})
})
