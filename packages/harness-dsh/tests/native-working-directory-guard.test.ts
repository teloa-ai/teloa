import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {nativePtcToolPath} from './fixtures/native-ptc-tool-path.ts'
import {official} from '../../../tests/native-auto-review-fixture.mjs'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {Agent} from '@deepseek-ai/dsh-agent'

test('原 working_directory 工具和 SDK 只能在原项目规范根内切换，链接越界零目录事件',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc'),inside=join(f.workspace,'nested'),outside=join(f.root,'outside')
 await mkdir(inside);await mkdir(outside);await symlink(outside,join(f.workspace,'escape'),'dir')
 await f.ctx.plugin(await official('dsh-tool-working-directory'))
 const allowed=await f.run(agent,`console.log(await tools.working_directory({cd:${JSON.stringify(inside)}}))`)
 assert.notEqual(allowed.isError,true);assert.equal(f.ctx.workingDirectory.get(agent.session),inside)
 const original=agent.session.header.cwd,policy=f.ctx.sandboxPolicy.resolve({session:agent.session}),before=agent.session.snapshotEvents().filter(event=>event.type==='working-directory/change').length
 for(const path of [outside,join(f.workspace,'escape')]){
  const denied=await f.run(agent,`console.log(await tools.working_directory({cd:${JSON.stringify(path)}}))`)
  assert.equal(denied.isError,true,'越界 cd 必须拒绝')
  await assert.rejects(f.ctx.workingDirectory.set(agent,path),/原项目|授权/)
  assert.equal(f.ctx.workingDirectory.get(agent.session),inside)
 }
 assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='working-directory/change').length,before)
 assert.equal(agent.session.header.cwd,original);assert.deepEqual(f.ctx.sandboxPolicy.resolve({session:agent.session}),policy)
})

test('原生真实 spawn 捕获启动子目录，父后续 cd 不跟随；显式越界 cwd 在发布前拒绝',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),parent=await f.create('ptc'),first=join(f.workspace,'first'),second=join(f.workspace,'second'),outside=join(f.root,'outside')
 for(const path of [first,second,outside])await mkdir(path)
 await f.ctx.workingDirectory.set(parent,first)
 await f.ctx.plugin(f.graph.persistencePackage,{root:join(f.root,'sessions'),compression:'none'})
 const query=await official('dsh-session-query')
 class PointQuery extends query.SessionQueryEngine{override searchSessions():Promise<never>{return Promise.reject(Error('本用例不提供搜索'))};override searchEvents():Promise<never>{return Promise.reject(Error('本用例不提供搜索'))}}
 await f.ctx.plugin(PointQuery)
 await f.ctx.plugin((await official('dsh-subagent')).SubagentRuntime,{maxDepth:1,maxActiveSubagents:2})
 await f.ctx.plugin(await official('dsh-subagent-spawn-in-process'),{providerName:'spawn'})
 // 子级已实际受理，停在官方 pre-step；本例不需要模型内容。
 f.ctx.on('agent/pre-step',async()=>({kind:'reject' as const}))
 const created:Agent[]=[];f.ctx.on('agent/created',({agent})=>{created.push(agent);return undefined},{global:true})
 const receipt=await f.ctx.subagents.startActivation({provider:'spawn',delivery:'parent',childId:SessionId('u4-directory-child'),label:'目录捕获',request:{parent,prompt:[{type:'text',text:'验证原目录'}]},signal:AbortSignal.timeout(10000)})
 t.after(()=>receipt.dispose())
 const child=f.ctx.agents.get(receipt.childId)??created.find(agent=>agent.id===receipt.childId);assert.ok(child)
 assert.equal(f.ctx.agents.isOwnedBy(child.id,parent),true)
 assert.equal(child.session.header.cwd,parent.session.header.cwd)
 assert.equal(f.ctx.workingDirectory.get(child.session),first)
 await f.ctx.workingDirectory.set(parent,second)
 assert.equal(f.ctx.workingDirectory.get(parent.session),second);assert.equal(f.ctx.workingDirectory.get(child.session),first)
 assert.equal(f.ctx.sandboxPolicy.resolve({session:child.session}).workspaceRoot,f.workspace)
 await assert.rejects(f.ctx.subagents.startActivation({provider:'spawn',delivery:'parent',childId:SessionId('u4-outside-child'),label:'越界目录',request:{parent,cwd:outside,prompt:[{type:'text',text:'不得启动'}]},signal:AbortSignal.timeout(10000)}),/原项目授权/)
 assert.equal(f.ctx.agents.get(SessionId('u4-outside-child')),undefined)
})
