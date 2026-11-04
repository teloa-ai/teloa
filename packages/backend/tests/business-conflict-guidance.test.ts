import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Client,Pool} from 'pg'
import {WorkError,readBusinessObjectTypeDefinition,type BusinessObjectSnapshot} from '@teloa/contract'
import {BusinessRecordService} from '../src/work/business-records.ts'
import {BusinessChangeSetService} from '../src/work/business-change-sets.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import type {BusinessDefinitionBundle} from '../src/work/business-definition-source.ts'

const scope='business_'+'a'.repeat(32),stamp='2026-01-01T00:00:00.000Z',digest='a'.repeat(64)
const actor={ownerId:'fixture-owner',scopeIds:[scope]}
/** 只代替SQL运输；版本、草稿校验与错误均运行正式服务，不连接PG或实现另一份CAS。 */
function fixture(document?:Record<string,unknown>){
 const record:Omit<BusinessObjectSnapshot,'snapshotHash'>={scope,type:'entry',id:randomUUID(),version:2,title:'记录',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'',fields:[{label:'状态',value:'active'}]}
 const definition=readBusinessObjectTypeDefinition({format:'teloa.business-object-type/v1',id:'entry',version:'1.0.0',domain:scope,title:'记录',unit:'条',lead:'记录',sourceId:'local',fields:[{name:'state',label:'状态',from:'状态',type:'text',required:true}]})
 const bundle:BusinessDefinitionBundle={origin:{kind:'local-configuration',configurationVersion:1,configurationHash:digest},scope,domain:scope,objectTypes:[{definition,source:{loadId:'local',scope,localId:'entry',version:'1.0.0',contentHash:digest,fileHash:digest,definitionHash:digest,origin:'local'}}],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map([['local',{connected:true}]])}
 const queries:string[]=[],origin={sessionId:'fixture-session',messageId:'fixture-message',seq:1,fingerprint:'fixed-origin'}
 const query=async(sql:string)=>{
  queries.push(sql);let rows:unknown[]=[]
  if(sql==='begin'||sql==='rollback'||sql==='commit'||sql.startsWith('select pg_advisory_')){}
  else if(sql.startsWith('select request_hash,')||sql.includes('from teloa_business_record_batches')){}
  else if(sql.startsWith('select source_id,current_version,created_at'))rows=[{source_id:'local',current_version:2,created_at:new Date(stamp)}]
  else if(sql.startsWith('select max(object_version)'))rows=[{v:2}]
  else if(sql.startsWith('select object_version,source_id,snapshot_hash,snapshot'))rows=[{object_version:2,source_id:'local',snapshot_hash:businessObjectSnapshotHash(record),snapshot:record}]
  else if(sql.startsWith('select document,origin from teloa_business_change_sets'))rows=[{document,origin}]
  else assert.fail('拒绝路径不得执行额外SQL：'+sql)
  return{rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
 }
 const client=Object.assign(new Client(),{query,release:()=>{}}),pool=Object.assign(new Pool(),{connect:async()=>client})
 const records=new BusinessRecordService(pool,{now:()=>stamp},{definitions:{forScope:async()=>[bundle]},warehouse:{assertQuota:async()=>assert.fail('冲突不得落库'),tombstone:async()=>assert.fail('冲突不得归档')},references:{pinInTransaction:async()=>assert.fail('冲突不得新增引用')}})
 return{records,changes:new BusinessChangeSetService(pool,{id:randomUUID,now:()=>stamp},records),record,queries,pool}
}
function neutralConflict(error:unknown){
 assert.ok(error instanceof WorkError);assert.equal(error.code,'teloa/version-conflict')
 assert.match(error.message,/已.*(?:变化|改变)/);assert.match(error.message,/本次未/)
 assert.doesNotMatch(error.message,/请.*(?:重新|再提交|重试)|必须.*重试/,'错误是事实回包，不能自行命令扩大原版本意图')
 return true
}

test('真实记录edit保留v2版本门与回滚，只返回中性冲突、不指令重读重提',async t=>{
 const f=fixture();t.after(()=>f.pool.end())
 await assert.rejects(f.records.edit(actor,{scope,type:'entry',id:f.record.id,requestId:randomUUID(),expectedVersion:1,fields:[{name:'state',value:'changed'}]}),neutralConflict)
 assert.equal(f.queries.at(-1),'rollback');assert.equal(f.record.version,2);assert.equal(f.record.fields[0]!.value,'active')
 assert.equal(f.queries.some(sql=>/^(?:insert|update|delete)\b/.test(sql)),false)
})

test('真实草稿采用的stale、revision和digest冲突在批准及写入前拒绝，且不命令重准备',async t=>{
 for(const drift of [{state:'stale',revision:1,digest},{state:'draft',revision:2,digest},{state:'draft',revision:1,digest:'b'.repeat(64)}]){
  const id=randomUUID(),f=fixture({id,scope,...drift});t.after(()=>f.pool.end())
  await assert.rejects(f.changes.apply(actor,{changeSetId:id,expectedRevision:1,expectedDigest:digest},async()=>assert.fail('失效草稿不得申请批准')),neutralConflict)
  assert.equal(f.queries.at(-1),'rollback');assert.equal(f.queries.some(sql=>/^(?:insert|update|delete)\b/.test(sql)),false)
 }
})
