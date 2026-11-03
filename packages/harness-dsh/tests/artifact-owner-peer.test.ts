import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {ArtifactService,ArtifactSnapshotStore,openResourceDatabase} from '@teloa/backend'
import {host,type RpcReply} from './fixtures/production-host.ts'
import {apply} from '../src/index.ts'

test('真实/teloa RPC：成果审计与撤回仅可信browser peer，payload不能伪造；本人原件/历史导出保留',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-artifact-owner-peer-')),runtime=host(),previousRoot=process.env.TELOA_PROJECT_ROOT,owner='local:teloa-owner'
 let container:Awaited<ReturnType<InstanceType<typeof PostgreSqlContainer>['start']>>|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{await runtime.ctx.fiber.dispose();await database?.close();await container?.stop();if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot;await rm(root,{recursive:true,force:true})})
 process.env.TELOA_PROJECT_ROOT=process.cwd();process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const runtimeRoot=join(root,'.runtime/teloa'),config=join(runtimeRoot,'database.json')
 await mkdir(join(runtimeRoot,'skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 await runtime.ready(join(root,'.runtime/dsh'));await apply(runtime.ctx,{projectRoot:root})
 const browserPeer={id:'trusted-owner-browser'},foreignPeer={id:'sdk-or-agent'},rpc=runtime.rpc as (endpoint:string,payload:unknown,signal:AbortSignal,peer?:unknown)=>Promise<RpcReply>;Reflect.set(runtime.ctx.connection,'browserPeer',browserPeer)
 const source={kind:'session' as const,id:randomUUID(),scope:'general',version:'synthetic-fixed-source',title:'本轮合成来源'},identity={id:randomUUID,now:()=>new Date().toISOString()},artifacts=new ArtifactService(database.pool,identity,async()=>({source,sessionIds:[source.id]})),bytes=Buffer.from('synthetic-owner-audit-original')
 const snapshotId=await new ArtifactSnapshotStore(database.pool).save(owner,{schema:'teloa.file-snapshot/v1',sessionId:source.id,id:'a'.repeat(64),path:'synthetic.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),capturedAt:identity.now(),contentBase64:bytes.toString('base64')})
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'本轮审计原件',sections:[{id:'body',title:'正文',text:'合成正文'}],snapshotIds:[snapshotId],note:'不可变原件'}}),withdraw={requestId:randomUUID(),artifactId:artifact.artifactId,expectedVersion:1,source}
 const before=(await database.pool.query('select * from teloa_artifact_versions where owner_id=$1',[owner])).rows
 const active=await rpc('artifacts/versions',{artifactId:artifact.artifactId},AbortSignal.timeout(10000),browserPeer);assert.equal(active.ok,true)
 for(const peer of [foreignPeer,{},undefined]){
  const read=await rpc('artifacts/versions',{artifactId:artifact.artifactId},AbortSignal.timeout(10000),peer);assert.equal(read.error?.code,'teloa/forbidden','active个人审计RPC不属于公开App/Agent接口')
  const forged=await rpc('artifacts/withdraw',{...withdraw,kind:'human',browserOwner:true,peer:browserPeer},AbortSignal.timeout(10000),peer);assert.equal(forged.error?.code,'teloa/forbidden','payload不能伪造宿主peer')
 }
 assert.equal((await database.pool.query('select count(*)::int count from teloa_artifact_withdrawals')).rows[0].count,0)
 const saved=await rpc('artifacts/withdraw',withdraw,AbortSignal.timeout(10000),browserPeer);assert.equal(saved.ok,true);assert.deepEqual(await rpc('artifacts/withdraw',withdraw,AbortSignal.timeout(10000),browserPeer),saved)
 const status=await rpc('artifacts/availability',{artifactId:artifact.artifactId},AbortSignal.timeout(10000),browserPeer);assert.equal(status.ok,true);assert.equal(Reflect.get(status.value as object,'state'),'withdrawn')
 const versions=await rpc('artifacts/versions',{artifactId:artifact.artifactId},AbortSignal.timeout(10000),browserPeer),file=await rpc('artifacts/snapshot',{snapshotId},AbortSignal.timeout(10000),browserPeer)
 assert.equal(versions.ok,true);assert.deepEqual(versions.value,[artifact]);assert.equal(file.ok,true);assert.equal(Reflect.get(file.value as object,'contentBase64'),bytes.toString('base64'))
 for(const endpoint of ['artifacts/versions','artifacts/snapshot','artifacts/availability'])assert.equal((await rpc(endpoint,endpoint==='artifacts/snapshot'?{snapshotId}:{artifactId:artifact.artifactId},AbortSignal.timeout(10000),foreignPeer)).error?.code,'teloa/forbidden')
 assert.deepEqual((await database.pool.query('select * from teloa_artifact_versions where owner_id=$1',[owner])).rows,before)
 await assert.rejects(runtime.ctx.teloaWork.invoke('artifacts/withdraw',withdraw,new AbortController().signal),{code:'teloa/forbidden'})
 assert.deepEqual(runtime.modelCalls,[])
})
