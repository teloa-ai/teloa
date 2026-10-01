import test from 'node:test'
import assert from 'node:assert/strict'
import {brandString} from '@deepseek-ai/dsh-brand'
import {createSnapshotStore} from '@deepseek-ai/dsh-client-store'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {ISessions,SessionListState,SessionSummary} from '@deepseek-ai/dsh-api-session-controller/client'
import {isNativeChildSession,observeMainSessionBinding} from '../src/client/main-session.ts'

const child=brandString<SessionId>('child'),parent=brandString<SessionId>('parent')
function fixture(){
  const list=createSnapshotStore<SessionListState>({ids:[],byId:{},phase:'ready',projectionsBySession:{}})
  const addresses=new Map<SessionId,ReturnType<ISessions['subagentAddress']>>()
  const sessions={list,subagentAddress:(id:SessionId)=>addresses.get(id)}
  const summary=(id:SessionId,extra:Partial<SessionSummary>={}):SessionSummary=>({id,displayTitle:id,running:false,blank:false,updatedAt:1,retainedBy:{},...extra})
  const publish=(rows:SessionSummary[])=>list.set({ids:rows.map(row=>row.id),byId:Object.fromEntries(rows.map(row=>[row.id,row])),phase:'ready',projectionsBySession:{}})
  return {sessions,addresses,summary,publish}
}

test('原生直接父地址或持久子会话来源免于普通绑定，分支 parentId 不代表执行助手',()=>{
  const f=fixture()
  f.publish([f.summary(child,{parentId:parent})])
  assert.equal(isNativeChildSession(f.sessions,child),false)
  f.addresses.set(child,{parentSessionId:parent,childSessionId:child,mode:'continuable'})
  assert.equal(isNativeChildSession(f.sessions,child),true)
  f.addresses.clear()
  f.publish([f.summary(child,{origin:'subagent',parentId:parent})])
  assert.equal(isNativeChildSession(f.sessions,child),true)
  assert.equal(isNativeChildSession(f.sessions,parent),false)
})

test('保持同一视图时原生子会话元数据到达仍重新分流，无关目录更新不重绑',()=>{
  const f=fixture(),main=createSnapshotStore<SessionId|undefined>(child)
  const selected:Array<{id:string|undefined;nativeChild:boolean}>=[]
  const stop=observeMainSessionBinding(main,f.sessions,{select:async id=>{selected.push({id,nativeChild:id!==undefined&&isNativeChildSession(f.sessions,brandString<SessionId>(id))})}})
  f.publish([f.summary(child,{origin:'subagent'})])
  f.publish([f.summary(child,{origin:'subagent',title:'alpha'})])
  main.set(parent)
  assert.deepEqual(selected,[{id:'child',nativeChild:false},{id:'child',nativeChild:true},{id:'parent',nativeChild:false}])
  stop()
  assert.deepEqual(selected.at(-1),{id:undefined,nativeChild:false})
  main.set(child)
  f.publish([])
  assert.equal(selected.length,4)
})
