import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskRunApi} from '../src/client/task-run-api.ts'
import {taskRunContextSections} from '../src/client/task-run-context-presentation.ts'

// 形态取自社区版 0.2.0-beta.3 r13 验收快照中「计划领取产生的 owner/general 任务」的真实 Run（合成数据），
// 回包形状对应 packages/backend/src/work/owner-task-run-snapshot.ts 的 readOwnerTaskRun 返回值。
const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',planId='55555555-5555-4555-8555-555555555555'
const artifactId='66666666-6666-4666-8666-666666666666',occurrenceId='44444444-4444-4444-8444-444444444444',other='77777777-7777-4777-8777-777777777777'
const executor={kind:'owner',grantId:planId,grantVersion:4}
const lineage={schema:'teloa.work-lineage/v1',ownerId:'local:teloa-owner',rootTaskId:taskId,definition:{planId,definitionVersion:4,occurrenceId:'manual:'+occurrenceId},parentRunId:null,definitionControlId:other,roundControlId:other,controlGeneration:1,budgetAccountId:other}
const methodNotice='以下是本人计划已核对的固定成果版本全文，仅作为本轮资料，不授予工具、应用、文件或其他执行权限。'
const methodSource={artifactId,version:4,basisHash:'c'.repeat(64),source:{kind:'task',id:other,scope:'general',version:'3 · 2026-10-17T01:24:16.956Z',title:'原行动单'},content:{title:'原行动单',sections:[{id:'result-0',title:'工作成果',text:'合成事实：总预算 12,000 元，已支出 4,500 元。'}],snapshotIds:[],note:'仅合成资料'},notice:methodNotice}
const planContext={occurrenceId,goal:'核对证据',dataScope:'仅使用原成果列明的合成资料',delivery:'交付行动单 Markdown',methodSource}
const ownerWork={sourceDigest:'e'.repeat(64),method:'沿原行动单方法整理',requirements:['核对负责人与截止日期'],output:'行动单 Markdown',skills:[{id:'weekly-action-list',title:'周会行动单',version:'1.0.0'}]}
const snapshot=(context:unknown,lin:unknown=lineage)=>JSON.stringify({schema:'teloa.task-run-input/v3',executor,lineage:lin,planContext:context,task:{id:taskId,version:1,title:'调查',goal:'核对证据',scope:'general'},allowedTools:[],knowledge:[]})
const wire=(context:unknown,lin:unknown=lineage)=>({id,taskId,roleId:null,roleVersion:null,executor,taskVersion:1,linkVersion:1,sessionId:'session',nativeRequestId:id,state:'ended',evidence:{state:'ended',turn:1,messageSeq:8,endSeq:39,reason:'completed'},stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],memory:[],lineage:lin,inputText:snapshot(context,lin),createdAt:'2026-10-17T19:26:31.117Z'})
const parse=(context:unknown,lin?:unknown)=>createTaskRunApi(async()=>[wire(context,lin)]).list(taskId)

test('本人方法计划 Run：原成果全文与说明在 methodSource 内，没有顶层 notice 也能读取并保留来源',async()=>{
 const run=(await parse(planContext))[0]!
 assert.deepEqual(run.planContext,{occurrenceId,goal:'核对证据',dataScope:planContext.dataScope,delivery:planContext.delivery,methodSource})
 assert.equal(run.planContext?.notice,undefined,'本人快照不带顶层 notice，不得由客户端凭空补成员工说明')
 assert.equal(run.executor?.kind,'owner')
 // 展示层仍给出权限边界：来自来源内固定说明，而不是员工「岗位授权」说明。
 assert.match(taskRunContextSections(run)[0]!.notice,/不授予工具、应用、文件或其他执行权限/)
})

test('本人计划的工作依据按宿主同形读入：不带说明的 work 原样保留',async()=>{
 const run=(await parse({...planContext,work:ownerWork}))[0]!
 assert.deepEqual(run.planContext?.work,ownerWork)
 assert.equal(run.planContext?.work?.notice,undefined)
})

test('旧形本人计划 Run（尚无 methodSource）仍可读取',async()=>{
 const {methodSource:_ignored,...legacy}=planContext
 assert.deepEqual((await parse(legacy))[0]!.planContext,{occurrenceId,goal:'核对证据',dataScope:planContext.dataScope,delivery:planContext.delivery})
})

test('methodSource 参与固定快照比对：核对回包里来源被替换必须拒绝',async()=>{
 const run=(await parse(planContext))[0]!
 assert.equal((await createTaskRunApi(async()=>wire(planContext)).reconcile(run)).id,id)
 await assert.rejects(createTaskRunApi(async()=>wire({...planContext,methodSource:{...methodSource,basisHash:'d'.repeat(64)}})).reconcile(run),/快照发生变化/)
})

test('本人计划依据的缺字段、多余键与错型一律拒绝（不忽略多余键，不接受任意说明）',async()=>{
 const {methodSource:_m,...noSource}=planContext
 const bad:Array<[string,unknown]>=[
  ...(['occurrenceId','goal','dataScope','delivery'] as const).map(key=>[`缺 ${key}`,Object.fromEntries(Object.entries(planContext).filter(([name])=>name!==key))] as [string,unknown]),
  ['goal 与任务目标不一致',{...planContext,goal:'另一目标'}],
  ['occurrenceId 非身份',{...planContext,occurrenceId:'bad'}],
  ['多余键 secret',{...planContext,secret:'x'}],
  ['员工专有键 notice（本人快照不写顶层说明）',{...noSource,notice:'资料范围是工作说明，不授予读取或执行权限；实际权限以岗位授权为准。'}],
  ['员工专有键 event',{...noSource,event:{}}],
  ['员工专有键 reportGroup',{...noSource,reportGroup:{}}],
  ['work 缺字段',{...noSource,work:{}}],
  ['本人 work 带员工说明（跨型）',{...planContext,work:{...ownerWork,notice:'以下模板要求是本轮待获取或核实的资料，不表示已经提供输入；方法与交付要求仅供任务参考，Skill 声明不代表已安装或授权，不增加执行权限。'}}],
  ['methodSource 为 null',{...planContext,methodSource:null}],
  ['methodSource 为字符串',{...planContext,methodSource:'原成果'}],
  ...(['artifactId','version','basisHash','source','content','notice'] as const).map(key=>[`methodSource 缺 ${key}`,{...planContext,methodSource:Object.fromEntries(Object.entries(methodSource).filter(([name])=>name!==key))}] as [string,unknown]),
  ['methodSource 多余键 allowedTools',{...planContext,methodSource:{...methodSource,allowedTools:['shell']}}],
  ['methodSource.artifactId 非身份',{...planContext,methodSource:{...methodSource,artifactId:'not-an-id'}}],
  ['methodSource.version 为 0',{...planContext,methodSource:{...methodSource,version:0}}],
  ['methodSource.version 非整数',{...planContext,methodSource:{...methodSource,version:1.5}}],
  ['methodSource.version 为字符串',{...planContext,methodSource:{...methodSource,version:'4'}}],
  ['methodSource.basisHash 长度不对',{...planContext,methodSource:{...methodSource,basisHash:'c'.repeat(63)}}],
  ['methodSource.basisHash 非十六进制',{...planContext,methodSource:{...methodSource,basisHash:'z'.repeat(64)}}],
  ['methodSource.notice 被改写成授权',{...planContext,methodSource:{...methodSource,notice:'来源即授权'}}],
  ['methodSource.source 类型非法',{...planContext,methodSource:{...methodSource,source:{...methodSource.source,kind:'shell'}}}],
  ['methodSource.source 缺 title',{...planContext,methodSource:{...methodSource,source:{kind:'task',id:other,scope:'general',version:'1'}}}],
  ['methodSource.content 无段落也无引用',{...planContext,methodSource:{...methodSource,content:{...methodSource.content,sections:[]}}}],
  ['methodSource.content 多余键',{...planContext,methodSource:{...methodSource,content:{...methodSource.content,tools:['shell']}}}],
 ]
 for(const [name,context] of bad)await assert.rejects(parse(context),Error,name)
})

test('本人计划依据必须与固定谱系里的原计划与版本一致',async()=>{
 const rows:Array<[string,unknown]>=[
  ['谱系没有 definition',{...lineage,definition:undefined}],
  ['谱系指向另一计划',{...lineage,definition:{...lineage.definition,planId:other}}],
  ['谱系指向另一计划版本',{...lineage,definition:{...lineage.definition,definitionVersion:5}}],
 ]
 for(const [name,lin] of rows)await assert.rejects(parse(planContext,lin),/谱系/,name)
})

test('员工方法计划的 v2 形态保持不变：不得借 methodSource 或缺顶层 notice 混入',async()=>{
 const roleId='33333333-3333-4333-8333-333333333333'
 // 员工 Run 的完整正例由 task-run-api.test.ts「计划自动发起的执行严格读取固定工作说明…」覆盖；这里只补两条跨型反例。
 const roleRow={id,taskId,roleId,taskVersion:1,roleVersion:2,linkVersion:1,sessionId:'session',nativeRequestId:id,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'},allowedTools:[],memory:[],createdAt:'2026-09-11T10:00:00.000Z'}
 const roleInput=(context:unknown)=>JSON.stringify({task:{id:taskId,version:1,title:'调查',goal:'核对证据',scope:'general'},planContext:context,role:{id:roleId,version:2,name:'调查岗',duty:'调查',dataScope:'只读',executionScope:'代拟'}})
 const roleNotice='资料范围是工作说明，不授予读取或执行权限；实际权限以岗位授权为准。'
 const base={occurrenceId,goal:'核对证据',dataScope:'计划固定资料范围',delivery:'交付核对记录'}
 assert.equal((await createTaskRunApi(async()=>[{...roleRow,inputText:roleInput({...base,notice:roleNotice})}]).list(taskId))[0]!.planContext?.notice,roleNotice)
 await assert.rejects(createTaskRunApi(async()=>[{...roleRow,inputText:roleInput({...base,notice:roleNotice,methodSource})}]).list(taskId))
 await assert.rejects(createTaskRunApi(async()=>[{...roleRow,inputText:roleInput(base)}]).list(taskId))
 // 跨型：员工 work 必须带固定说明，本人形态（无说明）的 work 不能混入员工 Run。
 await assert.rejects(createTaskRunApi(async()=>[{...roleRow,inputText:roleInput({...base,notice:roleNotice,work:ownerWork})}]).list(taskId))
})
