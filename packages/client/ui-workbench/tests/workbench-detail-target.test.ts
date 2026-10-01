import test from 'node:test'
import assert from 'node:assert/strict'
import {openDetail,closeDetail,retainDetailForSession,activeDetailTarget,artifactDetailTarget,artifactPanelTarget,conversationLedgerNeeded,type WorkbenchDetailState,type WorkbenchDetailTarget} from '../src/client/workbench-detail-target.ts'
import type {ArtifactSourceRef} from '../src/client/artifact-preview.ts'
import {readFile} from 'node:fs/promises'

const closed:WorkbenchDetailState={open:false,target:null}
// 固定版本必须带成果身份，不能静默丢掉孤立的 version。
if(false){
 // @ts-expect-error 版本不能脱离成果 ID 存在。
 const invalid:WorkbenchDetailTarget={kind:'artifact',source:{kind:'task',id:'t1'},version:2}
 void invalid
}
test('打开新详情替换旧目标，关闭只改变呈现状态',()=>{
 const first=openDetail(closed,{kind:'directory-object',view:'tasks',id:'t0',source:{kind:'directory'}})
 const second=openDetail(first,{kind:'conversation-object',sessionId:'s2',objectKind:'task',id:'t1'})
 assert.equal(second.target?.kind,'conversation-object')
 assert.deepEqual(closeDetail(second),{open:false,target:second.target})
 assert.equal(closeDetail(second).target,second.target)
 assert.deepEqual(closed,{open:false,target:null})
})
test('所有详情目标只能占用唯一宿主，关闭后没有可呈现目标',()=>{
 const targets:WorkbenchDetailTarget[]=[
  artifactDetailTarget({kind:'session',id:'s1'},{id:'a1',version:3}),
  {kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'},
  {kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'data',id:'o1',objectType:'asset'}},
  {kind:'directory-object',view:'tasks',id:'t1',source:{kind:'attention'}},
 ]
 let state=closed
 for(const target of targets){state=openDetail(state,target);assert.equal(activeDetailTarget(state,'s1'),target);assert.equal(activeDetailTarget(closeDetail(state),'s1'),null)}
})
test('切换会话不呈现别人的详情，首帧也不得呈现旧会话成果',()=>{
 for(const target of [artifactDetailTarget({kind:'session',id:'s1'}),{kind:'conversation-object',sessionId:'s1',objectKind:'role',id:'r1'}] as WorkbenchDetailTarget[]){
  const state=openDetail(closed,target)
  assert.equal(retainDetailForSession(state,{},'s1').detail,state)
  assert.deepEqual(retainDetailForSession(state,{},'s2').detail,closed)
  assert.deepEqual(retainDetailForSession(closeDetail(state),{},undefined).detail,closed)
  assert.equal(activeDetailTarget(state,'s2'),null)
 }
})
test('页签是真源：会话往返后这个会话自己的详情回来，收起过的不再冒出来',()=>{
 const a:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'}
 const b:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s2',objectKind:'task',id:'t2'}
 // A 开着详情 → 切到 B：A 的详情记成种子，B 自己没有种子就摆空。
 const left=retainDetailForSession(openDetail(closed,a),{},'s2')
 assert.deepEqual(left.detail,closed)
 assert.deepEqual(left.seeds,{s1:a})
 // 在 B 开一个自己的详情，再切回 A：A 的详情原样回来，B 的也记下了。
 const back=retainDetailForSession(openDetail(left.detail,b),left.seeds,'s1')
 assert.deepEqual(back.detail,{open:true,target:a})
 assert.deepEqual(back.seeds,{s1:a,s2:b})
 assert.equal(activeDetailTarget(back.detail,'s1'),a)
 // A 里把详情收起来，再往返一次：种子一并销掉，不许自己又开回来。
 const closedInA=retainDetailForSession(closeDetail(back.detail),back.seeds,'s2')
 assert.deepEqual(closedInA.seeds,{s2:b})
 assert.deepEqual(retainDetailForSession(closedInA.detail,closedInA.seeds,'s1').detail,closed)
})
test('独立任务与业务成果不因无关会话变化清除，显式会话绑定不摆给别的会话',()=>{
 for(const source of [{kind:'task',id:'t1'},{kind:'analysis',id:'a1',scope:'SOC'},{kind:'object',id:'o1',scope:'SOC',objectType:'asset'},{kind:'run',id:'r1'}] as ArtifactSourceRef[]){
  const independent=openDetail(closed,artifactDetailTarget(source))
  const kept=retainDetailForSession(independent,{},'s2')
  assert.equal(kept.detail,independent)
  assert.deepEqual(kept.seeds,{},'不绑会话的详情不进种子本')
  assert.deepEqual(retainDetailForSession(openDetail(closed,artifactDetailTarget(source,undefined,'s1')),{},'s2').detail,closed)
 }
})
test('成果转换保留全部来源身份和固定版本，非成果目标不进成果面板',()=>{
 for(const source of [{kind:'session',id:'s1'},{kind:'task',id:'t1'},{kind:'run',id:'r1'},{kind:'analysis',id:'a1',scope:'SOC'},{kind:'object',id:'o1',scope:'SOC',objectType:'asset'}] as ArtifactSourceRef[]){
  assert.deepEqual(artifactPanelTarget(artifactDetailTarget(source,{id:'artifact-1',version:7})),{source,artifact:{id:'artifact-1',version:7}})
 }
 assert.equal(artifactPanelTarget({kind:'directory-object',view:'tasks',id:'t1',source:{kind:'directory'}}),null)
})

test('Frame 只从唯一目标呈现宿主，成果关闭保留目标与组件草稿',async()=>{
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 const panel=await readFile(new URL('../src/client/ArtifactPanel.tsx',import.meta.url),'utf8')
 assert.match(frame,/activeDetailTarget\(state\.detail,current\)/)
 assert.doesNotMatch(frame,/\[artifactTarget,setArtifactTarget\]|\[businessPanel,setBusinessPanel\]|\[objectPanelOpen,setObjectPanelOpen\]|state\.detailsOpen|state\.producedFile/)
 // 右栏是否占位改由 DSH 自己报上来的 rightbar 切片决定，不再借用详情目标表达呈现。
 assert.match(frame,/railShown&&css\.detailsOpen/)
 assert.doesNotMatch(frame,/railShown&&<div/)
 assert.match(frame,/open=\{artifactOpen\}/)
 assert.match(panel,/open = true/)
 assert.match(panel,/\[open, !!target\]/)
})

// 回归：刷新后落在会话页、页签由 state.detail 重开，而任务与岗位台账只在四个目录视图上装载，
// 结果页签标题退回「任务详情」、正文是一张「还没有任务」的空目录，且会话页此后不再装载。
test('会话页承载会话对象详情时要装载任务与岗位台账，别的视图与别的详情不触发',()=>{
 const task:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'}
 const role:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'role',id:'r1'}
 const space:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'overview'}}
 for(const target of [task,role,space])
  assert.equal(conversationLedgerNeeded('messages','native',openDetail(closed,target)),true,'三类会话对象都要台账：'+target.objectKind)
 // 收起了详情、群协作、别的视图、目录对象与成果都不该借这条路额外装载。
 assert.equal(conversationLedgerNeeded('messages','native',closeDetail(openDetail(closed,task))),false)
 assert.equal(conversationLedgerNeeded('messages','groups',openDetail(closed,task)),false)
 assert.equal(conversationLedgerNeeded('tasks','native',openDetail(closed,task)),false)
 assert.equal(conversationLedgerNeeded('messages','native',openDetail(closed,{kind:'directory-object',view:'tasks',id:'t1',source:{kind:'directory'}})),false)
 assert.equal(conversationLedgerNeeded('messages','native',openDetail(closed,artifactDetailTarget({kind:'session',id:'s1'}))),false)
 assert.equal(conversationLedgerNeeded('messages','native',closed),false)
})

test('Frame 的任务 / 岗位 / 安全待处理台账装载都接上会话页判据，刷新恢复的右栏页签才有内容可画',async()=>{
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/const conversationLedger=conversationLedgerNeeded\(state\.view,state\.messageMode,state\.detail\)/)
 for(const load of ['loadSecurityAttention','loadTasks','loadRoles']){
  // 判据要同时进条件与依赖：只改条件，装载不会因为详情打开而重跑。
  assert.match(frame,new RegExp("includes\\(state\\.view\\)\\|\\|conversationLedger\\)void "+load+"\\("),load+' 的装载条件没有接上会话页判据')
  assert.match(frame,new RegExp(load+"[^\\n]*\\},\\[state\\.view,conversationLedger,"),load+' 的依赖里缺会话页判据')
 }
})
