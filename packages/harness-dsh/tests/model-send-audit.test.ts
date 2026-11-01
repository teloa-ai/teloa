import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {createModelSendAudit,loadModelSendAudit,readModelSendAuditBinding,type ModelSendAuditBinding,type ModelSendAuditEvent,type ModelSendAuditRun} from '../src/model-send-audit.ts'
import {tempHome} from './fixtures/credentials.ts'

const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const png=Buffer.from('synthetic-image-no-private-payload')
const body=JSON.stringify({model:'MiniMax-M3',system:'PRIVATE_PROMPT',messages:[{role:'user',content:[{type:'text',text:'PRIVATE_PROMPT'},{type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}}]}]})
const url='https://api.minimax.io/anthropic/v1/messages'
const binding=():ModelSendAuditBinding=>({schema:'teloa.model-send-audit/v1',ownerId:'synthetic-owner',groupId:randomUUID(),roleId:randomUUID(),ownerRequestId:randomUUID(),provider:'minimax',model:'MiniMax-M3',reasoningEffort:'high',outputDirectory:'/synthetic/audit'})
const run=(b:ModelSendAuditBinding):ModelSendAuditRun=>({ownerId:b.ownerId,groupId:b.groupId,roleId:b.roleId,ownerRequestId:b.ownerRequestId,provider:b.provider,model:b.model,reasoningEffort:b.reasoningEffort,runId:randomUUID(),sessionId:'task-run-'+randomUUID(),nativeRequestId:randomUUID()})
const options=(r:ModelSendAuditRun):GenerateOptions=>({provider:r.provider,model:r.model,reasoningEffort:'high' as GenerateOptions['reasoningEffort']&string,sessionId:r.sessionId as NonNullable<GenerateOptions['sessionId']>,messages:[]})
const finish:StreamChunk={type:'finish',reason:{kind:'stop'}}
async function drain(source:AsyncIterable<StreamChunk>){for await(const _ of source){/* 完整消费原迭代器。 */}}

test('实际发送边界记录图像摘要及状态，保留原body/headers/signal且不泄漏正文或凭据',async()=>{
 const b=binding(),r=run(b),events:ModelSendAuditEvent[]=[],headers={authorization:'Bearer SYNTHETIC_SECRET'},signal=new AbortController().signal
 let sends=0
 const audit=createModelSendAudit(b,{resolve:async()=>r,write:async event=>{events.push(event)}})
 await drain(audit.stream(options(r),async function*(){
  const response=await audit.send(url+'?beta=true',{method:'POST',body,headers,signal},async(input,init)=>{
   sends++;assert.equal(input,url+'?beta=true');assert.equal(init?.body,body);assert.equal(init?.headers,headers);assert.equal(init?.signal,signal);return new Response('synthetic',{status:201})
  });assert.equal(response.status,201);yield finish
 }))
 assert.equal(sends,1);assert.equal(events.length,3);assert.equal(events[2]?.phase,'stream-complete')
 assert.deepEqual(events[0]?.images,[{mime:'image/png',decodedBytes:png.length,sha256:digest(png)}])
 assert.equal(events[0]?.nativeRequestId,r.nativeRequestId);assert.equal(events[1]?.httpAttemptId,events[0]?.httpAttemptId)
 assert.equal(events[1]?.status,201)
 for(const secret of ['PRIVATE_PROMPT','SYNTHETIC_SECRET',png.toString('base64'),'authorization'])assert.ok(!JSON.stringify(events).includes(secret))
})

test('next/return/throw各自保留ALS，交错会话和辅助请求不吸入原Run；迭代结束清理',async()=>{
 const b=binding(),r=run(b),other={...run(b),groupId:randomUUID()},events:ModelSendAuditEvent[]=[],seen:string[]=[]
 const audit=createModelSendAudit(b,{resolve:async id=>id===r.sessionId?r:other,write:async event=>{events.push(event)}})
 const send=()=>audit.send(url,{method:'POST',body},async()=>{seen.push('send');return new Response('rejected',{status:429})})
 async function* original(){try{await send();await drain(audit.stream({...options(r),purpose:'session-title'},async function*(){await send();yield finish}));yield finish}catch{await send();yield finish}finally{await send()}}
 const first=audit.stream(options(r),original)[Symbol.asyncIterator]()
 await Promise.all([first.next(),drain(audit.stream(options(other),async function*(){await send();yield finish})),drain(audit.stream({...options(r),purpose:'session-title'},async function*(){await send();yield finish}))])
 assert.ok(first.throw);await first.throw(Error('PRIVATE_THROW'));assert.ok(first.return);await first.return()
 await send()
 assert.equal(seen.length,7);assert.equal(events.filter(event=>event.phase==='send').length,3,'仅next/throw/return三个真实目标发送被审计，嵌套辅助请求也须退出scope')
 assert.equal(new Set(events.map(event=>event.runId)).size,1)
})

test('绑定流坏JSON/无图/非法base64/错误URL和前审计失败均零send；无scope完全透传',async()=>{
 const b=binding(),r=run(b);let sent=0
 for(const bad of ['{',JSON.stringify({messages:[]}),body.replace(png.toString('base64'),'%%%%')]){
  const audit=createModelSendAudit(b,{resolve:async()=>r,write:async()=>{}})
  await assert.rejects(drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body:bad},async()=>{sent++;return new Response('bad')});yield finish})))
 }
 const audit=createModelSendAudit(b,{resolve:async()=>r,write:async()=>{throw Error('PRIVATE_STORAGE')}})
 await assert.rejects(drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')});yield finish})))
 await assert.rejects(drain(audit.stream(options(r),async function*(){await audit.send('https://other.invalid/messages',{method:'POST',body},async()=>{sent++;return new Response('bad')});yield finish})))
 assert.equal(sent,0)
 const request=new Request('https://other.invalid/');await audit.send(request,{},async input=>{assert.equal(input,request);sent++;return new Response('off')});assert.equal(sent,1)
})

test('首次Run固定后不接受同nonce的后继Run，发送前重核当前可信身份',async()=>{
 const b=binding(),r=run(b),events:ModelSendAuditEvent[]=[];let current=r,sent=0
 const audit=createModelSendAudit(b,{resolve:async()=>current,write:async event=>{events.push(event)}})
 const stream=()=>audit.stream(options(current),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('ok')});yield finish})
 await drain(stream());current={...r,runId:randomUUID(),nativeRequestId:randomUUID()}
 await assert.rejects(drain(stream()));assert.equal(sent,1)
 current=r
 await assert.rejects(drain(audit.stream(options(r),async function*(){current={...r,ownerRequestId:randomUUID()};await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')});yield finish})))
 assert.equal(sent,1);assert.equal(events.length,3)
})

test('无响应unknown后，同stream/新stream均在next前停止；无关Run与辅助请求不受污染',async()=>{
 const b=binding(),r=run(b),other={...run(b),groupId:randomUUID()},events:ModelSendAuditEvent[]=[];let sent=0
 const audit=createModelSendAudit(b,{resolve:async id=>id===r.sessionId?r:other,write:async event=>{events.push(event)}})
 await assert.rejects(drain(audit.stream(options(r),async function*(){try{await audit.send(url,{method:'POST',body},async()=>{sent++;throw Error('SECRET_TRANSPORT')})}catch(error){await assert.rejects(audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')}));throw error}yield finish})))
 assert.equal(sent,1);assert.equal(events[1]?.noResponseCategory,'transport-error');assert.ok(!JSON.stringify(events).includes('SECRET'))
 let nextCalls=0
 await assert.rejects(drain(audit.stream(options(r),async function*(){nextCalls++;await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')});yield finish})))
 assert.equal(nextCalls,0);assert.equal(sent,1)
 await drain(audit.stream({...options(r),purpose:'session-title'},async function*(){nextCalls++;yield finish}))
 assert.equal(nextCalls,1)
 await drain(audit.stream(options(other),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('unrelated')});yield finish}))
 assert.equal(sent,2);assert.equal(events.length,2,'无关Run发送没有进入本case日志')
})

test('HTTP200不等于模型完成，流失败/发送后落盘失败有围栏；明确429拒绝另行记录',async()=>{
 const b=binding(),r=run(b),events:ModelSendAuditEvent[]=[];let sent=0,nextCalls=0
 const audit=createModelSendAudit(b,{resolve:async()=>r,write:async event=>{events.push(event)}})
 await assert.rejects(drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('accepted')});throw Error('SYNTHETIC_STREAM_FAILURE');yield finish})))
 await assert.rejects(drain(audit.stream(options(r),async function*(){nextCalls++;yield finish})))
 assert.equal(nextCalls,0);assert.equal(sent,1)
 const broken=createModelSendAudit(b,{resolve:async()=>r,write:async event=>{if(event.phase==='response')throw Error('SECRET_STORAGE')}})
 await assert.rejects(drain(broken.stream(options(r),async function*(){await broken.send(url,{method:'POST',body},async()=>{sent++;return new Response('ok')});yield finish})),error=>error instanceof Error&&!error.message.includes('SECRET'))
 await assert.rejects(drain(broken.stream(options(r),async function*(){nextCalls++;yield finish})));assert.equal(nextCalls,0)
 const rejected:ModelSendAuditEvent[]=[],limited=createModelSendAudit(b,{resolve:async()=>r,write:async event=>{rejected.push(event)}})
 await drain(limited.stream(options(r),async function*(){await limited.send(url,{method:'POST',body},async()=>new Response('rate-limited',{status:429}));yield {type:'finish',reason:{kind:'error',failure:{code:'RATE_LIMIT',message:'synthetic'}}}}))
 assert.equal(rejected.find(event=>event.phase==='response')?.status,429)
 assert.equal(rejected.filter(event=>event.phase==='no-response').length,0)
 await drain(limited.stream(options(r),async function*(){await limited.send(url,{method:'POST',body},async()=>new Response('ok'));yield finish}))
})

test('正常流结清后允许合法下一流；同流未结清接受响应后不能第二次send',async()=>{
 const b=binding(),r=run(b),events:ModelSendAuditEvent[]=[];let sent=0
 const audit=createModelSendAudit(b,{resolve:async()=>r,write:async event=>{events.push(event)}})
 const completed=()=>audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('ok')});yield finish})
 await drain(completed());await drain(completed());assert.equal(sent,2)
 await drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('ok')});await assert.rejects(audit.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')}));yield finish}))
 assert.equal(sent,3)
})

test('return在finally yield后done=false仍未结清，重新加载不得进入next',async t=>{
 const root=await realpath(await tempHome(t,'teloa-audit-return-')),b={...binding(),outputDirectory:join(root,'events')},path=join(root,'binding.json'),bytes=JSON.stringify(b),r=run(b)
 await writeFile(path,bytes,{flag:'wx'});const env={TELOA_MODEL_SEND_AUDIT_BINDING:JSON.stringify({path,sha256:digest(bytes)})}
 const audit=await loadModelSendAudit(env,{resolve:async()=>r});assert.ok(audit)
 const iterator=audit.stream(options(r),async function*(){try{await audit.send(url,{method:'POST',body},async()=>new Response('accepted'));yield finish}finally{yield {type:'text-delta',index:0,text:'synthetic-finally'}}})[Symbol.asyncIterator]()
 await iterator.next();assert.ok(iterator.return);assert.equal((await iterator.return()).done,false)
 const restarted=await loadModelSendAudit(env,{resolve:async()=>r});assert.ok(restarted);let nextCalls=0
 await assert.rejects(drain(restarted.stream(options(r),async function*(){nextCalls++;yield finish})));assert.equal(nextCalls,0)
 await iterator.next();audit.close();restarted.close()
})

test('持久issued在后置写失败/无响应后仍阻止同binding重新加载的next和send',async t=>{
 for(const mode of ['transport','post-write','accepted-stream'] as const){
  const root=await realpath(await tempHome(t,'teloa-audit-fence-')),out=join(root,'events'),b={...binding(),outputDirectory:out},path=join(root,'binding.json'),bytes=JSON.stringify(b),config=JSON.stringify({path,sha256:digest(bytes)}),r=run(b)
  await writeFile(path,bytes,{flag:'wx'})
  const env={TELOA_MODEL_SEND_AUDIT_BINDING:config};let nextCalls=0,sent=0
  const audit=await loadModelSendAudit(env,{resolve:async()=>r});assert.ok(audit)
  await assert.rejects(drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>{
   sent++;if(mode==='transport')throw Error('synthetic connection lost')
   if(mode==='post-write'){const issued=(await readdir(out)).find(name=>name.endsWith('-send.json'));assert.ok(issued)
   const record=JSON.parse(await readFile(join(out,issued),'utf8'));await mkdir(join(out,record.httpAttemptId+'-response.json'))}return new Response('accepted')
  });if(mode==='accepted-stream')throw Error('synthetic stream interrupted');yield finish})))
  audit.close()
  const restarted=await loadModelSendAudit(env,{resolve:async()=>r});assert.ok(restarted)
  await assert.rejects(drain(restarted.stream(options(r),async function*(){nextCalls++;await restarted.send(url,{method:'POST',body},async()=>{sent++;return new Response('bad')});yield finish})))
  assert.equal(nextCalls,0);assert.equal(sent,1);restarted.close()
 }
})

test('仅可信启动path+SHA加载绑定，wx保存固定Run且重启不吸入另Run，缺省无文件副作用',async t=>{
 const root=await realpath(await tempHome(t,'teloa-model-audit-')),out=join(root,'events'),b={...binding(),outputDirectory:out},path=join(root,'binding.json'),bytes=JSON.stringify(b)
 await writeFile(path,bytes,{flag:'wx'});const config=JSON.stringify({path,sha256:digest(bytes)})
 assert.deepEqual(readModelSendAuditBinding(b),b)
 await assert.rejects(loadModelSendAudit({TELOA_MODEL_SEND_AUDIT_BINDING:JSON.stringify({path,sha256:'0'.repeat(64)})},{resolve:async()=>null}))
 assert.equal(await loadModelSendAudit({}, {resolve:async()=>null}),null)
 const r=run(b),audit=await loadModelSendAudit({TELOA_MODEL_SEND_AUDIT_BINDING:config},{resolve:async()=>r});assert.ok(audit)
 await drain(audit.stream(options(r),async function*(){await audit.send(url,{method:'POST',body},async()=>new Response('ok'));yield finish}))
 assert.equal(JSON.parse(await readFile(join(out,'run-binding.json'),'utf8')).nativeRequestId,r.nativeRequestId)
 audit.close()
 const later=await loadModelSendAudit({TELOA_MODEL_SEND_AUDIT_BINDING:config},{resolve:async()=>({...r,runId:randomUUID()})});assert.ok(later)
 await assert.rejects(drain(later.stream(options(r),async function*(){throw Error('must not enter');yield finish})))
 await mkdir(join(root,'unrelated'));later.close()
})
