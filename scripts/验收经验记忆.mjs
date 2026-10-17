import assert from 'node:assert/strict'
import {createHash,randomUUID,randomBytes} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createRequire} from 'node:module'
import {lstat,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeRoleExperience,RoleExperienceService} from '../packages/backend/src/work/role-experience.ts'
import {HindsightMemoryProvider} from '../packages/backend/src/work/hindsight-memory.ts'
import {registerRoleConversationContext} from '../packages/harness-dsh/src/role-conversation-context.ts'

// 不猜测凭据路径，不连接原实例；资料全为合成验收内容。
const options={}
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i]
 if(!['--credentials-file','--output'].includes(key)||!process.argv[i+1]||options[key])throw Error('参数：--credentials-file <私有 DeepSeek JSON 文件> --output <结果 JSON 文件>')
 options[key]=process.argv[++i]
}
if(!options['--credentials-file']||!options['--output'])throw Error('须显式提供凭据文件和结果文件。')
const info=await lstat(options['--credentials-file'])
if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw Error('凭据须为私有普通文件。')
const credentials=JSON.parse(await readFile(options['--credentials-file'],'utf8'))
if(typeof credentials.deepseek!=='string'||!credentials.deepseek.trim())throw Error('凭据文件须含 deepseek 字段。')
const backendRequire=createRequire(new URL('../packages/backend/package.json',import.meta.url)),harnessRequire=createRequire(new URL('../packages/harness-dsh/package.json',import.meta.url))
const {Pool}=backendRequire('pg'),{PostgreSqlContainer}=backendRequire('@testcontainers/postgresql')
const {GenericContainer,Network,Wait}=createRequire(backendRequire.resolve('@testcontainers/postgresql'))('testcontainers')
const load=async name=>import(harnessRequire.resolve(name))
const [{Context},{AgentRegistry},{AgentLoop},{LlmAdapter,LlmRuntime,createUserMessage},{SessionId,SessionStore},{SessionProjectionRegistry},{SystemPrompt},{ToolRuntime}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools'].map(load))
const image='ghcr.io/vectorize-io/hindsight-api:0.10.3@sha256:f80f304db313cbc8775acd601fda7d094f5854ebf9bc252d8134eb9276d56b40'
const pgImage='pgvector/pgvector:0.8.2-pg16@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc'
const token=randomBytes(32).toString('hex'),model='deepseek-v4-flash',owner=randomUUID(),roleId=randomUUID()
const report={startedAt:new Date().toISOString(),image,pgImage,model,syntheticOnly:true,checks:[],agentUsage:[],status:'running'}
let network,pg,server,pool,ctx,secretsDirectory,stage='start'
const announce=value=>{stage=value;console.log(value)}
const scrub=value=>String(value).split(credentials.deepseek).join('[redacted]').split(token).join('[redacted]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[test database]')
const sleep=ms=>new Promise(done=>setTimeout(done,ms))
function memory(title,markdown){return {id:randomUUID(),version:1,title,markdown,contentHash:createHash('sha256').update(markdown).digest('hex'),source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['general']}}}
try{
 announce('启动隔离数据库与官方记忆服务')
 network=await new Network().start()
 pg=await new PostgreSqlContainer(pgImage).withNetwork(network).withNetworkAliases('memory-db').withUsername('hindsight').withDatabase('hindsight').start()
 pool=new Pool({connectionString:pg.getConnectionUri()});await pool.query('create extension if not exists vector');await initializeRoleExperience(pool)
 secretsDirectory=await mkdtemp(join(tmpdir(),'teloa-memory-secrets-'))
 for(const [name,value] of [['memory-db-password',pg.getPassword()],['memory-api-token',token],['memory-llm-key',credentials.deepseek]])await writeFile(join(secretsDirectory,name),value,{mode:0o444})
 const deployment=harnessRequire('yaml').parse(await readFile(new URL('../compose.memory.yaml',import.meta.url),'utf8')).services.memory
 const environment=Object.fromEntries(Object.entries(deployment.environment).map(([name,value])=>[name,value.replace(/\$\{[^:]+:-([^}]+)\}/g,'$1')]))
 server=await new GenericContainer(image).withNetwork(network).withExposedPorts(8888).withEnvironment(environment).withEntrypoint(deployment.entrypoint)
  .withBindMounts(['memory-db-password','memory-api-token','memory-llm-key'].map(name=>({source:join(secretsDirectory,name),target:'/run/secrets/'+name,mode:'ro'})))
  .withWaitStrategy(Wait.forHttp('/health/ready',8888).forStatusCode(200)).withStartupTimeout(600000).start()
 let endpoint=`http://${server.getHost()}:${server.getMappedPort(8888)}`,provider=new HindsightMemoryProvider({endpoint,token,timeoutMs:4000})
 const providerKey=endpoint,service=()=>new RoleExperienceService(pool,provider,{providerKey,timeoutMs:4000})
 const api=async path=>{const response=await fetch(endpoint+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});assert.ok(response.ok);return response.json()}
 const denied=await fetch(endpoint+'/v1/default/banks',{signal:AbortSignal.timeout(10000)});assert.equal(denied.status,401);report.checks.push('未授权 API 请求被拒绝')
 let memories=Array.from({length:34},(_,i)=>memory(`其他历史 ${i}`,`任务 LOG-${i} 已完成一般资料整理。`))
 memories.push(memory('NOVA-73 发布约定','NOVA-73 项目发布固定顺序：先验证构建制品 SHA256，再对小流量试运行，最后由负责人使用回执 CHK-427 确认结果并记入发布台账。未经确认不得扩大发布。'))
 const query='NOVA-73 发布约定是什么？请给出变更号、固定的三个步骤和负责人回执编号。',input={ownerId:owner,roleId,roleVersion:1,scope:'general',query,load:async()=>memories}
 announce('真实异步提炼及中文召回')
 const fallback=await service().read(input);assert.equal(fallback.mode,'confirmed');assert.doesNotMatch(fallback.text,/NOVA-73/)
 const waitRecall=async value=>{const deadline=Date.now()+300000;while(Date.now()<deadline){const result=await service().read(value);if(result.mode==='recalled')return result;await sleep(2000)}throw Error('真实提炼或召回未在五分钟内就绪')}
 const recalled=await waitRecall(input);assert.match(recalled.text,/NOVA-73/);report.checks.push('第 35 条历史进入真实召回，超过直接注入窗口')
 const index=(await pool.query('select bank_id,operation_id from teloa_role_experience_indexes where owner_id=$1',[owner])).rows[0]
 report.extractorUsage=await api(`/v1/default/banks/${index.bank_id}/llm-requests/stats`)
 announce('重启官方服务并复用持久回执')
 await promisify(execFile)('docker',['restart',server.getId()],{timeout:120000})
 const portAfterRestart=(await promisify(execFile)('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "8888/tcp") 0).HostPort}}',server.getId()])).stdout.trim()
 assert.match(portAfterRestart,/^\d+$/)
 endpoint=`http://${server.getHost()}:${portAfterRestart}`;provider=new HindsightMemoryProvider({endpoint,token,timeoutMs:4000})
 const deadline=Date.now()+600000
 while(true){try{const response=await fetch(endpoint+'/health/ready',{signal:AbortSignal.timeout(2000)});if(response.ok)break}catch{}if(Date.now()>deadline)throw Error('服务冷恢复失败');await sleep(2000)}
 assert.match((await waitRecall(input)).text,/NOVA-73/)
 assert.equal((await pool.query('select operation_id from teloa_role_experience_indexes where bank_id=$1',[index.bank_id])).rows[0].operation_id,index.operation_id);report.checks.push('服务重启后操作身份与来源保留')
 announce('官方 AgentLoop 的真实跨会话答复')
 class RealAdapter extends LlmAdapter{
  answers=[]
  async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']}}
  async *stream(options){
   const messages=[...(options.system?[{role:'system',content:options.system}]:[]),...options.messages.map(message=>({role:message.role,content:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')}))]
   const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{authorization:`Bearer ${credentials.deepseek}`,'content-type':'application/json'},body:JSON.stringify({model,messages,max_tokens:500,temperature:0,thinking:{type:'disabled'}}),signal:AbortSignal.timeout(90000)})
   assert.ok(response.ok,'实际 Agent 模型请求失败');const result=await response.json(),answer=result.choices?.[0]?.message?.content;assert.equal(typeof answer,'string')
   this.answers.push(answer);report.agentUsage.push(result.usage)
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:answer};yield {type:'block-end',index:0,block:{type:'text',text:answer}};yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new RealAdapter();ctx.llm.registerAdapter(['real-acceptance'],adapter)
 const role={id:roleId,ownerId:owner,name:'发布员工',kind:'employee',scopes:['general'],duty:'依据当前确认资料说明发布步骤',dataScope:'当前来源',executionScope:'只回答',skills:[],knowledge:[],version:1,state:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
 const ports={owner,conversation:async sessionId=>({id:sessionId,ownerId:owner,sessionId,status:'ready'}),requestedRoleId:async()=>roleId,links:async sessionId=>[{kind:'role',objectId:roleId,conversationId:sessionId,sessionId,scopeId:'general',active:true}],role:async()=>role}
 registerRoleConversationContext(ctx,ports)
 const send=async id=>{const {agent}=await ctx.agents.create({sessionId:SessionId(id),agentOptions:{provider:'real-acceptance',model}});agent.followup(createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:query}]}));await agent.whenIdle()}
 await send('memory-baseline');assert.equal(adapter.answers.length,1)
 report.baselineAnswer=adapter.answers[0];assert.doesNotMatch(report.baselineAnswer,/CHK-427/)
 ports.experience=async value=>(await service().read({...input,query:value.query,...(value.signal?{signal:value.signal}:{})})).text
 for(let i=0;i<2;i++){
  await send('memory-real-'+i)
   const answer=adapter.answers[i+1];assert.ok(answer);assert.match(answer,/NOVA-73/);assert.match(answer,/SHA.?256/i);assert.match(answer,/小流量/);assert.match(answer,/台账/);assert.match(answer,/CHK-427/)
   assert.doesNotMatch(answer,/teloa_[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)
 }
 report.checks.push('无记忆对照无法给出项目回执，两个新会话依据经验给出正确步骤和回执');report.answers=adapter.answers.slice(1)
 announce('跨范围隔离及来源撤回')
 const other=memory('其他范围','OTHER-52 只做文案校对。');other.visibility.scopeIds=['other']
 const otherInput={...input,scope:'other',load:async()=>[other]};await service().read(otherInput)
 assert.doesNotMatch((await waitRecall(otherInput)).text,/NOVA-73/)
 memories=[];assert.equal((await service().read(input)).text,'');report.checks.push('不同范围不召回原经验，撤回后为空')
 report.status='passed'
}catch(error){
 report.status='failed';report.failedStage=stage;report.error=scrub(error.message);process.exitCode=1
 if(server)try{const logs=await promisify(execFile)('docker',['logs','--tail','40',server.getId()],{timeout:10000});report.serviceDiagnostics=scrub(logs.stdout+logs.stderr)}catch{}
}
finally{
 announce('回收本轮隔离容器')
 const cleanup=await Promise.allSettled([ctx?.fiber.dispose(),pool?.end(),server?.stop(),pg?.stop()]);await network?.stop();if(secretsDirectory)await rm(secretsDirectory,{recursive:true,force:true})
 if(cleanup.some(item=>item.status==='rejected')){report.cleanupFailed=true;process.exitCode=1}
 report.finishedAt=new Date().toISOString();await writeFile(options['--output'],JSON.stringify(report,null,2)+'\n',{mode:0o600})
 console.log(report.status)
}
