import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {groupModelNoVisionNotice} from '@teloa/backend'
import {createTaskRunGroupPublisher as createPublisher} from '../src/task-run-group-publisher.ts'
// 单元端口的默认回执不访问数据库；持久写入另由真实 PG 集成用例覆盖。
const createTaskRunGroupPublisher=(ports:Omit<Parameters<typeof createPublisher>[0],'failure'>&Partial<Pick<Parameters<typeof createPublisher>[0],'failure'>>)=>createPublisher({failure:async()=>{},...ports})

const run={id:'11111111-1111-4111-8111-111111111111',nativeRequestId:'22222222-2222-4222-8222-222222222222'} as TaskRun

test('群回传固定运行和原生请求身份',async()=>{
 const sent:unknown[]=[]
 await createTaskRunGroupPublisher({post:async input=>{sent.push(input)},report:()=>{throw Error('不应报告')}})(run,'完成')
 assert.deepEqual(sent,[{requestId:run.nativeRequestId,runId:run.id,text:'完成'}])
})

test('授权变化只记录回传未写入，不把已结束运行重新判成失败',async()=>{
 const reports:string[]=[]
 for(const code of ['teloa/forbidden','teloa/conflict','teloa/version-conflict'] as const){
  await createTaskRunGroupPublisher({post:async()=>{throw new WorkError(code,'denied')},report:value=>reports.push(value)})(run,'完成')
 }
 assert.deepEqual(reports,['teloa/forbidden','teloa/conflict','teloa/version-conflict'])
})

test('存储或连接故障必须上抛给运行观察循环',async()=>{
 await assert.rejects(createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/dependency-unavailable','offline')},report:()=>{throw Error('不应报告')}})(run,'完成'),{code:'teloa/dependency-unavailable'})
})

test('回帖失败先保存持久回执；回执保存失败不能清掉声明或假装交付已处理',async()=>{
 const failures:unknown[]=[],cleared:string[]=[]
 const publish=createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/version-conflict','denied')},failure:async(current,code)=>{failures.push([current.id,code])},clear:()=>{cleared.push('clear')},report:()=>{}})
 await publish(run,'完成')
 assert.deepEqual(failures,[[run.id,'teloa/version-conflict']]);assert.deepEqual(cleared,['clear'])
 await assert.rejects(createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/forbidden','denied')},failure:async()=>{throw Error('receipt unavailable')},clear:()=>{cleared.push('lost')},report:()=>{}})(run,'完成'),/receipt unavailable/)
 assert.deepEqual(cleared,['clear'])
 const retrying:unknown[]=[]
 await assert.rejects(createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/dependency-unavailable','offline')},failure:async(current,code)=>{retrying.push([current.id,code])},report:()=>{}})(run,'完成'),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(retrying,[[run.id,'teloa/dependency-unavailable']])
})

// ---- 群附件一期：声明文件与无视觉前置句（T10）----

const groupRun={...run,sessionId:'run-session'} as TaskRun
const claim={path:'out/report.md',sha256:'a'.repeat(64)}

test('登记的声明文件随回帖一起交给服务端，回帖成功后登记表清空',async()=>{
 const sent:unknown[]=[],cleared:string[][]=[]
 let files=[claim]
 await createTaskRunGroupPublisher({
  post:async input=>{sent.push(input)},
  run:()=>({files,noVision:false}),
  clear:(sessionId,requestId)=>{cleared.push([sessionId,requestId]);files=[]},
  report:()=>{throw Error('不应报告')},
 })(groupRun,'完成')
 assert.deepEqual(sent,[{requestId:groupRun.nativeRequestId,runId:groupRun.id,text:'完成',files:[claim]}])
 assert.deepEqual(cleared,[['run-session',groupRun.nativeRequestId]])
})

test('没有声明文件时入参不带 files 键，与本次变更之前逐字相同',async()=>{
 const sent:unknown[]=[]
 await createTaskRunGroupPublisher({post:async input=>{sent.push(input)},run:()=>({files:[],noVision:false}),clear:()=>{},report:()=>{throw Error('不应报告')}})(groupRun,'完成')
 assert.deepEqual(sent,[{requestId:groupRun.nativeRequestId,runId:groupRun.id,text:'完成'}])
})

test('本轮图片没进模型时由宿主前置固定文案，不由模型自陈',async()=>{
 const sent:Array<{text:string}>=[]
 await createTaskRunGroupPublisher({post:async input=>{sent.push(input as {text:string})},run:()=>({files:[],noVision:true}),clear:()=>{},report:()=>{throw Error('不应报告')}})(groupRun,'模型正文')
 assert.equal(sent[0]!.text,`${groupModelNoVisionNotice}\n\n模型正文`)
 assert.equal(sent[0]!.text.startsWith('【本轮模型没有读图能力'),true)
})

test('空白模型结果不能只靠未读图说明冒充回复；清单不可读也不能静默改成纯文字',async()=>{
 const sent:unknown[]=[],failures:string[]=[]
 const ports={post:async(input:unknown)=>{sent.push(input)},failure:async(_run:TaskRun,code:string)=>{failures.push(code)},report:()=>{}}
 await createTaskRunGroupPublisher({...ports,run:async()=>({files:[claim],noVision:true})})(groupRun,'  \n ')
 assert.deepEqual(sent,[]);assert.deepEqual(failures,['teloa/invalid-input'])
 await assert.rejects(createTaskRunGroupPublisher({...ports,run:async()=>{throw new WorkError('teloa/dependency-unavailable','offline')}})(groupRun,'完成'),{code:'teloa/dependency-unavailable'})
 await createTaskRunGroupPublisher({...ports,run:async()=>{throw new WorkError('teloa/storage-corrupt','corrupt')}})(groupRun,'完成')
 assert.deepEqual(sent,[]);assert.deepEqual(failures,['teloa/invalid-input','teloa/dependency-unavailable','teloa/storage-corrupt'])
})

test('授权变化只记录并清空登记表；存储故障上抛时登记表保留，重试仍带同一组文件',async()=>{
 const cleared:string[][]=[]
 await createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/forbidden','denied')},run:()=>({files:[claim],noVision:false}),clear:(a,b)=>{cleared.push([a,b])},report:()=>{}})(groupRun,'完成')
 assert.equal(cleared.length,1)
 await assert.rejects(createTaskRunGroupPublisher({post:async()=>{throw new WorkError('teloa/dependency-unavailable','offline')},run:()=>({files:[claim],noVision:false}),clear:()=>{cleared.push(['不应清空','不应清空'])},report:()=>{}})(groupRun,'完成'),{code:'teloa/dependency-unavailable'})
 assert.equal(cleared.length,1)
})


test('计划汇报按固定发生实例去重，不使用可重开的原生请求身份',async()=>{
 const sent:unknown[]=[],occurrenceId='33333333-3333-4333-8333-333333333333'
 const planRun={...run,inputText:JSON.stringify({planContext:{occurrenceId,reportGroup:{groupId:'group'}}})}
 await createTaskRunGroupPublisher({post:async input=>{sent.push(input)},report:()=>{}})(planRun,'计划结果')
 assert.deepEqual(sent,[{requestId:occurrenceId,runId:run.id,text:'计划结果'}])
})
