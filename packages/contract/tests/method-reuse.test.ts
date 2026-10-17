import test from 'node:test'
import assert from 'node:assert/strict'
import {readPageCreateBody,assertPageCreateNoCredentialKeys,assertNoCredentialKeys} from '../src/page-create.ts'
import {readMethodReuseSource,readMethodReuseAcceptedSource,readMethodReuseIntent,methodReuseReference,readMethodReuseReference,methodReuseBasisHash} from '../src/method-reuse.ts'
import {readWorkBudgetPolicy} from '../src/work-budget.ts'
const id='12345678-1234-4234-8234-123456789abc'
const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
const work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:9,maxTokens:65536,maxElapsedMs:300000,maxConcurrent:1,maxRetries:1,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
const source={artifactId:id,version:1,basisHash:'a'.repeat(64)}
const definition={title:'每日核对',goal:'按认可的方法核对本人材料',scope:'general',dataScope:'本人明确提供',delivery:'有依据的核对结果',roleId:null,executor:{kind:'owner'},trigger:schedule,notificationPolicy:'attention'}

test('工作额度允许明确零重试，其余上限仍须正整数且不转换字符串',()=>{
 const budget={...work.budget,maxRetries:0}
 assert.equal(readWorkBudgetPolicy(budget).maxRetries,0)
 for(const patch of [{maxRetries:-1},{maxRetries:'0'},{maxTokens:0},{maxGoalRounds:0},{maxElapsedMs:0},{maxConcurrent:0},{stagnationRounds:0}])assert.throws(()=>readWorkBudgetPolicy({...budget,...patch}),{code:'teloa/invalid-input'})
 assert.equal(budget.maxRetries,0)
})

test('plan草稿严格解析owner创建、默认暂停，不把草稿状态或grant当本人授权',()=>{
 const input={definition,work,source}
 const saved=readPageCreateBody('plan' as never,input) as Record<string,unknown>
 assert.equal(saved.intent,'save-paused')
 assert.deepEqual(saved.definition,definition)
 assert.deepEqual(saved.source,source)
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,approved:true}),{code:'teloa/invalid-input'})
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,definition:{...definition,executor:{kind:'owner',grantId:id}}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,work:{...work,triggers:[{kind:'local-event',eventKind:'group-message',sourceId:id,coalesce:'latest'}]}}),{code:'teloa/invalid-input'})
})

test('已有计划配置草稿保精确CAS与原触发策略，不假称来自方法成果',()=>{
 const input={kind:'configure-work',planId:id,expectedVersion:3,expectedConfigVersion:2,work,intent:'save-paused',fields:{title:'固定计划',goal:'只读核对更新后的材料',dataScope:'本人提供的材料',delivery:'有依据的结果'}}
 assert.deepEqual(readPageCreateBody('plan' as never,input),input)
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,source}),{code:'teloa/invalid-input'})
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,expectedVersion:0}),{code:'teloa/invalid-input'})
 assert.throws(()=>readPageCreateBody('plan' as never,{...input,fields:{roleId:id}}),{code:'teloa/invalid-input'})
})

test('Markdown原命令可明确保存，引用代码与资料条件不授予或吞掉本人意图',()=>{
 assert.equal(readMethodReuseIntent('# 方法复用\n将这份成果保存为方法。','skill'),'save-paused')
 assert.equal(readMethodReuseIntent('> 将这份成果保存为方法。','skill'),null)
 assert.equal(readMethodReuseIntent('```text\n将这份成果保存为计划，并启用。\n```','plan'),null)
 assert.equal(readMethodReuseIntent('将这份成果保存为方法，失败时如果资料不足请停下。','skill'),'save-paused')
 assert.equal(readMethodReuseIntent('将这份成果保存为计划，不要启用。','plan'),'save-paused')
 assert.equal(readMethodReuseIntent('将“这份成果”保存为计划，并启用。','plan'),'create-and-enable')
 assert.equal(readMethodReuseIntent('请看引用：“将这份成果保存为计划，并启用”。','plan'),null)
 assert.equal(readMethodReuseIntent('将这份成果保存为计划。\n示例：并启用。','plan'),'save-paused')
 assert.equal(readMethodReuseIntent('Please save this result as a plan, do not enable it.','plan'),'save-paused')
 assert.equal(readMethodReuseIntent('Please save this result as a plan and enable it.','plan'),'create-and-enable')
 assert.equal(readMethodReuseIntent('将这份成果暂不保存为方法。','skill'),null)
 assert.equal(readMethodReuseIntent('Please save this result as a plan and do not enable it.','plan'),'save-paused')
 assert.equal(readMethodReuseIntent('不要将这份成果保存为方法。','skill'),null)
 assert.equal(readMethodReuseIntent('如果有用，将这份成果保存为方法。','skill'),null)
})

test('方法来源和受理消息严格固定身份，成果摘要忽略界面时间但绑定真实正文',async()=>{
 assert.deepEqual(readMethodReuseSource(source),source)
 assert.throws(()=>readMethodReuseSource({...source,accepted:true}),{code:'teloa/invalid-input'})
 const accepted={sessionId:'native-chat',messageId:'message-one',messageSeq:0,requestId:id}
 assert.deepEqual(readMethodReuseAcceptedSource(accepted),accepted)
 assert.throws(()=>readMethodReuseAcceptedSource({...accepted,messageSeq:-1}),{code:'teloa/invalid-input'})
 const basis={source:{kind:'session' as const,id:'native-chat',scope:'general',version:'conversation-one',title:'原来源'},content:{title:'固定成果',sections:[{id:'one',title:'方法',text:'只核对本人资料'}],snapshotIds:[],note:'合成来源，仅供边界验证'}}
 const first=await methodReuseBasisHash(basis)
 assert.match(first,/^[a-f0-9]{64}$/)
 assert.equal(await methodReuseBasisHash({...basis,createdAt:'2099-01-01T00:00:00.000Z'} as typeof basis),first)
 assert.notEqual(await methodReuseBasisHash({...basis,content:{...basis.content,note:'另一个版本'}}),first)
})

test('共享成果引用忽略代码和引文，拒绝多来源，不要求本人手输UUID',()=>{
 assert.equal(methodReuseReference(source),'[teloa-method-source:'+id+':v1]')
 assert.deepEqual(readMethodReuseReference('将这份成果保存为方法。\n'+methodReuseReference(source)),{artifactId:id,version:1})
 assert.equal(readMethodReuseReference('```\n'+methodReuseReference(source)+'\n```'),null)
 assert.equal(readMethodReuseReference('> '+methodReuseReference(source)),null)
 assert.equal(readMethodReuseReference('“'+methodReuseReference(source)+'”'),null)
 assert.equal(readMethodReuseReference(methodReuseReference(source)+'\n'+methodReuseReference({...source,version:2})),null)
})

test('正式计划额度数值不冒凭据，未知或字符串令牌不能借预算例外通过',()=>{
 const plan={definition,work,source}
 assert.doesNotThrow(()=>assertPageCreateNoCredentialKeys('plan',plan))
 assert.throws(()=>assertPageCreateNoCredentialKeys('plan',{...plan,work:{...work,budget:{...work.budget,apiKey:'private'}}}),{code:'teloa/invalid-input'})
 assert.throws(()=>assertPageCreateNoCredentialKeys('plan',{...plan,work:{...work,budget:{...work.budget,maxTokens:'private'}}}),{code:'teloa/invalid-input'})
 assert.throws(()=>assertNoCredentialKeys({maxTokens:65536}),{code:'teloa/invalid-input'})
})

test('繁體儲存與計畫沿同一明確意圖規則，保留不啟用的本人限制',()=>{
 assert.equal(readMethodReuseIntent('請將這份成果儲存為方法，先儲存，不啟用。','skill'),'save-paused')
 assert.equal(readMethodReuseIntent('請將這份成果儲存為計畫，並啟用。','plan'),'create-and-enable')
 assert.equal(readMethodReuseIntent('請不要將這份成果儲存為計畫。','plan'),null)
})

test('并列否定启用不被正向连接词反转为启用授权',()=>{
 assert.equal(readMethodReuseIntent('将这份成果保存为计划，并不要启用。','plan'),'save-paused')
 assert.equal(readMethodReuseIntent('Please save this result as a plan, and do not enable it.','plan'),'save-paused')
})

test('计划配置fields省略保原目标；提供则须完整四项，不保存无法采用的partial',()=>{
 const base={kind:'configure-work',planId:id,expectedVersion:3,expectedConfigVersion:2,work,intent:'save-paused'}
 assert.deepEqual(readPageCreateBody('plan',base),base)
 const fields={title:'固定核对计划',goal:'核对本人新材料',dataScope:'本人本轮提供的材料',delivery:'说明证据与未知',groupId:null}
 assert.deepEqual(readPageCreateBody('plan',{...base,fields}),{...base,fields})
 assert.throws(()=>readPageCreateBody('plan',{...base,fields:{goal:'只有目标'}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readPageCreateBody('plan',{...base,fields:{}}),{code:'teloa/invalid-input'})
})
