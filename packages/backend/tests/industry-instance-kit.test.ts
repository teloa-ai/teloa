import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {IndustryLoadService,createIndustryInstanceKit,industryPredicates,initializeIndustryLoads,type IndustryInstanceStored,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool)
 await pool.query(`
  create table if not exists teloa_kit_probe_instances(
   id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
   content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
   state text not null check(state in ('pending','ready')),revision integer not null check(revision>=1),token text,
   mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,load_id,item_instance_id)
  );
  create table if not exists teloa_kit_probe_create_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_kit_probe_instances(id),primary key(owner_id,request_id)
  );
  create table if not exists teloa_kit_probe_advance_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_kit_probe_instances(id),result_revision integer not null check(result_revision>=2),primary key(owner_id,request_id)
  );
 `)
})
after(async()=>{await pool?.end();await container?.stop()})

const contentId=randomUUID(),contentHash='b'.repeat(64)
const snapshot={templateId:'probe',templateVersion:'1.0.0',title:'骨架探针',domain:'SOC',description:'骨架探针模板',resources:[{localId:'probe-source',kind:'data-source' as const,title:'探针来源',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:[]}
const loadSource:IndustryLoadSource={read:async()=>structuredClone(snapshot)}

type ProbeSnapshot={token:string}
type ProbeStored=IndustryInstanceStored&{state:'pending'|'ready';token:string|null}
type ProbeInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;state:'pending'|'ready';revision:number;token:string|null;createdAt:string;updatedAt:string;drift?:true}

const invalid=()=>new WorkError('teloa/invalid-input','骨架探针请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','骨架探针记录损坏，已停止读取。')

const buildKit=(loads:IndustryLoadService,identity:{id:()=>string;now:()=>string},token:(itemInstanceId:string)=>string,sameSource=(value:ProbeStored,fixed:ProbeSnapshot)=>value.token===fixed.token,sourceRequired=(value:ProbeStored)=>value.state==='ready')=>createIndustryInstanceKit<ProbeStored,ProbeInstance,ProbeSnapshot>({
 kind:'data-source',table:'teloa_kit_probe_instances',createRequests:'teloa_kit_probe_create_requests',advanceRequests:'teloa_kit_probe_advance_requests',
 lockPrefix:'kit-probe',advanceName:'settle',initialState:'pending',states:['pending','ready'],hidden:['mappingDigest'],
 messages:{forbidden:'骨架探针实例不存在或不属于当前本人。',conflictCreate:'同一请求不能实例化不同的骨架探针。',notInstantiable:'目标不是可实例化的骨架探针。',conflictAdvance:'同一请求不能推进不同的骨架探针。',versionConflict:'骨架探针状态已变化，请刷新后重试。',drift:'骨架探针固定来源已变化。'},
 invalid,corrupt,
 readExtra:row=>({token:row.token===null?null:String(row.token)}),
 checkExtra:(value,initialState)=>value.state===initialState?value.token===null&&value.revision===1:typeof value.token==='string',
 sourceRequired,
 sameSource,
 advanced:state=>state==='ready',
},{pool,identity,loads,source:{read:async(_db,_owner,input)=>({token:token(input.itemInstanceId)})}})

const create=async(owner:string,identity:{id:()=>string;now:()=>string})=>{
 const loads=new IndustryLoadService(pool,identity,loadSource)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 return {loads,load}
}

test('公共骨架完成登记、读取、列表与推进并保持回执幂等',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'fixed-token')
 const instantiate=(input:unknown)=>kit.instantiate(owner,input,{columns:()=>({token:null})})
 const settle=(input:unknown)=>kit.advance<ProbeSnapshot,string>(owner,input,null,{
  preview:async(db,current)=>({token:current.token??'fixed-token'}),
  probe:async preview=>preview.token,
  write:async(db,context)=>(await db.query("update teloa_kit_probe_instances set state='ready',revision=revision+1,token=$3,updated_at=$4 where id=$1 and owner_id=$2 and state='pending' and revision=$5 returning *",[context.instanceId,owner,context.probe,context.now(),context.expectedRevision])).rows[0],
 })
 const requestId=randomUUID(),input={requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 const first=await instantiate(input)
 assert.deepEqual(await instantiate(input),first)
 assert.equal(first.state,'pending');assert.equal(first.revision,1);assert.equal(first.token,null);assert.equal(first.scope,load.space.scope)
 assert.ok(!('mappingDigest' in first))
 assert.deepEqual(await kit.get(owner,{instanceId:first.id}),first)
 assert.deepEqual((await kit.list(owner,{})).items,[first])
 const advanceId=randomUUID(),advanceInput={requestId:advanceId,instanceId:first.id,expectedRevision:1}
 const ready=await settle(advanceInput)
 assert.equal(ready.state,'ready');assert.equal(ready.revision,2);assert.equal(ready.token,'fixed-token')
 assert.deepEqual(await settle(advanceInput),ready)
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_advance_requests where owner_id=$1',[owner])).rows[0].count,1)
 await assert.rejects(settle({requestId:randomUUID(),instanceId:first.id,expectedRevision:1}),(error:WorkError)=>error.code==='teloa/version-conflict')
})

test('公共骨架在并发推进下只让一方写入，另一方得到版本冲突',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'race-token')
 const instance=await kit.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})})
 const settle=(requestId:string)=>kit.advance<string,string>(owner,{requestId,instanceId:instance.id,expectedRevision:1},null,{
  preview:async()=>'race-token',
  probe:async preview=>preview,
  write:async(db,context)=>(await db.query("update teloa_kit_probe_instances set state='ready',revision=revision+1,token=$3,updated_at=$4 where id=$1 and owner_id=$2 and state='pending' and revision=$5 returning *",[context.instanceId,owner,context.probe,context.now(),context.expectedRevision])).rows[0],
 })
 const results=await Promise.allSettled([settle(randomUUID()),settle(randomUUID())])
 assert.equal(results.filter(value=>value.status==='fulfilled').length,1)
 const failed=results.find(value=>value.status==='rejected')
 assert.ok(failed&&failed.status==='rejected'&&(failed.reason as WorkError).code==='teloa/version-conflict')
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_advance_requests where owner_id=$1',[owner])).rows[0].count,1)
 assert.equal((await pool.query('select revision from teloa_kit_probe_instances where id=$1',[instance.id])).rows[0].revision,2)
})

test('公共骨架在就绪核验失败时不写状态也不写回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'never')
 const instance=await kit.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})})
 await assert.rejects(kit.advance<string,string>(owner,{requestId:randomUUID(),instanceId:instance.id,expectedRevision:1},null,{
  preview:async()=>'never',
  probe:async()=>{throw new WorkError('teloa/dependency-unavailable','骨架探针尚未就绪。')},
  write:async()=>{throw Error('不应写入')},
 }),(error:WorkError)=>error.code==='teloa/dependency-unavailable')
 const stored=(await pool.query('select state,revision,token from teloa_kit_probe_instances where id=$1',[instance.id])).rows[0]
 assert.deepEqual(stored,{state:'pending',revision:1,token:null})
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_advance_requests where owner_id=$1',[owner])).rows[0].count,0)
})

test('登记的事务内预检可否决，columns 钩子能给出动态初始状态',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'carried-token')
 let previewed=0
 const instantiate=(requestId:string,reject:boolean)=>kit.instantiate(owner,{requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{
  preview:async(db,context)=>{previewed+=1;if(reject)throw new WorkError('teloa/invalid-input','骨架探针预检否决。');return (await db.query('select $1::text token',[context.load.domain])).rows[0].token as string},
  columns:async preview=>({token:'carried-token',state:preview==='SOC'?'ready':'pending'}),
 })
 await assert.rejects(instantiate(randomUUID(),true),(error:WorkError)=>error.code==='teloa/invalid-input')
 assert.equal(previewed,1)
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_instances where owner_id=$1',[owner])).rows[0].count,0)
 const created=await instantiate(randomUUID(),false)
 assert.equal(created.state,'ready');assert.equal(created.revision,1);assert.equal(created.token,'carried-token')
 assert.deepEqual((await kit.list(owner,{})).items,[created])
})

test('来源漂移时读取投影为初始态并标记 drift，写路径仍判定来源不可用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'drift-token')
 const instance=await kit.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})})
 const advance=(target:ReturnType<typeof buildKit>,requestId:string)=>target.advance<string,string>(owner,{requestId,instanceId:instance.id,expectedRevision:1},null,{
  preview:async()=>'drift-token',probe:async preview=>preview,
  write:async(db,context)=>(await db.query("update teloa_kit_probe_instances set state='ready',revision=revision+1,token=$3,updated_at=$4 where id=$1 and owner_id=$2 and state='pending' and revision=$5 returning *",[context.instanceId,owner,context.probe,context.now(),context.expectedRevision])).rows[0],
 })
 const settled=await advance(kit,randomUUID())
 assert.equal(settled.state,'ready');assert.ok(!('drift' in settled))
 // 同一条记录换成一个永远判定来源已变化的骨架：读取与列表回落为初始态并带 drift，登记这条写路径仍收敛为来源不可用。
 const drifted=buildKit(loads,identity,()=>'drift-token',()=>false)
 const projected=await drifted.get(owner,{instanceId:instance.id})
 assert.equal(projected.state,'pending');assert.equal(projected.drift,true);assert.equal(projected.token,'drift-token');assert.equal(projected.revision,2)
 assert.deepEqual(await drifted.list(owner,{}),{items:[projected]})
 await assert.rejects(drifted.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})}),(error:WorkError)=>error.code==='teloa/source-unavailable')
 const stored=(await pool.query('select state,revision,token from teloa_kit_probe_instances where id=$1',[instance.id])).rows[0]
 assert.deepEqual(stored,{state:'ready',revision:2,token:'drift-token'})
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_advance_requests where owner_id=$1',[owner])).rows[0].count,1)
})

test('初始态记录漂移时推进被拒，不写状态也不写回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 // 恒回读固定来源的骨架（对应插件）：初始态本身也会漂移，推进的事务内预检必须先于钩子拒绝。
 const kit=buildKit(loads,identity,()=>'initial-token',()=>false,()=>true)
 const fresh=buildKit(loads,identity,()=>'initial-token',()=>true,()=>true)
 const created=await fresh.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})})
 const requestId=randomUUID()
 await assert.rejects(kit.advance<string,string>(owner,{requestId,instanceId:created.id,expectedRevision:1},null,{
  preview:async()=>{throw Error('不应进入预检钩子')},probe:async()=>{throw Error('不应就绪核验')},write:async()=>{throw Error('不应写入')},
 }),(error:WorkError)=>error.code==='teloa/source-unavailable')
 const stored=(await pool.query('select state,revision,token from teloa_kit_probe_instances where id=$1',[created.id])).rows[0]
 assert.deepEqual(stored,{state:'pending',revision:1,token:null})
 assert.equal((await pool.query('select count(*)::int count from teloa_kit_probe_advance_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
 const projected=await kit.get(owner,{instanceId:created.id})
 assert.equal(projected.state,'pending');assert.equal(projected.drift,true)
})

test('目录逐行容错：损坏行只进 errors，不遮蔽其余行',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},{loads,load}=await create(owner,identity)
 const kit=buildKit(loads,identity,()=>'listing-token')
 const first=await kit.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId},{columns:()=>({token:null})})
 const second=await create(owner,identity)
 const other=buildKit(second.loads,identity,()=>'listing-token')
 const good=await other.instantiate(owner,{requestId:randomUUID(),loadId:second.load.id,itemInstanceId:second.load.items[0]!.instanceId},{columns:()=>({token:null})})
 // 只破坏第一行的冻结映射：整份目录仍应返回第二行，第一行收敛为一条 storage-corrupt。
 await pool.query('update teloa_kit_probe_instances set item_local_id=$2 where id=$1',[first.id,'tampered'])
 const page=await other.list(owner,{})
 assert.deepEqual(page.items,[good])
 assert.deepEqual(page.errors,[{instanceId:first.id,code:'teloa/storage-corrupt'}])
 await assert.rejects(other.get(owner,{instanceId:first.id}),(error:WorkError)=>error.code==='teloa/storage-corrupt')
})

test('目录逐行容错：来源读不出的行与损坏行各记一条，漂移行仍留在 items',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 const spaces=[await create(owner,identity),await create(owner,identity),await create(owner,identity),await create(owner,identity)]
 const rows:Awaited<ReturnType<ReturnType<typeof buildKit>['instantiate']>>[]=[]
 let failing=false
 // 四行分别扮演：正常、来源已变化、来源读不出来、记录损坏；前三种都要真的走一遍固定来源回读。
 const kit=buildKit(spaces[0]!.loads,identity,itemInstanceId=>{
  if(!failing)return 'steady'
  if(itemInstanceId===rows[1]!.itemInstanceId)return 'moved'
  if(itemInstanceId===rows[2]!.itemInstanceId)throw new WorkError('teloa/source-unavailable','骨架探针固定来源暂时不可读。')
  return 'steady'
 })
 for(const space of spaces){
  const created=await kit.instantiate(owner,{requestId:randomUUID(),loadId:space.load.id,itemInstanceId:space.load.items[0]!.instanceId},{columns:()=>({token:null})})
  rows.push(await kit.advance<string,string>(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},null,{
   preview:async()=>'steady',probe:async preview=>preview,
   write:async(db,context)=>(await db.query("update teloa_kit_probe_instances set state='ready',revision=revision+1,token=$3,updated_at=$4 where id=$1 and owner_id=$2 and state='pending' and revision=$5 returning *",[context.instanceId,owner,context.probe,context.now(),context.expectedRevision])).rows[0]}))
 }
 failing=true
 await pool.query('update teloa_kit_probe_instances set item_local_id=$2 where id=$1',[rows[3]!.id,'tampered'])
 const page=await kit.list(owner,{}),items=new Map(page.items.map(item=>[item.id,item]))
 assert.equal(page.items.length,2)
 assert.deepEqual(items.get(rows[0]!.id),rows[0])
 assert.deepEqual(items.get(rows[1]!.id),{...rows[1],state:'pending',drift:true})
 const sorted=(value:readonly {instanceId:string;code:string}[])=>[...value].sort((left,right)=>left.instanceId<right.instanceId?-1:1)
 assert.deepEqual(sorted(page.errors!),sorted([{instanceId:rows[2]!.id,code:'teloa/source-unavailable'},{instanceId:rows[3]!.id,code:'teloa/storage-corrupt'}]))
 await assert.rejects(kit.get(owner,{instanceId:rows[2]!.id}),(error:WorkError)=>error.code==='teloa/source-unavailable')
 assert.equal((await pool.query("select count(*)::int count from teloa_kit_probe_instances where owner_id=$1 and state='ready'",[owner])).rows[0].count,4)
})

test('公共骨架谓词与旧实现向量一致',async()=>{
 const value={id:randomUUID().toUpperCase(),ownerId:randomUUID(),loadId:randomUUID().toUpperCase(),itemInstanceId:randomUUID().toUpperCase(),itemLocalId:'probe-source',contentId:randomUUID().toUpperCase(),contentHash:'c'.repeat(64),itemVersion:'1.2.3',scope:'space-'+randomUUID()}
 const legacy=createHash('sha256').update(JSON.stringify([value.id.toLowerCase(),value.ownerId,value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.scope])).digest('hex')
 assert.equal(industryPredicates.mapping(value),legacy)
 assert.ok(industryPredicates.uuid(value.id)&&industryPredicates.hash(value.contentHash)&&industryPredicates.stableId(value.itemLocalId)&&industryPredicates.semver(value.itemVersion))
 assert.ok(industryPredicates.positive(1)&&!industryPredicates.positive(0)&&!industryPredicates.positive(1.5))
 assert.ok(industryPredicates.same({a:1},{a:1})&&!industryPredicates.same({a:1},{a:2}))
 assert.equal(industryPredicates.stamp(new Date('2026-09-14T00:00:00.000Z'),corrupt),'2026-09-14T00:00:00.000Z')
 assert.throws(()=>industryPredicates.stamp('2026-09-14',corrupt),(error:WorkError)=>error.code==='teloa/storage-corrupt')
 assert.deepEqual(industryPredicates.exact({a:1},['a','b'],invalid),{a:1})
 assert.throws(()=>industryPredicates.exact({a:1,z:2},['a'],invalid),(error:WorkError)=>error.code==='teloa/invalid-input')
})
