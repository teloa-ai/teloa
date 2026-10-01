// 独立 TLS 验收子进程：只连接本机临时服务。端口与 DNS 在测试端口层替换，生产验证逻辑不放宽。
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises'
import {createServer} from 'node:https'
import {createSecureContext} from 'node:tls'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,type MarketCatalogSkillSecret,type WebAccessPolicy} from '@teloa/contract'
import TeloaCredentialProvider from '../../src/credentials/provider.ts'
import {registerCredentialGuards} from '../../src/credential-guards.ts'
import {createSkillSecretStore} from '../../src/skill-secrets.ts'
import {registerSkillHttpTool} from '../../src/skill-http-tool.ts'
import {pinnedHttpsRequest,resolvePublicAddresses} from '../../src/public-address.ts'
import {authorizePlanManagement} from '../../src/plan-tools.ts'
import {hasActiveUserInstruction} from '../../src/conversation-mutation.ts'
import {createSkillSecretsApi} from '../../../client/ui-workbench/src/client/skill-secrets-api.ts'

const dir=process.argv[2]!,home=join(dir,'dsh'),keyFile=join(dir,'store.key')
await mkdir(home)
await writeFile(keyFile,randomBytes(32).toString('base64'),{mode:0o600})
const fake='test-'+randomBytes(24).toString('hex'),envName='TELOA_SKILL_TLS_TEST_KEY'
assert.equal(process.env[envName],undefined)
let calls=0,tlsIdentity=true,credentialSeen=true,guardedExecutions=0
const audits:unknown[]=[],outputs:unknown[]=[]
const tlsOptions={key:await readFile(join(dir,'server.key')),cert:await readFile(join(dir,'server.crt'))},secureContext=createSecureContext(tlsOptions)
const server=createServer({...tlsOptions,SNICallback:(name,callback)=>{tlsIdentity&&=name==='api.skill.test';callback(null,secureContext)}},(req,res)=>{
 calls++
 tlsIdentity&&=req.headers.host?.startsWith('api.skill.test:')===true
 credentialSeen&&=req.headers.authorization===`Bearer ${fake}`
 if(req.url==='/v1/redirect'){res.writeHead(302,{location:'/v1/echo'});res.end();return}
 if(req.url==='/v1/outside'){res.writeHead(302,{location:'https://other.skill.test/v1/echo'});res.end();return}
 res.writeHead(200,{'content-type':'application/json'})
 res.end(JSON.stringify({plain:req.headers.authorization,base64:Buffer.from(fake).toString('base64')}))
})
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const address=server.address();assert.ok(address&&typeof address==='object')
const port=address.port,ctx=new Context()
class Provider extends TeloaCredentialProvider{
 constructor(c:Context){super(c,{dshHome:home,store:'file'},{keyring:undefined,env:{TELOA_CREDENTIALS_KEY_FILE:keyFile},keyDir:join(dir,'keys')})}
}
let second:Context|undefined
try{
 await ctx.plugin(Provider)
 const provider=ctx.credentials as TeloaCredentialProvider
 assert.equal(provider.status().tier,'file');assert.equal(provider.status().fault,null)
 let declarations:MarketCatalogSkillSecret[]=[{envVarName:envName,label:{'zh-CN':'测试密钥',en:'Test key'},required:true,target:'bearer',endpoints:[{origin:'https://api.skill.test',pathPrefixes:['/v1/']}],methods:['GET','POST']}]
 const store=createSkillSecretStore(provider,async()=>({secrets:declarations}),event=>audits.push(event))
 const api=createSkillSecretsApi((endpoint,payload)=>store.handle(endpoint,payload))
 const initial=await api.describe('tls-skill')
 const saved=await api.save('tls-skill',{[envName]:fake},initial.binding!)
 outputs.push(initial,saved)
 assert.equal(saved.vars[0]!.configured,true)
 assert.ok(provider.secretValues().includes(fake))
 assert.ok(!provider.secretValues().includes(saved.binding!))
 assert.equal((await stat(join(home,'.credentials.enc'))).mode&0o777,0o600)
 assert.ok(!(await readFile(join(home,'.credentials.enc'),'utf8')).includes(fake))
 await assert.rejects(stat(join(home,'.credentials.yaml')),{code:'ENOENT'})
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('tls-owner'),agentOptions:{provider:'test',model:'test'}})
 const auth={owner:'owner',conversation:async(id:string)=>({ownerId:'owner',sessionId:id,status:'ready' as const}),readTaskPolicy:async()=>null}
 let policy:WebAccessPolicy={version:1,enabled:true,blocked:[]}
 let privateDns=false
 registerCredentialGuards(ctx,{roots:()=>provider.protectedPaths(),known:()=>provider.secretValues()})
 registerSkillHttpTool(ctx,{
  authorize:async exec=>{const id=await authorizePlanManagement(auth,exec,'技能接口');if(!exec.agent||!hasActiveUserInstruction(exec.agent.session))throw new WorkError('teloa/forbidden','无活跃用户指令');return {sessionId:id}},
  skillVisible:async()=>true,readForUse:skill=>store.readForUse(skill),allow:()=>true,webPolicy:async()=>policy,audit:event=>audits.push(event),approvalPolicy:()=>undefined,
  resolve:async(host,signal)=>{
   if(privateDns)return resolvePublicAddresses(host,signal,async()=>[{address:'127.0.0.1',family:4}])
   assert.equal(host,'api.skill.test')
   // 成功链路只替换解析端口；另外走真实公网判定断言私网拒绝。
   return [{address:'127.0.0.1',family:4}]
  },
  request:(url,init,addresses)=>{const local=new URL(url);local.port=String(port);return pinnedHttpsRequest(local,init,addresses)},
 })
 ctx.tools.register(defineTool({name:'bash',description:'guard probe',parameters:{command:{type:'string',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{guardedExecutions++;return ''}}))
 const call=async(name:string,args:Record<string,unknown>)=>{
  const result=await ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('tls-'+randomBytes(6).toString('hex')),signal:AbortSignal.timeout(5000)})
  outputs.push(result);return result
 }
 const request=(path='/v1/echo',extra:Record<string,unknown>={})=>call('teloa_skill_http',{skill:'tls-skill',method:'GET',url:'https://api.skill.test'+path,...extra})
 assert.equal((await request()).isError,true,'无用户指令拒绝');assert.equal(calls,0)
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'tls-test'},content:[{type:'text',text:'调用测试技能'}]}),{surfaceOp:'append'})
 assert.equal((await request()).isError,false);assert.equal(calls,1)
 assert.equal((await request('/v1/redirect')).isError,false);assert.equal(calls,3)
 assert.equal(tlsIdentity,true);assert.equal(credentialSeen,true)
 assert.ok(JSON.stringify(outputs).includes('[已隐藏]'))
 const before=calls
 for(const [path,args] of [['/v2/no',{}],['/v1/echo',{method:'DELETE'}],['/v1/echo',{headers:'Authorization: Bearer user-value'}],['/v1/echo',{url:'https://other.skill.test/v1/echo'}]] as const)assert.equal((await request(path,args)).isError,true)
 policy={version:1,enabled:false,blocked:[]};assert.equal((await request()).isError,true)
 policy={version:1,enabled:true,blocked:['skill.test']};assert.equal((await request()).isError,true)
 policy={version:1,enabled:true,blocked:[]};privateDns=true;assert.equal((await request()).isError,true);privateDns=false
 assert.equal(calls,before,'拒绝路径未连接 TLS 服务')
 assert.equal((await request('/v1/outside')).isError,true);assert.equal(calls,before+1,'跨源跳转没有第二次连接')
 // 即使地址被测试解析器钉住，主机名证书仍必须匹配。
 await assert.rejects(pinnedHttpsRequest(new URL(`https://wrong.skill.test:${port}/v1/echo`),{method:'GET',headers:{},signal:AbortSignal.timeout(5000)},[{address:'127.0.0.1',family:4}]),{code:'ERR_TLS_CERT_ALTNAME_INVALID'})
 assert.equal(calls,before+1)
 assert.equal((await call('bash',{command:'cat '+join(home,'.credentials.enc')})).isError,true)
 assert.equal((await call('bash',{command:'echo '+fake})).isError,true)
 assert.equal(guardedExecutions,0)
 assert.equal(process.env[envName],undefined,'保存不注入进程环境')
 declarations=[{...declarations[0]!,methods:['GET']}]
 assert.equal((await api.describe('tls-skill')).reconfirm,true)
 const stale=await request();assert.ok(JSON.stringify(stale).includes('reconfirm-secrets'));assert.equal(calls,before+1)
 const refreshed=await api.describe('tls-skill')
 outputs.push(await api.save('tls-skill',{[envName]:fake},refreshed.binding!))
 assert.equal((await request()).isError,false)
 assert.ok(audits.some(e=>(e as {event:string}).event==='skill-secret.use'))
 assert.ok(audits.some(e=>(e as {event:string}).event==='skill-secret.deny'))
 assert.ok(!JSON.stringify({audits,outputs}).includes(fake),'回包与审计不含测试密钥')
 assert.ok(!JSON.stringify({audits,outputs}).includes(Buffer.from(fake).toString('base64')))
 await ctx.fiber.dispose()
 second=new Context();await second.plugin(Provider)
 const restored=createSkillSecretStore(second.credentials,async()=>({secrets:declarations}),event=>audits.push(event))
 assert.ok((await restored.readForUse('tls-skill')).values[envName]===fake,'重新挂载提供方后可读回加密凭据')
 outputs.push(await restored.remove({skill:'tls-skill'}))
 assert.ok(!(second.credentials as TeloaCredentialProvider).secretValues().includes(fake))
 for(const file of await readdir(home)){const path=join(home,file);if((await stat(path)).isFile())assert.ok(!(await readFile(path)).includes(fake),'持久文件不含明文测试密钥')}
 console.log('skill-http-tls: passed')
}finally{
 await second?.fiber.dispose();await ctx.fiber.dispose()
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
}
