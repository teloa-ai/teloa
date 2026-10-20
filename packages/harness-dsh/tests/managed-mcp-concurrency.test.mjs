import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from '../../../scripts/runtime/native-runtime.mjs'

// 与正式宿主相同的固定私有运行图；不改 node_modules 或共享 store。
const root=fileURLToPath(new URL('../../../',import.meta.url)),runtime=await realpath(await mkdtemp(join(tmpdir(),'teloa-mcp-parallel-')))
const plan=await prepareNativeRuntime({programRoot:root,runtimeRoot:runtime});installNativeRuntime(plan)
after(()=>rm(runtime,{recursive:true,force:true}))
const {createRuntime,official,autoReview,createUserMessage,textResponse}=await import('../../../tests/native-auto-review-fixture.mjs')
const {registerNativeAutoReviewGuard}=await import('../src/native-auto-review-guard.ts')
const {registerTaskToolGuard}=await import('../src/task-tool-guard.ts')
const {registerManagedMcpWriteApproval}=await import('../src/managed-mcp-connections.ts')
const mcp=await official('dsh-mcp-client')

async function fixture(t,hints){
 let active=0,maxActive=0
 const calls=[],server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(req.method==='DELETE'?200:405);res.end();return}
  try{
   let body='';for await(const part of req)body+=part
   const message=JSON.parse(body)
   if(!('id' in message)){res.writeHead(202);res.end();return}
   let result
   if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-concurrency-fixture',version:'1.0.0'}}
   else if(message.method==='tools/list')result={tools:Object.entries(hints).map(([name,annotations])=>({name,description:'Local fixture only',inputSchema:{type:'object',properties:{target:{type:'string'}},additionalProperties:false},...(annotations?{annotations}:{}),...(name==='required'?{execution:{taskSupport:'required'}}:{})}))}
   else if(message.method==='tools/call'){
    calls.push(message.params.name);active++;maxActive=Math.max(maxActive,active)
    await new Promise(r=>setTimeout(r,80));active--
    result={content:[{type:'text',text:message.params.name}]}
   }else{res.writeHead(404);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
  }catch{res.writeHead(400);res.end()}
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 t.after(()=>new Promise(r=>server.close(r)))
 return {url:'http://127.0.0.1:'+server.address().port+'/mcp',calls,maximum:()=>maxActive}
}
const readOnly={readOnlyHint:true,destructiveHint:false}
function batch(names){return [...names.flatMap((name,index)=>[
 {type:'block-start',index,blockType:'tool-call'},
 {type:'tool-call-delta',index,id:'parallel-'+index,name,argumentsDelta:'{}'},
 {type:'block-end',index,block:{type:'tool-call',id:'parallel-'+index,name,arguments:'{}'}},
]),{type:'finish',reason:{kind:'tool-calls'}}]}

for(const mode of ['danger-full-access','auto'])test(`真实 HTTP MCP 在 ${mode} 使用原生有界并发且保留模型归档顺序`,async t=>{
 const peer=await fixture(t,{first:readOnly,second:readOnly,third:readOnly}),{ctx,adapter,create}=await createRuntime(t)
 await ctx.plugin(mcp,{transport:'streamable-http',serverName:'fixture',url:peer.url,headers:{},toolCallTimeoutMs:5000,failOnStartupError:true})
 const agent=await create('parallel-'+mode),names=['first','second','third'].map(n=>'mcp__fixture__'+n)
 if(mode==='auto')await ctx.plugin(autoReview)
 ctx.permissionPresets.set(agent.session,mode)
 const read=async()=>({nativeRequestId:'parallel-request',allowedTools:names,argumentRules:names.map(name=>({name,allowed:[{}]}))})
 registerManagedMcpWriteApproval(ctx,name=>names.includes(name)?'本机测试服务':undefined)
 registerTaskToolGuard(ctx,read);registerNativeAutoReviewGuard(ctx,read)
 adapter.script.push(batch(names),...(mode==='auto'?names.map(()=>textResponse(JSON.stringify({risk:'low',decision:'allow'}))):[]),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'parallel-request'},content:[{type:'text',text:'Read three independent local fixtures.'}]}));await agent.whenIdle()
 assert.equal(peer.maximum(),3);assert.deepEqual(peer.calls,['first','second','third'])
 const results=agent.session.snapshotEvents().filter(e=>e.type==='tool/result')
 assert.deepEqual(results.map(e=>e.data.message.toolCallId),['parallel-0','parallel-1','parallel-2'])
 assert.ok(results.every(e=>!e.data.message.isError));assert.equal(adapter.requests.length,mode==='auto'?5:2)
})

test('缺失、矛盾、写入与要求 Tasks 的提示均形成串行屏障，重新发现不沿用旧提示',async t=>{
 const hints={read:readOnly,write:{readOnlyHint:false},missing:undefined,conflict:{readOnlyHint:true,destructiveHint:true},required:readOnly}
 const peer=await fixture(t,hints),{ctx}=await createRuntime(t)
 const attach=()=>ctx.plugin(mcp,{transport:'streamable-http',serverName:'barriers',url:peer.url,headers:{},toolCallTimeoutMs:5000,failOnStartupError:true})
 const mounted=attach();await mounted
 for(const name of Object.keys(hints))assert.equal(ctx.tools.get('mcp__barriers__'+name).isConcurrencySafe({}),name==='read',name)
 assert.deepEqual(ctx.tools.get('mcp__barriers__read').annotations,readOnly)
 await mounted.dispose();hints.read=undefined
 await attach();assert.equal(ctx.tools.get('mcp__barriers__read').isConcurrencySafe({}),false)
 assert.deepEqual(peer.calls,[],'发现与调度分类不会调用工具或授予只读权限')
})

test('真实原生循环在两个只读查询之间保留写工具串行屏障',async t=>{
 const peer=await fixture(t,{first:readOnly,write:{readOnlyHint:false},last:readOnly}),{ctx,adapter,create}=await createRuntime(t)
 await ctx.plugin(mcp,{transport:'streamable-http',serverName:'serial',url:peer.url,headers:{},toolCallTimeoutMs:5000,failOnStartupError:true})
 const agent=await create('serial'),names=['first','write','last'].map(name=>'mcp__serial__'+name)
 ctx.permissionPresets.set(agent.session,'danger-full-access')
 const read=async()=>({nativeRequestId:'serial-request',allowedTools:names,argumentRules:names.map(name=>({name,allowed:[{}]}))})
 registerManagedMcpWriteApproval(ctx,()=>'本机测试连接');registerTaskToolGuard(ctx,read);registerNativeAutoReviewGuard(ctx,read)
 adapter.script.push(batch(names),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'serial-request'},content:[{type:'text',text:'Run the local read, write, read fixture.'}]}));await agent.whenIdle()
 assert.deepEqual(peer.calls,['first','write','last']);assert.equal(peer.maximum(),1)
 assert.ok(agent.session.snapshotEvents().filter(e=>e.type==='tool/result').every(e=>!e.data.message.isError))
})

for(const scenario of ['ungranted','arguments-denied','native-deny','native-ask','revoked','permission-changed','restricted-reject','restricted-allow'])test(`真实 HTTP MCP 的 Full access 与受限审批仍保留 ${scenario}`,async t=>{
 const peer=await fixture(t,{probe:readOnly}),{ctx,adapter,create}=await createRuntime(t)
 await ctx.plugin(mcp,{transport:'streamable-http',serverName:'guard',url:peer.url,headers:{},toolCallTimeoutMs:5000,failOnStartupError:true})
 const agent=await create('guard-'+scenario),name='mcp__guard__probe'
 ctx.permissionPresets.set(agent.session,scenario.startsWith('restricted')?'workspace-write':'danger-full-access')
 let reads=0,asks=0,taskReads=0
 const stages=[]
 const read=async(source)=>{
  stages.push(source)
  reads++;if(source==='task')taskReads++
  if(scenario==='permission-changed'&&source==='task'&&taskReads===2){await Promise.resolve();ctx.permissionPresets.set(agent.session,'workspace-write')}
  const denied=scenario==='ungranted'||scenario==='revoked'&&source==='task'&&taskReads===2
  return {nativeRequestId:'guard-request',allowedTools:denied?[]:[name],argumentRules:denied?[]:[{name,allowed:scenario==='arguments-denied'?[{target:'allowed'}]:[{}]}]}
 }
 registerManagedMcpWriteApproval(ctx,()=>'本机测试连接');registerTaskToolGuard(ctx,()=>read('task'));registerNativeAutoReviewGuard(ctx,()=>read('native'))
 if(scenario.startsWith('native-'))ctx.on('tools/pre-execute',async()=>({kind:scenario==='native-deny'?'deny':'ask',reason:'独立规则要求'}))
 ctx.on('approval/request',async()=>{asks++;return scenario==='restricted-allow'?'allowed-once':'rejected'})
 const response=batch([name]);if(scenario==='arguments-denied'){response[1].argumentsDelta='{"target":"outside"}';response[2].block.arguments='{"target":"outside"}'}
 adapter.script.push(response,textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'guard-request'},content:[{type:'text',text:'Run the local guard fixture.'}]}));await agent.whenIdle()
 const allowed=scenario==='restricted-allow',results=agent.session.snapshotEvents().filter(e=>e.type==='tool/result')
 assert.equal(results.length,1);assert.equal(results[0].data.message.isError,!allowed,JSON.stringify({reads,stages,calls:peer.calls}));assert.equal(peer.calls.length,allowed?1:0)
 assert.equal(asks,scenario.startsWith('restricted')?1:0,'Full access 不会把独立 ask 当自动批准或调用审核模型')
 assert.equal(adapter.requests.length,2)
})
