import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {registerManagedMcpWriteApproval} from '../src/managed-mcp-connections.ts'

// 真实原生工具运行器与审批服务：受管 MCP 写工具的逐次确认要让本人看到本次调用的参数，且不泄露凭据。
const tool='mcp__j7__j7_echo_marker'
async function fixture(t,answer){
 const {ctx,create}=await createRuntime(t),agent=await create('managed-mcp-write-approval')
 agent.session.append('turn/start',{turn:0})
 const executed=[],reasons=[]
 ctx.tools.register(defineTool({name:tool,description:'Echo a marker to the synthetic service.',parameters:{marker:{type:'string'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async args=>{executed.push(args);return 'echoed'}}))
 registerManagedMcpWriteApproval(ctx,name=>name===tool?'连接 J7 测试服务 的写工具 j7_echo_marker':undefined)
 ctx.on('approval/request',async input=>{reasons.push(input.reason??'');return answer})
 let seq=0
 const call=args=>ctx.tools.execute({agent,name:tool,arguments:args,callId:ToolCallId('j7-'+ ++seq),signal:AbortSignal.timeout(10_000)})
 return {call,executed,reasons}
}

test('确认卡带本次参数：marker 可见，原有确认语义保留',async t=>{
 const f=await fixture(t,'rejected')
 await f.call({marker:'NL04-marker-7f3a',note:'第一次写入'})
 assert.equal(f.reasons.length,1)
 const reason=f.reasons[0]
 assert.match(reason,/NL04-marker-7f3a/,'本人能核对本次 marker')
 assert.match(reason,/第一次写入/)
 assert.match(reason,/确认调用连接 J7 测试服务 的写工具 j7_echo_marker？它会改动外部服务的数据；员工授权不会代替逐次确认。/,'原有提示原样保留')
})

test('嵌套秘密与凭据形态不进入确认卡；超长参数截断',async t=>{
 const f=await fixture(t,'rejected')
 const secrets=['hunter2-short','abc-api-key-1','nested-tok-9','Bearer zXy9Q8wV7uT6sR5qP4oN3mL2kJ1','ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5','session-cookie-v']
 await f.call({marker:'NL04-marker-safe',auth:{password:secrets[0],apiKey:secrets[1],nested:{access_token:secrets[2]}},headers:{Authorization:secrets[3]},payload:'token '+secrets[4],cookie:secrets[5],long:'x'.repeat(5000)})
 const reason=f.reasons[0]
 assert.match(reason,/NL04-marker-safe/)
 for(const secret of secrets)assert.ok(!reason.includes(secret),'不得出现：'+secret.slice(0,6))
 assert.ok(!/ghp_[A-Za-z0-9]{10}/.test(reason),'凭据形态值被遮蔽')
 assert.ok(reason.length<700,'参数预览有界：'+reason.length)
})

test('拒绝不执行；允许一次仍逐次征询',async t=>{
 const rejected=await fixture(t,'rejected')
 const result=await rejected.call({marker:'NL04-reject'})
 assert.equal(result.isError,true);assert.equal(rejected.executed.length,0,'拒绝后不执行')
 const once=await fixture(t,'allowed-once')
 await once.call({marker:'NL04-once-1'});await once.call({marker:'NL04-once-2'})
 assert.equal(once.reasons.length,2,'允许一次不延续到下一次调用')
 assert.match(once.reasons[1],/NL04-once-2/,'每次确认卡展示该次的参数')
 assert.deepEqual(once.executed.map(args=>args.marker),['NL04-once-1','NL04-once-2'])
})
