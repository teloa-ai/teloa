import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessDataService,businessObjectSnapshotHash,initializeBusinessData,readBusinessObjectSnapshot,type BusinessDataQuery,type BusinessDataSourcePort} from '../src/work/business-data.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeBusinessData(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

const alert={scope:'SOC',type:'alert',id:'evt-1842',version:1,title:'prod-03 异常脚本与外联',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete',summary:'需要关联账号与维护窗口后调查。',fields:[{label:'资产',value:'prod-03'},{label:'责任人',value:'生产运维组'}]}
const page=(items:unknown[]=[alert])=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:'2026-09-12T01:00:02.000Z',items,nextCursor:'page-2'})
function source(read:(input:BusinessDataQuery,signal?:AbortSignal)=>Promise<unknown>):BusinessDataSourcePort{return {id:'security-alert-http',scopes:['SOC'],query:read}}

test('真实来源查询保留筛选、分页与不可变快照，重复读取不重复落库',async()=>{
 const owner=randomUUID(),calls:BusinessDataQuery[]=[],service=new BusinessDataService(pool,source(async input=>{calls.push(input);return page()})),input={scope:'SOC',text:'prod-03',source:'EDR',quality:'complete',observedAfter:'2026-09-12T00:30:00.000Z',limit:20,cursor:'page-1'}
 const first=await service.query({ownerId:owner,scopeIds:['SOC']},input),second=await service.query({ownerId:owner,scopeIds:['SOC']},input)
 assert.deepEqual(calls,[input,input]);assert.deepEqual(second,first);assert.equal(first.schema,'teloa.business-data-page/v1');assert.equal(first.nextCursor,'page-2');assert.match(first.items[0]!.snapshotHash,/^[a-f0-9]{64}$/)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].n,1)
 const stored=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].snapshot
 assert.deepEqual(stored,alert)
})

test('同一对象版本内容变化被拒绝，固定快照不被覆盖',async()=>{
 const owner=randomUUID(),service=new BusinessDataService(pool,source(async()=>page()))
 await service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10})
 const changed=new BusinessDataService(pool,source(async()=>page([{...alert,summary:'来源悄悄改写了同一版本。'}])))
 await assert.rejects(changed.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),{code:'teloa/source-conflict'})
 assert.equal((await pool.query('select snapshot->>\'summary\' summary from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].summary,alert.summary)
})

test('既有快照损坏不会被同版本来源结果掩盖',async()=>{
 const owner=randomUUID(),service=new BusinessDataService(pool,source(async()=>page()))
 await service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10})
 await pool.query("update teloa_business_object_snapshots set snapshot=jsonb_set(snapshot,'{scope}',to_jsonb('AppSec'::text)) where owner_id=$1",[owner])
 await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),{code:'teloa/storage-corrupt'})
})

test('本人范围与来源范围在调用外部来源前过闸，不同本人快照隔离',async()=>{
 let calls=0;const port=source(async()=>{calls++;return page()}),service=new BusinessDataService(pool,port),owner=randomUUID()
 await assert.rejects(service.query({ownerId:owner,scopeIds:['AppSec']},{scope:'SOC',limit:10}),{code:'teloa/forbidden'});assert.equal(calls,0)
 await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},{scope:'AppSec',limit:10}),{code:'teloa/forbidden'});assert.equal(calls,0)
 await service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10})
 await service.query({ownerId:randomUUID(),scopeIds:['SOC']},{scope:'SOC',limit:10})
 assert.equal(calls,2)
})

test('坏来源回包显式失败且不落库，来源异常不伪装为空结果',async()=>{
 const mutations=[
  {...page(),scope:'AppSec'},
  {...page(),sourceId:'other'},
  {...page(),items:[alert,alert]},
  {...page(),items:[{...alert,scope:'AppSec'}]},
  {...page(),items:[{...alert,id:42}]},
  {...page(),items:[{...alert,receivedAt:'2026-09-12T00:59:59.000Z'}]},
  {...page(),items:[{...alert,fields:[{label:'资产',value:'prod-03'},{label:'资产',value:'prod-04'}]}]},
  {...page(),nextCursor:'page-1'},
  {...page(),unexpected:true},
 ]
 for(const value of mutations){const owner=randomUUID(),service=new BusinessDataService(pool,source(async()=>value));await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10,cursor:'page-1'}),{code:'teloa/source-invalid'});assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].n,0)}
 for(const [query,value] of [[{scope:'SOC',source:'Splunk',limit:10},page()],[{scope:'SOC',quality:'missing',limit:10},page()],[{scope:'SOC',observedAfter:'2026-09-12T02:00:00.000Z',limit:10},page()],[{scope:'SOC',text:'not-found',limit:10},page()]] as const){const service=new BusinessDataService(pool,source(async()=>value));await assert.rejects(service.query({ownerId:randomUUID(),scopeIds:['SOC']},query),{code:'teloa/source-invalid'})}
 const unavailable=new BusinessDataService(pool,source(async()=>{throw Error('secret upstream detail')}))
 await assert.rejects(unavailable.query({ownerId:randomUUID(),scopeIds:['SOC']},{scope:'SOC',limit:10}),{code:'teloa/source-unavailable',message:'安全告警来源当前不可读取；未以空结果或旧数据替代。'})
})

test('查询边界与取消信号不会进入数据源或留下半份快照',async()=>{
 let calls=0;const owner=randomUUID(),service=new BusinessDataService(pool,source(async(_input,signal)=>{calls++;signal?.throwIfAborted();return page()}))
 for(const input of [{scope:'SOC',limit:0},{scope:'SOC',limit:101},{scope:'SOC',limit:10,extra:true},{scope:'general',limit:10},{scope:'SOC',limit:10,observedAfter:'yesterday'}])await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},input),{code:'teloa/invalid-input'})
 const controller=new AbortController();controller.abort();await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10},controller.signal),{name:'AbortError'})
 assert.equal(calls,0);assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].n,0)
})

test('快照读取器接受 tombstone 的 deletedAt，旧快照摘要不变，即时查询来源页不收 tombstone',async()=>{
 // 旧快照没有 deletedAt：读回的对象与入库时 JSON 逐字相同，摘要与此前一致。
 assert.equal(businessObjectSnapshotHash(readBusinessObjectSnapshot(alert,'SOC')),createHash('sha256').update(JSON.stringify(alert)).digest('hex'))
 assert.equal(readBusinessObjectSnapshot(alert,'SOC').deletedAt,undefined)
 assert.equal('deletedAt' in readBusinessObjectSnapshot(alert,'SOC'),false)
 const deleted=readBusinessObjectSnapshot({...alert,deletedAt:'2026-09-25T00:00:00.000Z'},'SOC')
 assert.equal(deleted.deletedAt,'2026-09-25T00:00:00.000Z')
 assert.equal(Object.keys(deleted).at(-1),'deletedAt')
 for(const deletedAt of ['昨天','2026-09-25',null,1])assert.throws(()=>readBusinessObjectSnapshot({...alert,deletedAt},'SOC'),{code:'teloa/source-invalid'})
 const owner=randomUUID(),service=new BusinessDataService(pool,source(async()=>page([{...alert,deletedAt:'2026-09-12T01:00:02.000Z'}])))
 await assert.rejects(service.query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),{code:'teloa/source-invalid'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].n,0)
})
