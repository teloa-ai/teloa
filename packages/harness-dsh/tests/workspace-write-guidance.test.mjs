import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRuntime,official,createUserMessage,ToolCallId,textResponse} from '../../../tests/native-auto-review-fixture.mjs'
import {createTaskRunWorkspaceFileAccess} from '../src/workspace-file-access.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {restrictRunTools} from '../src/task-run-dsh.ts'
import {runToolApplicability} from '../src/task-run-tool-catalog.ts'

test('真实AgentLoop按冻结路径投影write指导，保留新建与未观察已有文件保护及拒绝尝试',async t=>{
 const {ctx,adapter,create}=await createRuntime(t),home=await mkdtemp(join(tmpdir(),'teloa-write-guide-')),cwd=join(home,'work')
 t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(cwd);await writeFile(join(cwd,'existing.md'),'keep existing')
 await ctx.plugin(await official('dsh-fs-observation-policy'),{})
 await ctx.plugin(await official('dsh-tool-fs'),{})
 ctx.provide('agentPresets',{serviceFor:()=>undefined})
 const agent=await create('write-guide-run',{cwd}),rules=[{name:'read',allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:['input.txt'],directories:[]}},{name:'write',allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:['created.md','existing.md'],directories:[]}}],policy={nativeRequestId:'write-guide-input',allowedTools:['read','write'],argumentRules:rules}
 registerTaskToolGuard(ctx,async()=>policy,[],undefined,undefined,undefined,undefined,undefined,undefined,createTaskRunWorkspaceFileAccess(ctx,cwd,async()=>policy,()=>false))
 t.after(restrictRunTools(agent,policy.allowedTools,runToolApplicability({inputText:'{}',argumentRules:rules},false)))
 const response=(name,id,args)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:ToolCallId(id),name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]
 adapter.script.push(response('write','new-output',{file_path:'created.md',content:'new output'}),response('write','existing-output',{file_path:'existing.md',content:'must not replace'}),response('read','unauthorized-output-read',{file_path:'existing.md'}),textResponse('fixture final'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:policy.nativeRequestId},content:[{type:'text',text:'Create an authorized output without reading other files.'}]}));await agent.whenIdle()
 const first=adapter.requests[0],system=first.messages.filter(message=>message.role==='system').flatMap(message=>message.content.filter(part=>part.type==='text').map(part=>part.text)).join('\n')
 assert.doesNotMatch(system,/Read an existing file before overwriting it with write \(the default fs-observation-policy requires it\)/)
 assert.match(system,/Create a new authorized destination directly with write/)
 assert.match(system,/read permission for that path/)
 assert.match(system,/stop without reading or probing the destination/)
 assert.deepEqual(first.tools.find(tool=>tool.name==='read').parameters.properties.file_path.enum,['input.txt'])
 const events=agent.session.snapshotEvents(),results=new Map(events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.toolCallId,e.data.message]))
 assert.equal(results.get('new-output')?.isError,false,JSON.stringify(results.get('new-output')))
 assert.equal(results.get('existing-output')?.isError,true,'官方observation保护仍拒绝未观察的已有目标')
 assert.equal(results.get('unauthorized-output-read')?.isError,true)
 assert.equal(await readFile(join(cwd,'created.md'),'utf8'),'new output')
 assert.equal(await readFile(join(cwd,'existing.md'),'utf8'),'keep existing')
 assert.equal(events.filter(e=>e.type==='tool/call').length,3,'实际被拒尝试不隐藏')
 const legacy=await create('legacy-write-guide',{cwd});t.after(restrictRunTools(legacy,['write'],{group:false,digest:false}))
 adapter.script.push(textResponse('legacy fixture'));legacy.followup(createUserMessage({source:{kind:'user',rpcId:'legacy-input'},content:[{type:'text',text:'No operation needed.'}]}));await legacy.whenIdle()
 const legacySystem=adapter.requests.at(-1).messages.filter(message=>message.role==='system').flatMap(message=>message.content.filter(part=>part.type==='text').map(part=>part.text)).join('\n')
 assert.match(legacySystem,/Read an existing file before overwriting it with write \(the default fs-observation-policy requires it\)/)
})
