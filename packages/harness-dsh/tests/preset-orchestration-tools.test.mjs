import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,official,defineTool} from '../../../tests/native-auto-review-fixture.mjs'
import {presetOrchestrationToolNames} from '../src/native-tool-access.ts'
import {orchestrationTools,taskRunToolRules} from '../src/role-tool-grants.ts'

// 真实官方工具注册表：run_code 是 PTC 呈现的保留传输，只在 ptc 预设作用域可执行；授权页按岗位预设的真实工具面给编排候选。
test('编排候选按岗位预设的真实工具面：标准（native）预设没有 run_code，PTC 预设才有；workflow 随官方行注册',async t=>{
 const {ctx,create}=await createRuntime(t)
 for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-ptc-runtime-node']){const module=await official(name);await ctx.plugin(module.default??module,{})}
 ctx.tools.register(defineTool({name:'workflow',description:'Synthetic official workflow entry.',parameters:{},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},execute:async()=>'ok'}))
 const native=await create('preset-native'),ptc=await create('preset-ptc');ptc.ctx.tools.presentAs('ptc')
 const scopes={standard:native,ptc}
 ctx.provide('agentPresets',{acquireScope:async id=>({key:scopes[id??'standard'],async [Symbol.asyncDispose](){}})})
 assert.deepEqual(await presetOrchestrationToolNames(ctx,orchestrationTools,'standard'),['workflow'],'标准预设不展示永远拿不到的 run_code')
 assert.deepEqual(await presetOrchestrationToolNames(ctx,orchestrationTools,'ptc'),['workflow','run_code'])
 const names=rules=>rules.map(rule=>rule.name).filter(name=>orchestrationTools.includes(name))
 assert.deepEqual(names(taskRunToolRules([],['workflow'])),['workflow'],'授权页候选只含预设提供的编排工具')
 assert.deepEqual(names(taskRunToolRules([])),[...orchestrationTools],'运行准备的形状复核仍认全部编排名')
})

test('PTC 预设的任务 Run：收窄可见工具不触碰 run_code 保留传输，获准工具仍经 run_code 可达，未授予工具不可见',async t=>{
 const {restrictRunTools}=await import('../src/task-run-dsh.ts')
 const {ctx,create}=await createRuntime(t)
 for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-ptc-runtime-node']){const module=await official(name);await ctx.plugin(module.default??module,{})}
 for(const name of ['read_allowed','read_other'])ctx.tools.register(defineTool({name,description:'Synthetic '+name,parameters:{},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},execute:async()=>'ok'}))
 const agent=await create('ptc-run');agent.ctx.tools.presentAs('ptc')
 restrictRunTools(agent,['run_code','read_allowed'],{group:true,digest:false})
 assert.ok(ctx.tools.get('run_code',agent),'run_code 保留传输仍在');assert.ok(ctx.tools.get('read_allowed',agent));assert.equal(ctx.tools.get('read_other',agent),undefined)
})
