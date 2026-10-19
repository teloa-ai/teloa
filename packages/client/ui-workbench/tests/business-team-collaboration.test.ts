import test from 'node:test'
import assert from 'node:assert/strict'
import {readTeamBrief,loadBusinessTeamCollaboration,teamBriefTitle,teamDecisionSubject,submitTeamDecision,teamRecordTarget} from '../src/client/business-team-collaboration.ts'

const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope='test-business',groupId=uid(1),roleId=uid(2),taskId=uid(3),artifactId=uid(4)
const brief=()=>({schema:'teloa.team-collaboration/v1',scope,groupId,summary:'限定交付',notes:['仍有数据缺口'],steps:[{id:'analysis',roleId,taskId,label:'研判',artifact:{id:artifactId,version:1}}],handoffs:[],deliveries:[{taskId,artifact:{id:artifactId,version:1},label:'研判报告'}],reviews:[],decisions:[{type:'test-alert',id:'case-1',pending:{field:'处理状态',value:'等你确认'},label:'采用研判'}]})
function fixture(){
 const saved=brief(),group={id:groupId,scope,archived:false,name:'研判组',version:1,ownerId:'owner'}
 const task={id:taskId,scope,ownerId:'owner',assigneeRoleId:roleId,state:'completed',version:2,title:'有限分析'}
 const artifact={id:artifactId,storage:'persistent',source:{kind:'task',id:taskId},versions:[{number:1,title:'报告',source:{scope,ref:{kind:'task',id:taskId}},sections:[]}]}
 const record={scope,type:'test-alert',id:'case-1',version:7,title:'候选',fields:[{label:'处理状态',value:'等你确认'}],deletedAt:null}
 const api={groups:{get:async()=>({group,members:[{roleId}]}),resources:async()=>({items:[{id:uid(5),title:teamBriefTitle,version:1,withdrawnAt:null}]}),resource:async()=>({markdown:JSON.stringify(saved)})},tasks:{list:async()=>[task]},artifacts:{get:async()=>artifact},records:{get:async()=>record}}
 return {api,group,task,artifact,record,saved}
}
test('版本化协作说明校验业务、群、唯一步骤及真实依赖端点',()=>{
 const b=brief();assert.equal(readTeamBrief(JSON.stringify(b),scope,groupId).summary,'限定交付')
 assert.throws(()=>readTeamBrief(JSON.stringify(b),'other',groupId))
 assert.throws(()=>readTeamBrief(JSON.stringify({...b,handoffs:[{from:'analysis',to:'missing',label:'交接'}]}),scope,groupId))
 assert.throws(()=>readTeamBrief(JSON.stringify({...b,steps:[...b.steps,b.steps[0]]}),scope,groupId))
})
test('从原生身份与固定成果投影，待采用跟随当前记录变化而更新',async()=>{
 const f=fixture(),load=()=>loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never)
 let result=await load();assert.equal(result[0]?.phase,'ready');assert.equal(result[0]?.decisions.length,1)
 f.record.fields[0]!.value='已采用';result=await load();assert.equal(result[0]?.decisions.length,0)
 f.task.state='running';result=await load();assert.equal(result[0]?.steps[0]?.task.state,'running')
})
test('同ID跨业务任务和成果不可透出，失败不能变成空闲或通过',async()=>{
 const f=fixture();f.task.scope='another';let result=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never)
 assert.equal(result[0]?.phase,'failed');assert.equal(result[0]?.steps.length,0)
 f.task.scope=scope;f.artifact.versions[0]!.source.scope='another';result=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never)
 assert.equal(result[0]?.phase,'failed')
})
test('质量意见必须来自不同作者的固定任务且明确指向被审成果',async()=>{
 const f=fixture();f.saved.reviews.push({roleId,taskId,artifact:{id:artifactId,version:1},label:'接受',reviewed:[{id:artifactId,version:1}]} as never)
 const result=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never);assert.equal(result[0]?.phase,'failed')
})
test('未配置、撤回、API失败与读取中止保留区别',async()=>{
 const f=fixture();f.api.groups.resources=async()=>({items:[]});let result=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never);assert.equal(result[0]?.phase,'unconfigured')
 f.api.groups.resources=async()=>{throw Error('offline')};result=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never);assert.equal(result[0]?.phase,'failed')
 const c=new AbortController();c.abort();await assert.rejects(()=>loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never,c.signal),/abort/i)
})
test('本人采用/退回保存原生审批记录，冻结对象版本；过期对象拒绝，重试沿原请求身份',async()=>{
 const f=fixture();Object.assign(f.record,{snapshotHash:'a'.repeat(64)});const writes:unknown[]=[]
 const policy={reviewType:'owner-review'},api={...f.api.records,create:async(v:unknown)=>{writes.push(v);return {scope,type:'owner-review',id:uid(9),version:1,fields:(v as {fields:{name:string;value:string}[]}).fields.map(x=>({label:x.name,value:x.value}))}}}
 const result=await submitTeamDecision(api as never,f.record as never,policy,'changes','补充后端证据',uid(10))
 assert.equal(result.version,1);assert.match(JSON.stringify(writes),/补充后端证据/);assert.equal((writes[0] as {fields:{name:string;value:string}[]}).fields.find(f=>f.name==='subject')?.value,teamDecisionSubject(f.record as never))
 f.record.version++;await assert.rejects(()=>submitTeamDecision(api as never,{...f.record,version:7} as never,policy,'accepted','',uid(10)),/版本|version/);assert.equal(writes.length,1)
})
test('在岗任务只按真实群归属展示，包含非协调员工，不混入同协调者的其他群任务',async()=>{
 const f=fixture();Object.assign(f.group,{coordinatorRoleId:roleId});
 const own={...f.task,id:uid(30),groupId,assigneeRoleId:uid(31),state:'running'},other={...f.task,id:uid(32),groupId:uid(33),state:'ready'},ungrouped={...f.task,id:uid(34),state:'ready'};
 f.api.tasks.list=async()=>[f.task,own,other,ungrouped];
 const [team]=await loadBusinessTeamCollaboration(scope,[f.group] as never,f.api as never);assert.equal(team?.phase,'ready');assert.deepEqual(team?.activeTasks.map(t=>t.id),[own.id]);
})

test('审阅历史跳转携带完整固定引用，使用正式记录页而非旧台账',()=>{
 const record={scope:'test-business',type:'owner-review',id:uid(40),version:2,snapshotHash:'a'.repeat(64)};const target=teamRecordTarget({...record,title:'完整原生记录',summary:'本人意见',fields:[],deletedAt:null} as never)
 assert.equal(target.section,'data');assert.deepEqual(target.recordReference,record);assert.equal(target.objectType,record.type)
})
