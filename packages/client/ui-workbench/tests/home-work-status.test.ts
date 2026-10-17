import assert from 'node:assert/strict'
import test from 'node:test'
import {readHomeWorkStatus,changeHomeWorkStatus} from '../src/client/home-work-status.ts'
const status={requestId:'r',sessionId:'s',title:'核对',scope:'SOC',stoppedAt:null,members:[{roleId:'employee',name:'同事',scope:'SOC',status:'waiting',task:{id:'task',title:'实际任务'}}]}
test('通用本人交办回流保留 owner 身份；空负责人不能冒充本人授权',()=>{
 const requestId='11111111-1111-4111-8111-111111111111',executor={kind:'owner',grantId:requestId,grantVersion:1},member={...status.members[0],roleId:null,executor,scope:'general'},current={...status,requestId,scope:'general',members:[member]}
 assert.equal(readHomeWorkStatus(current,'s').members[0]?.executor?.kind,'owner')
 for(const patch of [{executor:undefined},{executor:{...executor,grantId:'22222222-2222-4222-8222-222222222222'}},{scope:'SOC'},{roleId:'employee'}])assert.throws(()=>readHomeWorkStatus({...current,members:[{...member,...patch}]},'s'))
})
test('交办进度只接受工具源会话与原请求的真实成员和任务入口',()=>{
 assert.deepEqual(readHomeWorkStatus(status,'s').members[0]?.task,{id:'task',title:'实际任务'})
 assert.throws(()=>readHomeWorkStatus(status,'other'))
 assert.throws(()=>readHomeWorkStatus(status,'s','different'))
 assert.throws(()=>readHomeWorkStatus({...status,members:[{...status.members[0],task:{title:'无身份'}}]},'s'))
})
test('已准备运行的结构化状态保留原运行身份，不从原因文案推断',()=>{
 const member={...status.members[0],status:'failed',reason:'不同语言的岗位变化说明',run:{id:'original-run',state:'prepared'}}
 assert.deepEqual(readHomeWorkStatus({...status,members:[member]},'s').members[0]?.run,{id:'original-run',state:'prepared'})
 assert.throws(()=>readHomeWorkStatus({...status,members:[{...member,run:{state:'prepared'}}]},'s'))
 assert.throws(()=>readHomeWorkStatus({...status,members:[{...member,run:{id:'original-run',state:3}}]},'s'))
})
test('刷新、停止和续办始终使用卡片原session/request，拒绝错投回包',async()=>{
 const row=readHomeWorkStatus(status,'s'),calls:unknown[]=[]
 for(const action of ['status','stop','resume'] as const)await changeHomeWorkStatus(async(endpoint,payload)=>{calls.push([endpoint,payload]);return status},row,action)
 assert.deepEqual(calls,['status','stop','resume'].map(action=>['work-requests/'+action,{sessionId:'s',requestId:'r'}]))
 await assert.rejects(changeHomeWorkStatus(async()=>({...status,requestId:'new'}),row,'stop'))
})

test('进度读取保留正式任务状态、版本与固定续改来源，不把已结束运行当已结项',()=>{
 const artifactId='66666666-6666-4666-8666-666666666666'
 const member={...status.members[0],status:'received',task:{id:'task',title:'同名工作',state:'waiting',version:3},run:{id:'run',state:'ended',artifactRevision:{artifactId,baseVersion:1,title:'工作成果'}}}
 const result=readHomeWorkStatus({...status,members:[member]},'s').members[0]!
 assert.deepEqual(result.task,member.task)
 assert.deepEqual(result.run,member.run)
 assert.equal(result.status,'received','原工具状态保持供停止/重试协议使用')
 const completed=readHomeWorkStatus({...status,members:[{...member,task:{...member.task,state:'completed',version:4}}]},'s').members[0]!
 assert.equal(completed.task?.state,'completed')
 for(const revision of [{artifactId,baseVersion:0,title:'工作成果'},{artifactId:'foreign',baseVersion:1,title:'工作成果'}])assert.throws(()=>readHomeWorkStatus({...status,members:[{...member,run:{...member.run,artifactRevision:revision}}]},'s'))
})

test('旧进度无任务状态仍兼容，未知新状态不能伪装已完成',()=>{
 const legacy=readHomeWorkStatus(status,'s').members[0]!
 assert.deepEqual(legacy.task,{id:'task',title:'实际任务'})
 const future=readHomeWorkStatus({...status,members:[{...status.members[0],task:{id:'task',title:'实际任务',state:'future-state',version:1}}]},'s').members[0]!
 assert.equal(future.task?.state,'unknown')
 assert.throws(()=>readHomeWorkStatus({...status,members:[{...status.members[0],task:{id:'task',title:'实际任务',state:'completed',version:0}}]},'s'))
})
