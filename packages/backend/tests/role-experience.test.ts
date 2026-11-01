import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {existsSync} from 'node:fs'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {RunRoleMemory} from '../src/work/role-memory.ts'
import type {MemoryProvider,ExperienceDocument,ExperienceFact,MemoryOperationState} from '../src/work/hindsight-memory.ts'
import {initializeRoleExperience,RoleExperienceService} from '../src/work/role-experience.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 const socket=join(homedir(),'.orbstack/run/docker.sock')
 if(!process.env.DOCKER_HOST&&existsSync(socket)){
  process.env.DOCKER_HOST='unix://'+socket
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE??='/var/run/docker.sock'
 }
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoleExperience(pool)
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop()})
function memory(text:string):RunRoleMemory{return {id:randomUUID(),version:1,title:'经验',markdown:text,contentHash:createHash('sha256').update(text).digest('hex'),source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['general']}}}
class Provider implements MemoryProvider{
 banks=new Map<string,ExperienceDocument[]>();calls:string[]=[];operations:string[]=[];status:MemoryOperationState='completed';fail=false;afterRecall=()=>{};facts?:ExperienceFact[]
 async retain(bank:string,op:string,documents:ExperienceDocument[],_signal:AbortSignal){this.calls.push(bank);this.operations.push(op);this.banks.set(bank,documents)}
 async operation(){return this.status}
 async recall(bank:string){if(this.fail)throw Error('unavailable');this.afterRecall();const doc=this.banks.get(bank)![0]!;return this.facts??[{id:'fact',text:'应先验证来源',type:'experience' as const,documentId:doc.documentId,sourceFactIds:[]}]}
}
function fixture(){
 const provider=new Provider(),owner=randomUUID(),roleId=randomUUID(),options={providerKey:'local-test',timeoutMs:1000}
 let memories=[memory('先验证来源')]
 const input={ownerId:owner,roleId,roleVersion:1,scope:'general',query:'如何处理？',load:async()=>memories}
 return {provider,input,service:new RoleExperienceService(pool,provider,options),options,set:(value:RunRoleMemory[])=>{memories=value}}
}

test('索引异步回执持久化，冷恢复和并发读取不重复提交',async()=>{
 const f=fixture()
 const first=await f.service.read(f.input)
 assert.equal(first.mode,'confirmed')
 assert.doesNotMatch(JSON.parse(first.text).notice,/\p{Script=Han}/u)
 const current=await Promise.all([f.service.read(f.input),new RoleExperienceService(pool,f.provider,f.options).read(f.input)])
 assert.ok(current.every(result=>result.mode==='recalled'))
 assert.equal(f.provider.calls.length,1)
 assert.equal(current[0]!.sources[0]!.id,f.input? (await f.input.load())[0]!.id:'')
})

test('来源集合、版本、本人、岗位与范围分别隔离；撤回后不用旧 bank',async()=>{
 const f=fixture();await f.service.read(f.input);await f.service.read(f.input)
 const first=f.provider.calls[0]!
 f.set([memory('修正后的方法')]);await f.service.read(f.input)
 assert.notEqual(f.provider.calls.at(-1),first)
 for(const change of [{ownerId:randomUUID()},{roleId:randomUUID()},{roleVersion:2},{scope:'other'}]){
  const result=await f.service.read({...f.input,...change})
  assert.equal(result.mode,'confirmed');assert.notEqual(f.provider.calls.at(-1),first)
 }
 assert.equal(new Set(f.provider.calls).size,6)
 f.set([]);const result=await f.service.read(f.input)
 assert.equal(result.text,'');assert.equal(result.sources.length,0)
})

test('丢回执重用同一操作；明确失败限频重试，跨重启保留次数',async()=>{
 const f=fixture();await f.service.read(f.input)
 f.provider.status='not_found';await f.service.read(f.input)
 assert.equal(f.provider.operations[0],f.provider.operations[1])
 f.provider.status='failed';await f.service.read(f.input);await f.service.read(f.input)
 assert.equal(f.provider.calls.length,2)
 const bank=f.provider.calls[0]!
 for(let attempt=2;attempt<=3;attempt++){
  await pool.query("update teloa_role_experience_indexes set retry_after=now()-interval '1 second' where bank_id=$1",[bank])
  await new RoleExperienceService(pool,f.provider,f.options).read(f.input)
  assert.equal(f.provider.calls.length,attempt+1)
  assert.notEqual(f.provider.operations.at(-1),f.provider.operations.at(-2))
 }
 await pool.query("update teloa_role_experience_indexes set retry_after=now()-interval '1 second' where bank_id=$1",[bank])
 await f.service.read(f.input);assert.equal(f.provider.calls.length,4)
 f.provider.status='completed';assert.equal((await f.service.read(f.input)).mode,'recalled')
})

test('退化上下文的 JSON 转义和来源也计入总预算',async()=>{
 const f=fixture();f.set(Array.from({length:30},()=>memory('\u0001'.repeat(2000))))
 const result=await f.service.read(f.input)
 assert.ok(result.text.length<=24000);assert.ok(result.sources.length>0)
 assert.doesNotThrow(()=>JSON.parse(result.text))
})

test('合法确认历史超过索引预算，保留直接正文且不阻断任务',async()=>{
 const f=fixture();f.set(Array.from({length:513},()=>memory('当前可用小结')))
 const result=await f.service.read(f.input)
 assert.equal(result.mode,'confirmed');assert.equal(result.sources.length,30);assert.equal(f.provider.calls.length,0)
})

test('Recall 期间来源变化或服务失败，只返回重新核验后的当前正文',async()=>{
 const f=fixture();await f.service.read(f.input)
 f.provider.afterRecall=()=>f.set([])
 assert.equal((await f.service.read(f.input)).text,'')
 f.set([memory('当前有效经验')]);f.provider.afterRecall=()=>{};await f.service.read(f.input)
 f.provider.fail=true
 const result=await f.service.read(f.input)
 assert.equal(result.mode,'confirmed');assert.match(result.text,/当前有效经验/)
})

test('全部历史参与索引；退化正文受窗口限制，派生经验保留来源清单',async()=>{
 const f=fixture();f.set(Array.from({length:45},(_,index)=>memory('历史经验 '+index)))
 const first=await f.service.read(f.input)
 assert.equal([...f.provider.banks.values()][0]!.length,45)
 assert.equal(first.sources.length,30)
 f.provider.facts=[{id:'observation',text:'历史中常见的检查顺序',type:'observation',sourceFactIds:[]}]
 const next=await f.service.read(f.input)
 assert.equal(next.mode,'recalled');assert.equal(next.sources.length,45)
 assert.match(JSON.parse(next.text).notice,/inferences/);assert.match(next.text,/derived from the current authorized snapshot/);assert.match(next.text,/历史中常见的检查顺序/)
})

test('不认识的事实文档不能混入；取消和错误正文摘要被拒绝',async()=>{
 const f=fixture();await f.service.read(f.input)
 f.provider.facts=[{id:'foreign',text:'其他岗位秘密',type:'world',documentId:'other',sourceFactIds:[]}]
 const result=await f.service.read(f.input)
 assert.doesNotMatch(result.text,/其他岗位秘密/)
 const abort=new AbortController();abort.abort()
 await assert.rejects(f.service.read({...f.input,signal:abort.signal}))
 const broken=memory('经验');broken.contentHash='0'.repeat(64);f.set([broken])
 await assert.rejects(f.service.read(f.input))
})


async function artifactExperience(){
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 const f=fixture(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'original-v1',title:'经验来源合成成果'}
 const artifacts=new ArtifactService(pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>({source,sessionIds:[source.id]}))
 const artifact=await artifacts.create(f.input.ownerId,{requestId:randomUUID(),source,content:{title:'合成经验成果',sections:[{id:'body',title:'正文',text:'本轮仅供本地模拟的合成经验'}],snapshotIds:[],note:'原件'}})
 const row=memory('本轮仅供本地模拟的合成经验');row.source={kind:'artifact',id:artifact.artifactId,version:1};f.set([row])
 const withdraw=()=>artifacts.withdraw(f.input.ownerId,{requestId:randomUUID(),artifactId:artifact.artifactId,expectedVersion:1,source})
 return {...f,withdraw}
}
test('来源快照读取后撤回，三个外部retain分支都不得发送旧正文',async()=>{
 for(const branch of ['initial','not_found','retry_failed']){
  const f=await artifactExperience(),load=f.input.load
  if(branch!=='initial')await f.service.read(f.input)
  const calls=f.provider.calls.length
  if(branch==='initial'){
   let first=true;f.input.load=async()=>{const rows=await load();if(first){first=false;await f.withdraw()}return rows}
  }else{
   f.provider.status=branch==='not_found'?'not_found':'failed'
   if(branch==='retry_failed')await pool.query("update teloa_role_experience_indexes set retry_after=now()-interval '1 second' where owner_id=$1",[f.input.ownerId])
   f.provider.operation=async()=>{await f.withdraw();return f.provider.status}
  }
  await assert.rejects(f.service.read(f.input),{code:'teloa/source-unavailable'})
  assert.equal(f.provider.calls.length,calls,branch+'不得在撤回提交后调用retain')
 }
})
test('外部retain已准入则撤回等回执结束，不能在实际发送期间越过来源锁',async()=>{
 const f=await artifactExperience();let entered!:()=>void,release!:()=>void
 const ready=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve)
 f.provider.retain=async(bank,op,documents)=>{f.provider.calls.push(bank);f.provider.operations.push(op);f.provider.banks.set(bank,documents);entered();await hold}
 const reading=f.service.read(f.input);await ready
 let withdrawn=false;const withdrawal=f.withdraw().then(()=>{withdrawn=true})
 try{await new Promise(resolve=>setTimeout(resolve,60));assert.equal(withdrawn,false,'已准入的外发结束前撤回不能提交')}
 finally{release();await reading;await withdrawal}
 assert.equal(withdrawn,true);assert.equal(f.provider.calls.length,1)
})

test('已索引经验在recall前撤回，同样不调用外部召回',async()=>{
 const f=await artifactExperience();await f.service.read(f.input);await f.service.read(f.input)
 let calls=0;const recall=f.provider.recall.bind(f.provider),load=f.input.load
 f.provider.recall=async bank=>{calls++;return recall(bank)}
 let first=true;f.input.load=async()=>{const rows=await load();if(first){first=false;await f.withdraw()}return rows}
 await assert.rejects(f.service.read(f.input),{code:'teloa/source-unavailable'})
 assert.equal(calls,0)
})
test('取消外部retain会释放准入连接，原撤回继续提交',async()=>{
 const f=await artifactExperience(),abort=new AbortController();let entered!:()=>void
 const ready=new Promise<void>(resolve=>entered=resolve)
 f.provider.retain=async(_bank,_op,_documents,signal)=>{entered();await new Promise<void>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}
 const reading=f.service.read({...f.input,signal:abort.signal});await ready
 let withdrawn=false;const withdrawal=f.withdraw().then(()=>{withdrawn=true})
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(withdrawn,false)
 abort.abort(new Error('本人取消本轮读取'))
 await assert.rejects(reading,/本人取消本轮读取/);await withdrawal
 assert.equal(withdrawn,true)
})
