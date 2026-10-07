import test from 'node:test'

test('官方 Team 工具逐项显式授权，不因可发现就默认放行',async()=>{
 const {roleGrantToolNames,taskRunToolRules,delegationToolAllowed}=await import('../src/role-tool-grants.ts')
 for(const name of ['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','team_task_create','team_task_list','team_task_get','team_task_update']){
  assert.equal(roleGrantToolNames.includes(name),true)
  assert.ok(taskRunToolRules([]).some(rule=>rule.name===name&&rule.anyArguments===true))
  assert.equal(delegationToolAllowed([],name),false)
  assert.equal(delegationToolAllowed([name],name),true)
 }
})
import assert from 'node:assert/strict'
import {createRoleToolGrantHandler,referenceToolRules,taskRunToolRules,validateReferenceToolRules,referenceReadTool,referenceServerName,mcpResourceTools,mcpResourceListTools,mcpResourceToolAllowed} from '../src/role-tool-grants.ts'
import type {ResourceContext} from '@teloa/contract'
import {orchestrationTools,teamDelegationTools,conversationDelegationTools,delegationTools,delegationToolAllowed,externalEgressTools,subagentTaskToolName,roleGrantToolNames,unconstrainedGrantToolNames} from '../src/role-tool-grants.ts'
import {nativeGrantToolNames} from '../src/native-tool-access.ts'
import {businessResultToolNames} from '../src/business-result-tools.ts'
import {knowledgeSearchToolName} from '../src/local-retrieval.ts'
import {readFileSync} from 'node:fs'
import {parse} from 'yaml'

test('文件工具只能接收真实候选的工作目录范围，不能伪造任意参数或路径授权',()=>{
 const candidates=['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace' as const}))
 validateReferenceToolRules(candidates,candidates)
 for(const name of ['read','write','edit']){
  assert.throws(()=>validateReferenceToolRules([{name,allowed:[],anyArguments:true}],candidates),{code:'teloa/forbidden'})
  assert.throws(()=>validateReferenceToolRules([{name,allowed:[{file_path:'/outside'}]}],candidates),{code:'teloa/forbidden'})
  assert.throws(()=>validateReferenceToolRules(candidates.filter(rule=>rule.name===name),[]),{code:'teloa/forbidden'})
 }
 assert.equal(unconstrainedGrantToolNames.includes('read'),false)
 assert.equal(roleGrantToolNames.includes('bash'),false)
})

test('原生编排支持本人会话与岗位显式授权，不能从声明自动获得执行权限',async()=>{
 const {orchestrationTools,orchestrationToolAllowed}=await import('../src/role-tool-grants.ts')
 for(const name of orchestrationTools){
  assert.equal(orchestrationToolAllowed(null,name),true)
  assert.equal(orchestrationToolAllowed([],name),false)
  assert.equal(orchestrationToolAllowed([name],name),true)
  assert.equal(roleGrantToolNames.includes(name),true)
  const rule={name,anyArguments:true as const,allowed:[]}
  validateReferenceToolRules([rule],taskRunToolRules([]))
  assert.throws(()=>validateReferenceToolRules([rule],[]))
 }
})

test('普通会话和执行态的委派工具判据逐项互斥，非委派工具保持不受影响',()=>{
 assert.deepEqual(conversationDelegationTools,['subagent','subagent_fork','send_message','interrupt_agent','list_agents','list_subagent_models'])
 assert.deepEqual(delegationTools,[...new Set([subagentTaskToolName,...conversationDelegationTools,...teamDelegationTools])])
 for(const name of conversationDelegationTools){
  assert.equal(delegationToolAllowed(null,name),true)
  assert.equal(delegationToolAllowed([],name),false)
  assert.equal(delegationToolAllowed([name],name),(teamDelegationTools as readonly string[]).includes(name))
 }
 assert.equal(delegationToolAllowed(null,subagentTaskToolName),false)
 assert.equal(delegationToolAllowed([],subagentTaskToolName),false)
 assert.equal(delegationToolAllowed(['read_evidence'],subagentTaskToolName),false)
 assert.equal(delegationToolAllowed([subagentTaskToolName],subagentTaskToolName),true)
 assert.equal(delegationToolAllowed(null,'read_evidence'),true)
 assert.equal(delegationToolAllowed([],'read_evidence'),true)
})
test('会话委派工具表与当前预设的名字、控制工具与模型查询开关一致',()=>{
 const preset=parse(readFileSync(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})[0].insert[0].config.plugins as Array<{id:string;config?:Array<{id:string;name:string;config?:Record<string,unknown>}>}>
 const rows=preset.find(row=>row.id==='delegation')!.config!
 const taskNames=['tool-subagent','tool-subagent-fork'].map(id=>rows.find(row=>row.id===id)!.config!.toolName)
 assert.deepEqual(conversationDelegationTools.slice(0,2),taskNames)
 assert.equal(rows.find(row=>row.id==='tool-subagent-control')!.name,'@deepseek-ai/dsh-tool-subagent-control')
 assert.equal(rows.find(row=>row.id==='tool-subagent-list-agents')!.name,'@deepseek-ai/dsh-tool-subagent-control/list-agents')
 assert.equal(rows.find(row=>row.id==='tool-subagent')!.config!.modelSelectionSettings,true)
 for(const id of ['tool-subagent-control','tool-subagent-list-agents','tool-subagent','tool-subagent-fork'])assert.equal((rows.find(row=>row.id===id)! as {disabled?:boolean}).disabled,true)
})
test('执行态委派工具固定为前台一次性，并给普通会话委派显式深度上限',()=>{
 const preset=parse(readFileSync(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})[0].insert[0].config.plugins as Array<{id:string;config?:Array<{id:string;config?:Record<string,unknown>}>}>
 const rows=preset.find(row=>row.id==='delegation')!.config!
 assert.equal(rows.find(row=>row.id==='tool-subagent')!.config!.maxDepth,3)
 assert.equal(rows.find(row=>row.id==='tool-subagent-fork')!.config!.maxDepth,3)
 const taskRow=rows.find(row=>row.id==='tool-subagent-task')! as {disabled?:unknown;config?:Record<string,unknown>}
 assert.equal(taskRow.disabled,true)
 assert.deepEqual(taskRow.config,{provider:'spawn',toolName:subagentTaskToolName,enableRunInBackground:false,backgroundMode:'one-shot',maxDepth:1})
})
test('整工具授权允许明确列出的委派与外发工具，资料规则仍逐对校验来源版本',()=>{
 // 委派描述、团队消息和外发查询参数不可枚举；默认仍不授予任何岗位。
 assert.ok(roleGrantToolNames.includes(subagentTaskToolName));assert.deepEqual(unconstrainedGrantToolNames,[subagentTaskToolName,...teamDelegationTools,...orchestrationTools,...externalEgressTools,...nativeGrantToolNames,...businessResultToolNames,knowledgeSearchToolName])
 const available=referenceToolRules([{sourceId:'one',sourceVersion:'v1'}] as ResourceContext['contents'])
 const delegation={name:subagentTaskToolName,anyArguments:true as const,allowed:[]}
 validateReferenceToolRules([delegation],taskRunToolRules([]))
 validateReferenceToolRules([delegation,{name:referenceReadTool,allowed:[{id:'one',version:'v1'}]}],available)
 for(const name of [referenceReadTool,...mcpResourceTools,'unknown'])assert.throws(()=>validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],available),{code:'teloa/forbidden'})
 for(const allowed of [[],[{}],[{task:'fixed'}]])assert.throws(()=>validateReferenceToolRules([{name:subagentTaskToolName,allowed}],available),{code:'teloa/forbidden'})
 assert.throws(()=>validateReferenceToolRules([delegation,{name:referenceReadTool,allowed:[{id:'one',version:'v2'}]}],available),{code:'teloa/forbidden'})
})
test('行业 MCP 只接受服务端给出的冻结完整工具名，不放大为服务器通配授权',()=>{
 const active={name:'mcp__alert_vendor__lookup_alert',anyArguments:true as const,allowed:[]}
 validateReferenceToolRules([active],[active])
 for(const rule of [
  {name:'mcp__alert_vendor__delete_alert',anyArguments:true as const,allowed:[]},
  {name:active.name,allowed:[{}]},
 ])assert.throws(()=>validateReferenceToolRules([rule],[active]),{code:'teloa/forbidden'})
 assert.throws(()=>validateReferenceToolRules([{...active,extra:'forged'} as never],[active]))
})
test('行业知识正文不冒充公共参考MCP可读取来源',()=>{
 const industry={sourceId:'industry_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',sourceVersion:'v1'}
 assert.deepEqual(referenceToolRules([industry] as ResourceContext['contents']),[])
 const mixed=referenceToolRules([industry,{sourceId:'public-one',sourceVersion:'v2'}] as ResourceContext['contents'])
 assert.deepEqual(mixed,[{name:referenceReadTool,allowed:[{id:'public-one',version:'v2'}]},{name:'list_mcp_resources',allowed:[{server:referenceServerName}]},{name:'list_mcp_resource_templates',allowed:[{server:referenceServerName}]}])
})
test('复用参考MCP并固定成对来源版本，拒绝其他工具及拼接参数',()=>{
 const available=referenceToolRules([{sourceId:'one',sourceVersion:'v1'},{sourceId:'two',sourceVersion:'v2'},{sourceId:'one',sourceVersion:'v1'}] as ResourceContext['contents'])
 assert.equal(available[0]?.allowed.length,2)
 validateReferenceToolRules([{name:referenceReadTool,allowed:[{version:'v1',id:'one'}]}],available)
 for(const rule of [{name:'write',allowed:[{}]},{name:referenceReadTool,allowed:[{id:'one',version:'v2'}]},{name:referenceReadTool,allowed:[{id:'one',version:'v1',path:'extra'}]},{name:referenceReadTool,allowed:[]}])assert.throws(()=>validateReferenceToolRules([rule],available),{code:'teloa/forbidden'})
})
test('授权接口固定本人，拒绝自报身份，候选查询先核对岗位归属',async()=>{
 let read=0,write=0,candidates=0
 const handler=createRoleToolGrantHandler('owner',async()=>({get:async owner=>{assert.equal(owner,'owner');read++;return {roleVersion:1,grant:null}},change:async owner=>{assert.equal(owner,'owner');write++;return {} as never}}),async()=>{candidates++;return {roleVersion:1,rules:[]}})
 await assert.rejects(handler('role-tools/get',{roleId:'role',owner:'other'}),{code:'teloa/invalid-input'})
 assert.equal(read,0)
 await handler('role-tools/candidates',{roleId:'role'});assert.equal(read,1);assert.equal(candidates,1)
 await handler('role-tools/change',{roleId:'role',expectedRoleVersion:1,action:'revoke',rules:[]});assert.equal(write,1)
 const denied=createRoleToolGrantHandler('owner',async()=>({get:async()=>{throw Error('forbidden')},change:async()=>({} as never)}),async()=>{candidates++;return {roleVersion:1,rules:[]}})
 await assert.rejects(denied('role-tools/candidates',{roleId:'foreign'}),/forbidden/);assert.equal(candidates,1)
})
test('只有实际给出 subagent_task 候选时才随候选回包说明委派限额',async()=>{
 const service=async()=>({get:async()=>({roleVersion:3,grant:null}),change:async()=>({} as never)})
 const without=createRoleToolGrantHandler('owner',service,async()=>({roleVersion:3,rules:[]} ),{maxDepth:1,maxPerRun:6})
 assert.deepEqual(await without('role-tools/candidates',{roleId:'role'}),{roleVersion:3,rules:[]})
 const withTask=createRoleToolGrantHandler('owner',service,async()=>({roleVersion:3,rules:[{name:subagentTaskToolName,anyArguments:true,allowed:[]}]}),{maxDepth:2,maxPerRun:9})
 assert.deepEqual(await withTask('role-tools/candidates',{roleId:'role'}),{roleVersion:3,rules:[{name:subagentTaskToolName,anyArguments:true,allowed:[]}],delegation:{maxDepth:2,maxPerRun:9}})
})
test('岗位可授权列举类资源工具，读取类因无法枚举 uri 仍不可授权',()=>{
 const available=referenceToolRules([{sourceId:'one',sourceVersion:'v1'}] as ResourceContext['contents'])
 // 规则名允许集已放开三个资源工具，不再靠硬编码工具名挡住；能否授权改由候选参数决定。
 for(const name of mcpResourceListTools)validateReferenceToolRules([{name,allowed:[{server:referenceServerName}]}],available)
 // 其他 server、多余参数、以及必带 uri 的读取工具都没有候选，一律拒绝。
 for(const rule of [{name:'list_mcp_resources',allowed:[{server:'other'}]},{name:'list_mcp_resources',allowed:[{server:referenceServerName,cursor:'c'}]},{name:'read_mcp_resource',allowed:[{server:referenceServerName}]},{name:'read_mcp_resource',allowed:[{server:referenceServerName,uri:'file:///a'}]}])assert.throws(()=>validateReferenceToolRules([rule],available),{code:'teloa/forbidden'})
 // 岗位没有公共资料可读时，连枚举该 server 的候选也不给。
 assert.deepEqual(referenceToolRules([] as unknown as ResourceContext['contents']),[])
})
test('MCP 资源工具默认拒绝，只有岗位授权清单显式列出才放行',()=>{
 assert.deepEqual([...mcpResourceTools],['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])
 for(const name of mcpResourceTools){
  assert.equal(mcpResourceToolAllowed(null,name),false)
  assert.equal(mcpResourceToolAllowed([],name),false)
  assert.equal(mcpResourceToolAllowed(['read_evidence'],name),false)
  assert.equal(mcpResourceToolAllowed([name],name),true)
 }
 // 非 MCP 资源工具不受这条闸影响，仍由既有白名单与参数规则决定。
 assert.equal(mcpResourceToolAllowed(null,referenceReadTool),true)
 assert.equal(mcpResourceToolAllowed([],'read_evidence'),true)
})

test('看板成果三工具进岗位授权候选：只能整工具授权，默认不授予',()=>{
 // 参数（范围、SQL、成果条目）由模型自由生成，平台无从枚举；范围仍由工具自身按本人登记范围核对。
 for(const name of businessResultToolNames){
  assert.equal(roleGrantToolNames.includes(name),true,name)
  assert.equal(unconstrainedGrantToolNames.includes(name),true,name)
  assert.ok(taskRunToolRules([]).some(rule=>rule.name===name&&rule.anyArguments===true&&rule.allowed.length===0),name)
  validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],taskRunToolRules([]))
  assert.throws(()=>validateReferenceToolRules([{name,allowed:[{scope:'SOC'}]}],taskRunToolRules([])),{code:'teloa/forbidden'})
  assert.throws(()=>validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],[]),{code:'teloa/forbidden'})
 }
})

test('本地检索工具进岗位授权候选（规格 §7.2）：只能整工具授权，默认不授予；带参数或无候选时拒绝',()=>{
 assert.equal(knowledgeSearchToolName,'teloa_knowledge_search')
 assert.equal(roleGrantToolNames.includes(knowledgeSearchToolName),true)
 assert.equal(unconstrainedGrantToolNames.includes(knowledgeSearchToolName),true)
 const candidates=taskRunToolRules([])
 assert.deepEqual(candidates.filter(rule=>rule.name===knowledgeSearchToolName),[{name:knowledgeSearchToolName,anyArguments:true,allowed:[]}])
 validateReferenceToolRules([{name:knowledgeSearchToolName,anyArguments:true,allowed:[]}],candidates)
 // 查询词不可枚举：按参数授权的变体一律拒；候选缺失（非暂停 employee 岗位没有这条候选）时已保存的规则也拒。
 assert.throws(()=>validateReferenceToolRules([{name:knowledgeSearchToolName,allowed:[{query:'报销'}]}],candidates),{code:'teloa/forbidden'})
 assert.throws(()=>validateReferenceToolRules([{name:knowledgeSearchToolName,allowed:[]}],candidates),{code:'teloa/forbidden'})
 assert.throws(()=>validateReferenceToolRules([{name:knowledgeSearchToolName,anyArguments:true,allowed:[]}],[]),{code:'teloa/forbidden'})
 // 普通会话（allowedTools null）不经这几条闸；执行态未列入即由 task-tool-guard 的清单闸拒绝。
 assert.equal(mcpResourceToolAllowed(null,knowledgeSearchToolName),true)
})

test('技能代发进岗位授权基线（规格 2026-09-27 §5.1，审查修复 R1 M-1）：按「岗位 × 技能」逐项授予；不进整工具授权、外发类与自授权集',async()=>{
 const {skillHttpToolName}=await import('../src/skill-http-tool.ts')
 const {selfAuthorizedToolNames}=await import('../src/self-authorized-tools.ts')
 const {roleGrantPageRules}=await import('../src/role-tool-grants.ts')
 assert.equal(roleGrantToolNames.includes(skillHttpToolName),true)
 assert.equal(unconstrainedGrantToolNames.includes(skillHttpToolName),false,'只能逐项授予技能，不接受整工具授权')
 assert.equal((externalEgressTools as readonly string[]).includes(skillHttpToolName),false)
 assert.equal((selfAuthorizedToolNames as readonly string[]).includes(skillHttpToolName),false)
 const granted={name:skillHttpToolName,allowed:[{skill:'x-search'}]}
 // 运行准备的复核：授权页保存时已逐项核对过，这里只校验形状，调用时再按快照与选定安装三重核对。
 validateReferenceToolRules([granted],taskRunToolRules([]))
 for(const bad of [{name:skillHttpToolName,anyArguments:true as const,allowed:[]},{name:skillHttpToolName,allowed:[]},{name:skillHttpToolName,allowed:[{skill:'x-search',method:'GET'}]},{name:skillHttpToolName,allowed:[{skill:'Bad Name'}]},{name:skillHttpToolName,allowed:[{url:'https://api.x.ai'}]}])
  assert.throws(()=>validateReferenceToolRules([bad],taskRunToolRules([])),{code:'teloa/forbidden'},JSON.stringify(bad))
 // 授权页：候选按技能枚举；只收候选里有的技能，新增技能默认不授予
 const page=roleGrantPageRules(taskRunToolRules([]),[{skill:'x-search',origins:['https://api.x.ai'],source:'role'},{skill:'brief',origins:['https://api.brief.test'],source:'industry'}])
 assert.deepEqual(page.filter(rule=>rule.name===skillHttpToolName),[{name:skillHttpToolName,allowed:[{skill:'x-search'},{skill:'brief'}]}])
 validateReferenceToolRules([granted],page)
 validateReferenceToolRules([{name:skillHttpToolName,allowed:[{skill:'brief'}]}],page)
 assert.throws(()=>validateReferenceToolRules([{name:skillHttpToolName,allowed:[{skill:'other'}]}],page),{code:'teloa/forbidden'},'候选外的技能不能授予')
 // 岗位没有可代发技能：授权页不出这条候选，保存即拒
 const none=roleGrantPageRules(taskRunToolRules([]),[])
 assert.equal(none.some(rule=>rule.name===skillHttpToolName),false)
 assert.throws(()=>validateReferenceToolRules([granted],none),{code:'teloa/forbidden'})
 assert.equal(none.length,taskRunToolRules([]).length-1,'其余候选不受影响')
})

test('技能代发候选列出岗位技能与行业职责技能（标来源）：只在「目录声明密钥、受管选定且启用」时产出，展示技能名、origin 与是否已保存密钥',async()=>{
 const {skillHttpGrantCandidates}=await import('../src/role-tool-grants.ts')
 const secret=(origin:string)=>({envVarName:'API_KEY',label:{'zh-CN':'密钥',en:'Key'},required:true,target:'bearer' as const,endpoints:[{origin,pathPrefixes:['/v1/']},{origin:origin+'.cn',pathPrefixes:['/v1/']}],methods:['GET' as const]})
 const ports={
  selected:async(name:string)=>({'x-search':{availability:'enabled'},'off-skill':{availability:'disabled'},'plain':{availability:'enabled'},'brief':{availability:'enabled'}} as Record<string,{availability:string}>)[name],
  declared:async(name:string)=>['x-search','off-skill','github-skill','brief'].includes(name)?{secrets:[secret(name==='brief'?'https://api.brief.test':'https://api.x.ai')]}:undefined,
  configured:async(name:string)=>name==='x-search'?true:undefined,
 }
 const role=(name:string)=>({name,source:'role' as const}),industry=(name:string)=>({name,source:'industry' as const})
 assert.deepEqual(await skillHttpGrantCandidates([role('plain'),role('off-skill'),role('github-skill'),role('missing')],ports),[],'无声明密钥 / 停用 / 非受管 / 未安装都不产出')
 assert.deepEqual(await skillHttpGrantCandidates([role('plain'),role('x-search'),industry('brief'),industry('x-search')],ports),[
  {skill:'x-search',origins:['https://api.x.ai','https://api.x.ai.cn'],configured:true,source:'role'},
  {skill:'brief',origins:['https://api.brief.test','https://api.brief.test.cn'],source:'industry'},
 ],'同名技能以岗位来源为准，只列一次')
})
