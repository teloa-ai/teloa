import test from 'node:test'
import assert from 'node:assert/strict'
import type {Conversation} from '@teloa/contract'
import {blankNewConversation,conversationAtLocation,draftCarry,moveTextDraft,readBlankNewConversation,rememberBlankNewConversation,type DraftInputPort} from '../src/client/blank-conversation-draft.ts'

const memory=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}}
const row=(sessionId:string,patch:Partial<Conversation>={}):Conversation=>({id:'c-'+sessionId,ownerId:'o',title:'新工作会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:'2026-10-15T00:00:00.000Z',...patch})
type State=ReturnType<DraftInputPort['state']['getSnapshot']>
const state=(patch:Partial<State>={}):State=>({draft:'',attachmentIds:[],draftRev:0,phase:'plain',occurrences:[],queue:[],...patch} as unknown as State)
const input=(initial:State)=>{
  let snapshot=initial
  const calls={submit:0,notices:[] as string[]}
  const port:DraftInputPort&{calls:typeof calls}={calls,state:{getSnapshot:()=>snapshot},setDraft:text=>{snapshot={...snapshot,draft:text}},notify:(_level,text)=>{calls.notices.push(text)}}
  return port
}

test('只记左栏新建空白会话的身份与业务语境，损坏记录按无记录处理',()=>{
  const storage=memory()
  assert.equal(readBlankNewConversation(storage),undefined)
  rememberBlankNewConversation(storage,{sessionId:'s1',scope:'sales'})
  assert.deepEqual(readBlankNewConversation(storage),{sessionId:'s1',scope:'sales'})
  storage.setItem('teloa.blank-new-conversation/v1','{bad')
  assert.equal(readBlankNewConversation(storage),undefined)
  rememberBlankNewConversation(storage,undefined)
  assert.equal(storage.getItem('teloa.blank-new-conversation/v1'),null)
  // 存储写失败不抛出，不把已成功的创建变成失败
  const broken={getItem:()=>null,setItem:()=>{throw Error('QuotaExceededError')},removeItem:()=>{throw Error('denied')}}
  assert.doesNotThrow(()=>rememberBlankNewConversation(broken,{sessionId:'s1'}))
  assert.doesNotThrow(()=>rememberBlankNewConversation(broken,undefined))
})

test('只重开仍未开始、未归档、语境一致的普通会话；已有历史、助手与运行会话一律不复用',()=>{
  const base={rows:[row('s1')],archived:[] as string[],blank:(id:string)=>id==='s1'?true:undefined}
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'}})?.sessionId,'s1')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},scope:'sales'}),undefined,'业务语境不同')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},blank:()=>false}),undefined,'已开始的历史会话')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},blank:()=>undefined}),undefined,'未核实是否空白')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},archived:['s1']}),undefined,'已归档')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},rows:[row('s1',{purpose:'assistant'})]}),undefined,'助手主聊')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'s1'},rows:[row('s1',{status:'pending'})]}),undefined,'仍待创建')
  assert.equal(blankNewConversation({...base,entry:{sessionId:'gone'}}),undefined,'目录里已不存在')
  assert.equal(blankNewConversation({...base,entry:undefined}),undefined)
})

test('执行位置按创建时位置或原生登记归属判断，同一位置不另建',()=>{
  const workspaces=[{workspaceId:'w1',sessionIds:['s1']},{workspaceId:'w2',sessionIds:[]}]
  assert.equal(conversationAtLocation(row('s1',{requestedWorkspaceId:'w1'}),'w1',workspaces),true)
  assert.equal(conversationAtLocation(row('s1'),'w1',workspaces),true,'缺省创建位置按原生登记归属')
  assert.equal(conversationAtLocation(row('s1'),undefined,workspaces),true,'都用默认位置')
  assert.equal(conversationAtLocation(row('s1',{requestedWorkspaceId:'w1'}),'w2',workspaces),false)
})

test('草稿只在纯文本时迁移；引用、附件、排队或提交中都保留在原会话',()=>{
  assert.equal(draftCarry(state()),'empty')
  assert.equal(draftCarry(state({draft:'草稿'})),'text')
  assert.equal(draftCarry(state({draft:'看 @a',occurrences:[{} as never]})),'structured')
  assert.equal(draftCarry(state({attachmentIds:['f1' as never]})),'structured')
  assert.equal(draftCarry(state({draft:'草稿',phase:'submitting'})),'busy')
  assert.equal(draftCarry(state({queue:[{} as never]})),'busy')
})

test('纯文本原样带到新会话并核对后才清空来源，从不提交',()=>{
  const source=input(state({draft:'E2E 新建会话草稿'})),target=input(state())
  moveTextDraft(source,target)
  assert.equal(target.state.getSnapshot().draft,'E2E 新建会话草稿')
  assert.equal(source.state.getSnapshot().draft,'')
  assert.equal(source.calls.submit+target.calls.submit,0)
})

test('目标已有内容或未接受写入时不清空来源',()=>{
  const source=input(state({draft:'原草稿'})),occupied=input(state({draft:'别的'}))
  assert.throws(()=>moveTextDraft(source,occupied))
  assert.equal(source.state.getSnapshot().draft,'原草稿')
  assert.equal(occupied.state.getSnapshot().draft,'别的')
  const refusing:DraftInputPort={state:{getSnapshot:()=>state()},setDraft:()=>{},notify:()=>{}}
  assert.throws(()=>moveTextDraft(source,refusing))
  assert.equal(source.state.getSnapshot().draft,'原草稿')
  const structured=input(state({draft:'看 @a',occurrences:[{} as never]}))
  assert.throws(()=>moveTextDraft(structured,input(state())))
  assert.equal(structured.state.getSnapshot().draft,'看 @a')
})
