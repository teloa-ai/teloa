import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {nativePtcToolPath} from './fixtures/native-ptc-tool-path.ts'
import {restrictRunTools} from '../src/task-run-dsh.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

const resourceNames=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'] as const
const resourceSection='mcp-resource-servers',server='teloa_reference'
const text=(message:{content:readonly {type:string;text?:string}[]})=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')

/** 生产运行图选中的真实 provider；未接入兼容补丁时走原官方包，不能让测试绕过发行接线。 */
async function fixture(t:TestContext){
 const f=await nativePtcToolPath(t),runtimeRoot=await realpath(await mkdtemp(join(tmpdir(),'teloa-resource-prompt-')))
 t.after(()=>rm(runtimeRoot,{recursive:true,force:true}))
 const programRoot=fileURLToPath(new URL('../../../',import.meta.url)),api=await import(new URL('../../../scripts/runtime/native-runtime.mjs',import.meta.url).href)
 const plan=await api.prepareNativeRuntime({programRoot,runtimeRoot}) as {packages:Array<{name:string;root:string}>}
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),managed=plan.packages.find(row=>row.name==='@deepseek-ai/dsh-mcp-resources')
 const provider=await import(pathToFileURL(managed?join(managed.root,'lib/index.js'):require.resolve('@deepseek-ai/dsh-mcp-resources')).href)
 await f.ctx.plugin(provider.default)
 const requests:Array<{method:string;uri?:string}>=[],resources=Reflect.get(f.ctx,'mcpResources') as {register:(name:string,provider:{request:(input:{method:string;uri?:string})=>Promise<unknown>})=>()=>void}
 const remove=resources.register(server,{request:async input=>{requests.push(input);return input.method==='resources/read'?{contents:[{uri:input.uri,text:'已授权固定资料'}]}:{resources:[{uri:'teloa://public/one',name:'固定资料'}]}}})
 f.ctx.on('approval/request',async()=> 'allowed-once')
 return {...f,requests,remove}
}

test('PTC 员工未授权资源工具时，最终输入与实际 tools 同时不广告资源或服务器；同预设其他员工不受影响',{timeout:30000},async t=>{
 const f=await fixture(t),agent=await f.create('ptc-persistent'),other=await f.create('ptc-persistent')
 registerTaskToolGuard(f.ctx,async id=>({allowedTools:id===agent.id?['run_code']:['run_code',...resourceNames]}))
 const lift=restrictRunTools(agent,['run_code'],{group:true,digest:false})
 try{
  const result=await f.run(agent,'console.log(JSON.stringify(Object.keys(tools)))')
  assert.notEqual(result.isError,true,text(result))
  for(const name of resourceNames)assert.doesNotMatch(text(result),new RegExp(name),'实际 PTC 对象没有未授权绑定')
  const request=f.adapter.requests[0];assert.ok(request)
  assert.deepEqual(request.tools?.map(tool=>tool.name),['run_code'])
  assert.doesNotMatch(JSON.stringify(request.messages),/list_mcp_resources|list_mcp_resource_templates|read_mcp_resource|teloa_reference/,'最终模型输入不能广告实际 tools 对象没有的资源入口或服务器')
  assert.deepEqual(f.requests,[])
  const otherPrompt=await f.ctx.systemPrompt.assemble({agent:other,scope:other})
  const advertisement=otherPrompt.sections.find(section=>section.name===resourceSection)?.text??''
  for(const name of resourceNames)assert.ok(advertisement.includes(name))
  assert.ok(advertisement.includes(server),'未收窄的同预设作用域保留服务器来源')
 }finally{lift()}
 const restored=await f.ctx.systemPrompt.assemble({agent,scope:agent})
 for(const name of resourceNames)assert.ok(restored.sections.find(section=>section.name===resourceSection)?.text.includes(name),'释放租约后只恢复此作用域原目录')
})

test('PTC 部分资源授权只广告可调用名字，实际 SDK 调用通过既有参数闸，撤销服务器后不留广告',{timeout:30000},async t=>{
 const f=await fixture(t),agent=await f.create('ptc-persistent')
 registerTaskToolGuard(f.ctx,async()=>({allowedTools:['run_code','list_mcp_resources'],argumentRules:[{name:'run_code',anyArguments:true,allowed:[]},{name:'list_mcp_resources',allowed:[{server}]}]}))
 const lift=restrictRunTools(agent,['run_code','list_mcp_resources'],{group:true,digest:false})
 try{
  const assembly=await f.ctx.systemPrompt.assemble({agent,scope:agent}),advertisement=assembly.sections.find(section=>section.name===resourceSection)?.text??''
  assert.match(advertisement,/list_mcp_resources/);assert.match(advertisement,/teloa_reference/)
  assert.doesNotMatch(advertisement,/list_mcp_resource_templates|read_mcp_resource/,'部分授权不能继续广告另两个操作')
  const result=await f.run(agent,'console.log(JSON.stringify(await tools.list_mcp_resources({server:"teloa_reference"})))')
  assert.notEqual(result.isError,true,text(result));assert.match(text(result),/teloa:\/\/public\/one/)
  assert.deepEqual(f.requests,[{method:'resources/list'}])
  const initial=f.adapter.requests[0];assert.ok(initial)
  assert.doesNotMatch(JSON.stringify(initial.messages),/list_mcp_resource_templates|read_mcp_resource/,'最终模型输入的 SDK 与广告都只列可见操作')
  const rejected=await f.run(agent,'console.log(await tools.list_mcp_resources({server:"other"}))')
  assert.equal(rejected.isError,true,'可见名字不扩大服务器参数授权');assert.equal(f.requests.length,1)
  f.remove()
  const revoked=await f.ctx.systemPrompt.assemble({agent,scope:agent})
  assert.equal(revoked.sections.find(section=>section.name===resourceSection)?.text??'','')
  assert.equal(f.ctx.tools.schemas(agent).some(tool=>resourceNames.includes(tool.name as typeof resourceNames[number])),false)
 }finally{lift()}
})

test('原生呈现仅授权资源读取时仍显示必要服务器并可执行，不依赖 PTC 或列表工具',{timeout:30000},async t=>{
 const f=await fixture(t),agent=await f.create('ptc-persistent'),restore=agent.ctx.tools.presentAs('native')
 registerTaskToolGuard(f.ctx,async()=>({allowedTools:['read_mcp_resource'],argumentRules:[{name:'read_mcp_resource',allowed:[{server,uri:'teloa://public/one'}]}]}))
 const lift=restrictRunTools(agent,['read_mcp_resource'],{group:false,digest:false})
 try{
  const assembly=await f.ctx.systemPrompt.assemble({agent,scope:agent}),advertisement=assembly.sections.find(section=>section.name===resourceSection)?.text??''
  assert.match(advertisement,/read_mcp_resource/);assert.match(advertisement,/teloa_reference/)
  assert.doesNotMatch(advertisement,/list_mcp_resources|list_mcp_resource_templates/)
  assert.deepEqual(assembly.tools.map(tool=>tool.name),['read_mcp_resource'])
  const result=await f.invoke(agent,'read_mcp_resource',{server,uri:'teloa://public/one'})
  assert.notEqual(result.isError,true,text(result));assert.match(text(result),/已授权固定资料/)
  assert.deepEqual(f.requests,[{method:'resources/read',uri:'teloa://public/one'}])
 }finally{lift();restore()}
})
