import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,type DigitalRole} from '@teloa/contract'
import {GroupReplyExecutionService,groupReplyCanonical,groupReplyContentHash,readTrustedGroupReplySource,type GroupReplyExecution} from '../src/work/group-reply-executions.ts'
import {initializeGroupRoutingOutbox} from '../src/work/group-routing-outbox.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {parse,parsePlPgSQL} from 'libpg-query'

function fixture(){
 const owner=randomUUID(),id=randomUUID(),groupId=randomUUID(),messageId=randomUUID(),requestId=randomUUID(),now=new Date().toISOString()
 const role={id:randomUUID(),ownerId:owner,version:2,name:'同事',kind:'employee',state:'active',scopes:['general'],duty:'答疑',dataScope:'已共享资料',executionScope:'只读',skills:[],knowledge:[],createdAt:now,updatedAt:now} as DigitalRole
 const snapshot={schema:'teloa.group-reply-input/v1' as const,ownerId:owner,groupId,groupVersion:1,grantVersion:1,messageId,rootId:messageId,contextMode:'main' as const,role,references:[],context:{materials:[],files:[]},topic:undefined,source:{text:'你好',createdAt:now,authorId:'self'},ownerRequest:{messageId,text:'你好',sha256:createHash('sha256').update('你好').digest('hex')},lineage:null}
 const execution:GroupReplyExecution={id,sessionId:'group-reply-'+id,nativeRequestId:requestId,state:'prepared',snapshot,inputSha256:groupReplyContentHash(snapshot)}
 const row:Record<string,any>={id,owner_id:owner,group_id:groupId,group_version:1,message_id:messageId,role_id:role.id,role_version:2,request_id:requestId,execution_mode:'reply',task_id:null,run_id:null,state:'leased',lease_generation:1,next_attempt_at:new Date(Date.now()+30000),reply_execution:execution}
 const messages:Record<string,any>[]=[],queries:string[]=[],wakes:string[]=[]
 const query=async(sql:string,args:readonly any[]=[])=>{
  queries.push(sql)
  if(sql.startsWith('begin')||sql==='commit'||sql==='rollback')return {rows:[]}
  if(sql.startsWith('select * from teloa_group_routing_outbox'))return {rows:args[0]===owner&&args[1]===id?[row]:[]}
  if(sql.startsWith('update teloa_group_routing_outbox')){row.reply_execution=JSON.parse(args[2]);if(sql.includes("state='settled'"))row.state='settled';if(sql.includes("state='unknown'"))row.state='unknown';return {rows:[row]}}
  if(sql.startsWith('select * from teloa_group_messages'))return {rows:messages.filter(m=>m.owner_id===args[0]&&m.request_id===args[1])}
  if(sql.startsWith('insert into teloa_group_messages')){const m={id:args[0],owner_id:args[1],group_id:args[2],request_id:args[3],request_spec:JSON.parse(args[4]),root_id:args[5],author_id:args[6],reply_execution_id:args[7],text:args[8],reference_snapshot:JSON.parse(args[9]),created_at:new Date(args[10]),full_text:args[11],full_text_meta:args[12]===null?null:JSON.parse(args[12]),task_id:null,run_id:null};messages.push(m);return {rows:[m]}}
  if(sql.startsWith('insert into teloa_group_routing_wakes')){wakes.push(args[1]);return {rows:[]}}
  if(sql.startsWith('select m.*,o.reply_execution')){const m=messages.find(m=>m.owner_id===args[0]&&m.group_id===args[1]&&m.id===args[2]);return {rows:m?[{...m,reply_execution:row.reply_execution}]:[]}}
  throw Error('unexpected SQL '+sql)
 }
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
 const service=new GroupReplyExecutionService(pool,{id:randomUUID,now:()=>now})
 let authorized=true,checks=0
 // 本组只验证持久状态机；资料/岗位准入保留正式独立服务，不把此替身当作权限验收。
 Reflect.set(service,'current',async()=>{checks++;if(!authorized)throw new WorkError('teloa/forbidden','已撤权');return {assertCurrent(){}}})
 return {owner,id,groupId,requestId,row,pool,service,messages,queries,wakes,checks:()=>checks,revoke:()=>{authorized=false}}
}
test('jsonb键顺序与嵌套键顺序不会改变固定输入或hash',async()=>{
 assert.equal(groupReplyCanonical({b:{y:2,x:1},a:[{z:3,a:0}]}),groupReplyCanonical({a:[{a:0,z:3}],b:{x:1,y:2}}))
 const f=fixture();f.row.reply_execution=JSON.parse(groupReplyCanonical(f.row.reply_execution));await assert.doesNotReject(()=>f.service.get(f.owner,f.id))
})
test('提交claim只能取得一次；未知回执永不重新准备发送',async()=>{
 const f=fixture(),content={nativeInputSha256:'a'.repeat(64)}
 assert.equal(await f.service.submitting(f.owner,f.id,1,content),true)
 assert.equal(await f.service.submitting(f.owner,f.id,1,content),false)
 await f.service.observe(f.owner,f.id,{state:'unknown'})
 assert.equal(await f.service.submitting(f.owner,f.id,1,content),false)
 assert.equal((await f.service.prepare(f.owner,f.id)).state,'unknown')
 assert.ok(!f.queries.some(sql=>/insert into teloa_tasks|insert into teloa_task_runs/.test(sql)))
})
test('租约变更或准备后撤权均阻止首次提交',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.submitting(f.owner,f.id,2,{nativeInputSha256:'a'.repeat(64)}),{code:'teloa/version-conflict'})
 f.revoke();await assert.rejects(()=>f.service.submitting(f.owner,f.id,1,{nativeInputSha256:'a'.repeat(64)}),{code:'teloa/forbidden'})
 assert.equal(f.row.reply_execution.state,'prepared')
})
test('同rpcId的第二个真实消息不能借用首次原生发布许可',async()=>{
 const f=fixture();await f.service.submitting(f.owner,f.id,1,{nativeInputSha256:'a'.repeat(64)})
 await f.service.admitNativeInput(f.owner,f.id,'native-message','a'.repeat(64))
 await f.service.admitNativeInput(f.owner,f.id,'native-message','a'.repeat(64))
 await assert.rejects(()=>f.service.admitNativeInput(f.owner,f.id,'different-message','a'.repeat(64)),{code:'teloa/forbidden'})
 await assert.rejects(()=>f.service.admitNativeInput(f.owner,f.id,'native-message','b'.repeat(64)),{code:'teloa/forbidden'})
})
test('原生结束后群发布恰好一次，并与来源/唤醒共事务',async()=>{
 const f=fixture();await f.service.submitting(f.owner,f.id,1,{nativeInputSha256:'a'.repeat(64)})
 await f.service.admitNativeInput(f.owner,f.id,'native-message','a'.repeat(64))
 await f.service.observe(f.owner,f.id,{state:'ended',evidence:{turn:0,messageSeq:1,endSeq:3,reason:'completed'},text:'你好，同事'})
 const first=await f.service.publish(f.owner,f.id),again=await f.service.publish(f.owner,f.id)
 assert.deepEqual(first,again);assert.equal(f.messages.length,1);assert.equal(f.wakes.length,1);assert.ok('replyExecutionId' in first);assert.ok(!('taskId' in first));assert.ok(!('runId' in first))
 assert.equal((await readTrustedGroupReplySource(f.pool,f.owner,{groupId:f.groupId,messageId:first.id}))?.id,f.id)
 f.messages[0]!.text='伪造正文';await assert.rejects(()=>readTrustedGroupReplySource(f.pool,f.owner,{groupId:f.groupId,messageId:first.id}),{code:'teloa/storage-corrupt'})
})
test('完成后撤权保留原文但不发布；停止幂等且不能跨群',async()=>{
 const f=fixture();await f.service.submitting(f.owner,f.id,1,{nativeInputSha256:'a'.repeat(64)})
 await f.service.admitNativeInput(f.owner,f.id,'native-message','a'.repeat(64))
 await f.service.observe(f.owner,f.id,{state:'ended',evidence:{turn:0,messageSeq:1,endSeq:3,reason:'completed'},text:'固定结果'})
 f.revoke();await assert.rejects(()=>f.service.publish(f.owner,f.id),{code:'teloa/forbidden'});assert.equal(f.messages.length,0);assert.equal(f.row.reply_execution.text,'固定结果')
 const stop={requestId:randomUUID(),groupId:f.groupId,replyExecutionId:f.id};await assert.rejects(()=>f.service.stop(f.owner,{...stop,groupId:randomUUID()}))
 assert.deepEqual(await f.service.stop(f.owner,stop),await f.service.stop(f.owner,stop));assert.equal(f.row.reply_execution.state,'withdrawn')
 await assert.rejects(()=>f.service.publish(f.owner,f.id));assert.equal(f.messages.length,0)
})
test('schema增量保留旧任务证明，并约束回复独立身份及不可变输入',async()=>{
 const sql:string[]=[],pool={query:async(text:string)=>{sql.push(text);return {rows:[]}}} as unknown as Pool
 await initializeCollaboration(pool);await initializeGroupRoutingOutbox(pool)
 const joined=sql.join('\n')
 for(const statement of sql)await parse(statement)
 const body=joined.match(/create or replace function teloa_protect_group_reply_execution\(\) returns trigger language plpgsql as \$\$([\s\S]*?)\$\$/)?.[0]
 assert.ok(body);await parsePlPgSQL(body+';')
 assert.match(joined,/add column if not exists reply_execution_id uuid/)
 assert.match(joined,/task_id is not null and run_id is not null and reply_execution_id is null/)
 assert.match(joined,/task_id is null and run_id is null and reply_execution_id is not null/)
 assert.match(joined,/foreign key\(reply_execution_id,owner_id,group_id\)/)
 assert.match(joined,/group reply proof is immutable/)
 assert.doesNotMatch(joined,/delete from teloa_tasks|delete from teloa_task_runs|update teloa_task_runs/i)
})
