import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

const module=await import('../src/client/project-runtime-api.ts').catch(()=>({createProjectRuntimeApi:undefined}))
const factory=module.createProjectRuntimeApi
const journal=()=>{let value:string|null=null;return {read:()=>value,write:(next:string)=>{value=next},clear:()=>{value=null}}}
test('只丢弃当前项目恢复请求，保留双方草稿、其他正常请求、预约与个人偏好，零服务调用',async()=>{
 const a=randomUUID(),b=randomUUID(),store=journal(),calls:string[]=[],api=factory!(async endpoint=>{calls.push(endpoint);throw Error('lost')},store),draft={projectId:a,version:0,automatic:'decisions' as const,readPersonal:false,resources:[]},personal={expectedVersion:0,entryId:null,topic:'偏好',markdown:'保留输入'}
 api.setDraft(a,draft);api.setDraft(b,{...draft,projectId:b});api.reserveCreation(b,'原预约','off');api.personal.setDraft(personal)
 await assert.rejects(api.configure(draft));await assert.rejects(api.configure({...draft,projectId:b}));const other=api.pending(b),before=calls.length
 assert.equal(api.discard(a),true);assert.equal(calls.length,before);assert.equal(api.pending(a),undefined);assert.deepEqual(api.pending(b),other);assert.deepEqual(api.draft(a),draft);assert.equal(api.draft(b)?.projectId,b);assert.equal(api.creation(b)?.memoryMode,'off');assert.deepEqual(api.personal.draft(),personal)
 const raw=JSON.parse(store.read()!);raw.pending.push({projectId:a,endpoint:'broken',input:{}});store.write(JSON.stringify(raw));const restored=factory!(async()=>{assert.fail('丢弃不得访问服务器')},store)
 assert.ok(restored.recoveryError());assert.equal(restored.discard(a),true);assert.equal(restored.recoveryError(),undefined);assert.deepEqual(restored.pending(b),other);assert.deepEqual(restored.draft(a),draft);assert.deepEqual(restored.personal.draft(),personal)
})

test('项目设置未知结果跨刷新使用原请求，后续草稿与其他项目保持独立',async()=>{
 assert.equal(typeof factory,'function','项目运行API尚未接线')
 const projectId=randomUUID(),other=randomUUID(),store=journal(),calls:any[]=[],settings={projectId,version:0,automatic:'decisions' as const,readPersonal:false,resources:[]}
 const api=factory!(async(_endpoint,input)=>{calls.push(input);throw Error('timeout')},store)
 api.setDraft(projectId,settings);await assert.rejects(api.configure(settings))
 api.setDraft(projectId,{...settings,automatic:'paused'});api.setDraft(other,{...settings,projectId:other})
 const restored=factory!(async(_endpoint,input:any)=>{calls.push(input);return {projectId:input.projectId,version:input.expectedVersion+1,automatic:input.automatic,readPersonal:input.readPersonal,resources:input.resources}},store)
 await restored.recover(projectId)
 assert.equal(calls[0].requestId,calls[1].requestId)
 assert.equal(restored.draft(projectId)?.automatic,'paused');assert.ok(restored.draft(other));assert.equal(restored.pending(projectId),undefined)
})

test('绑定回包错会话或记忆模式时保留原操作，不把会话改投别处',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),store=journal(),api=factory!(async(_endpoint,input:any)=>({sessionId:'wrong',projectId:input.projectId,version:1,memoryMode:'enabled',generation:1,title:'会话'}),store)
 await assert.rejects(api.bind({sessionId:'ordinary',projectId,expectedVersion:0,memoryMode:'off'}))
 assert.ok(api.pending(projectId));await assert.rejects(api.bind({sessionId:'ordinary',projectId:randomUUID(),expectedVersion:0,memoryMode:'off'}))
})

test('新建会话预约跨刷新保留请求、模式与工作区，完成后只清理该项目预约',()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),other=randomUUID(),store=journal(),api=factory!(async()=>null,store)
 const first=api.reserveCreation(projectId,'讨论方案','off');api.creationWorkspace(projectId,'workspace-a')
 api.reserveCreation(other,'另一项目','enabled')
 const restored=factory!(async()=>null,store),next=restored.reserveCreation(projectId,'讨论方案','off')
 assert.equal(next.requestId,first.requestId);assert.equal(next.workspaceId,'workspace-a')
 assert.throws(()=>restored.reserveCreation(projectId,'新内容','enabled'))
 restored.completeCreation(projectId,first.requestId);assert.equal(restored.creation(projectId),undefined);assert.ok(restored.creation(other))
 const hostAssigned=randomUUID();restored.reserveCreation(hostAssigned,'宿主位置','enabled');restored.creationWorkspace(hostAssigned,undefined)
 assert.throws(()=>factory!(async()=>null,store).creationWorkspace(hostAssigned,'workspace-b'),'宿主默认位置也必须保持，不能在重试时改投其他工作区')
})

test('实际使用与候选目录拒绝别项目、重复身份及不合法来源，明确拒绝可重新操作',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),other=randomUUID()
 await assert.rejects(factory!(async()=>({rows:[{id:randomUUID(),projectId:other,topic:'错误来源',markdown:'正文',kind:'memory',status:'candidate',reason:'待核实',version:1}]})).candidates(projectId))
 await assert.rejects(factory!(async()=>({rows:[{sessionId:'ordinary',projectId,version:1,memoryMode:'enabled',generation:1,title:'会话'},{sessionId:'ordinary',projectId,version:1,memoryMode:'enabled',generation:1,title:'重复'}]})).members(projectId))
 const api=factory!(async()=>{throw {rejected:true,code:'teloa/version-conflict'}})
 await assert.rejects(api.bind({sessionId:'ordinary',projectId,expectedVersion:0,memoryMode:'enabled'}));assert.equal(api.pending(projectId),undefined)
 await assert.rejects(factory!(async()=>({rows:[{id:randomUUID(),sessionId:'ordinary',messageId:'message-1',projectId,bindingVersion:1,generation:1,memoryMode:'enabled',createdAt:'2026-10-13T00:00:00Z',sources:[{kind:'rule',id:randomUUID(),version:1,hash:'broken',title:'规则'}],omitted:[]}]})).uses(projectId))
})

test('原生会话项目读取校验原会话身份，候选兼容服务的真实提案结构',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),candidateId=randomUUID(),api=factory!(async endpoint=>endpoint.endsWith('/binding')?{sessionId:'other',projectId,version:1,memoryMode:'enabled',generation:1,title:'其他会话'}:{rows:[{id:candidateId,projectId,proposal:{topic:'经验',markdown:'核对后再使用',kind:'memory'},status:'candidate',reason:'needs-review',version:1}]})
 await assert.rejects(api.binding('ordinary'))
 assert.equal((await api.candidates(projectId))[0]?.markdown,'核对后再使用')
})

test('损坏恢复记录不能把一个项目的待核对操作改投另一个项目',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),other=randomUUID(),store=journal(),calls:any[]=[]
 store.write(JSON.stringify({pending:[{projectId,endpoint:'configure',input:{projectId:other,requestId:randomUUID(),expectedVersion:0,automatic:'decisions',readPersonal:false,resources:[]}}],drafts:[],creations:[]}))
 const api=factory!(async(_endpoint,input)=>{calls.push(input);return null},store)
 assert.ok(api.recoveryError());await assert.rejects(async()=>api.recover(projectId));assert.equal(calls.length,0)
})

test('提炼失败重试丢回执后按原请求恢复，暂停明确拒绝仍保留设置草稿',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),eventId=randomUUID(),store=journal(),calls:any[]=[],draft={projectId,version:0,automatic:'verified' as const,readPersonal:true,resources:[]}
 const api=factory!(async(endpoint,input)=>{calls.push([endpoint,input]);throw Error('timeout')},store)
 api.setDraft(projectId,draft)
 await assert.rejects(api.retry(projectId,eventId));assert.equal(api.pending(projectId)?.endpoint,'retry')
 const restored=factory!(async(endpoint,input)=>{calls.push([endpoint,input]);return {ok:true}},store)
 assert.equal(calls.length,1,'恢复 API 不自动重试模型')
 await restored.recover(projectId)
 assert.deepEqual(calls[0],calls[1]);assert.deepEqual(Object.keys(calls[0][1]).sort(),['eventId','projectId','requestId'])
 assert.equal(restored.pending(projectId),undefined);assert.deepEqual(restored.draft(projectId),draft)
 const paused=factory!(async()=>{throw {rejected:true,code:'teloa/conflict',message:'原始内部异常不用于界面'}},store)
 await assert.rejects(paused.retry(projectId,eventId));assert.equal(paused.pending(projectId),undefined);assert.deepEqual(paused.draft(projectId),draft)
 const rows=await factory!(async()=>({rows:[{eventId,projectId,attempts:3,errorCode:'teloa/dependency-unavailable',canRetry:false}]})).failures(projectId)
 assert.equal(rows[0]?.canRetry,false)
 await assert.rejects(factory!(async()=>({rows:[{...rows[0],projectId:randomUUID()}]})).failures(projectId))
 await assert.rejects(factory!(async()=>({rows:[{...rows[0],errorCode:'Error: private stack\n at path'}]})).failures(projectId))
})

test('候选原始依据严格核对身份与证据类型，兼容旧回包及提案引用结构',async()=>{
 assert.equal(typeof factory,'function')
 const projectId=randomUUID(),source={sessionId:'native-session',messageId:'message-1'},evidence=[{kind:'decision',text:'本人确认先检查清单'},{kind:'verified',text:'正式核实正文'}],legacy={id:randomUUID(),projectId,topic:'工作经验',markdown:'先检查清单',kind:'memory',status:'candidate',reason:'needs-review',version:1}
 const row={...legacy,source,evidence,proposal:{topic:legacy.topic,markdown:legacy.markdown,kind:legacy.kind,evidence:[{evidenceId:'message:1',quote:'先检查清单'}]}}
 const read=(value:unknown)=>factory!(async()=>({rows:[value]})).candidates(projectId)
 const [candidate]=await read(row)
 assert.deepEqual(candidate?.source,source);assert.deepEqual(candidate?.evidence,evidence,'提案引用不能覆盖经授权的原文证据')
 assert.equal((await read(legacy))[0]?.evidence,undefined)
 for(const source of [{sessionId:'',messageId:'message-1'},{sessionId:'session',messageId:'message',url:'unchecked'}])await assert.rejects(read({...row,source}))
 for(const evidence of [[{kind:'model-verified',text:'未经核实'}],[{kind:'assistant',text:''}],[{kind:'rule',text:'规则',url:'unchecked'}],Array.from({length:33},()=>({kind:'decision',text:'正文'})),[{kind:'verified',text:'x'.repeat(16001)}]])await assert.rejects(read({...row,evidence}))
})
