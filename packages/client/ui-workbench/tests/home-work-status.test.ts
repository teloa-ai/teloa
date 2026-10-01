import assert from 'node:assert/strict'
import test from 'node:test'
import {readHomeWorkStatus,changeHomeWorkStatus} from '../src/client/home-work-status.ts'
const status={requestId:'r',sessionId:'s',title:'核对',scope:'SOC',stoppedAt:null,members:[{roleId:'employee',name:'同事',scope:'SOC',status:'waiting',task:{id:'task',title:'实际任务'}}]}
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
