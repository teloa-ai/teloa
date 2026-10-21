import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {groupRoutingOutputV2Schema,groupRoutingSessionId} from '@teloa/contract'
import {teloaAgentPresetId} from '../src/composition-safety.ts'
import {askGroupRouting,groupRoutingArchiveSource,type GroupRoutingAsk} from '../src/group-routing.ts'

// 3110 实跑：同群同日复用的路由会话里，模型从前几轮输入借用本轮已不在候选里的工作，把员工交接判成续办而解析失败。
const owner='11111111-1111-4111-8111-111111111111',groupId='22222222-2222-4222-8222-222222222222',rootId='44444444-4444-4444-8444-444444444444'
const roleA='55555555-5555-4555-8555-555555555555',day='2026-10-19'
const ask=(messageId:string):GroupRoutingAsk=>({groupId,groupName:'研判调查组',messageId,rootId,
 trigger:{authorKind:'self',authorId:'self',authorName:'本人',text:'@甲 请看',createdAt:'2026-10-19T05:00:00.000Z',mentions:[roleA]},
 topic:[],candidates:[{roleId:roleA,roleVersion:1,name:'甲',duty:'研判',triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}],hops:0})
const answer=JSON.stringify({schema:groupRoutingOutputV2Schema,intent:'reply',respond:[roleA],reactions:[],assignments:[],workTarget:null})

/** 带原生 surface 视图的会话替身：append 按 surfaceOp 维护视图节点，seq 与下标一致。 */
function harness(){
 const events:Array<{seq:number;type:string;surfaceOp?:unknown;sourceEventSeqs?:number[];data:any}>=[]
 const surface={nodes:[] as number[]}
 const appended:Array<{type:string;data:any;options:any}>=[]
 const append=(type:string,data:any,options:{surfaceOp:any;sourceEventSeqs?:number[]})=>{
  const seq=events.length
  events.push({seq,type,surfaceOp:options.surfaceOp,...options.sourceEventSeqs?{sourceEventSeqs:options.sourceEventSeqs}:{},data})
  if(options.surfaceOp==='append')surface.nodes.push(seq)
  else if(options.surfaceOp?.op==='replace'){const start=surface.nodes.indexOf(options.surfaceOp.startSeq),end=surface.nodes.indexOf(options.surfaceOp.endSeq);if(start===0&&type!=='system/message')throw Error('surface replace: node 0 holds the system prompt');surface.nodes.splice(start,end-start+1,seq)}
  return {seq}
 }
 let turns=0,exists=false,idleWaits=0
 // 真实 DSH 视图第 0 个节点是系统提示，只能由 system/message 原位改写。
 append('system/message',{prompt:'routing'},{surfaceOp:'append'})
 const session={id:groupRoutingSessionId(owner,groupId,day),header:{},surface,snapshotEvents:()=>events,append:(type:string,data:any,options:any)=>{appended.push({type,data,options});return append(type,data,options)}}
 const ctx={
  get:(name:string)=>name==='teloaResidentInputAdmission'?{bindRouting:async()=>()=>{}}:undefined,
  logger:{warn:()=>{},error:()=>{}},
  agentPresets:{resolve:async(id?:string)=>({id:id??teloaAgentPresetId})},
  sessionController:{
   inspect:async(id:unknown)=>{if(!exists)throw Error('missing');return {meta:{id:String(id),agentPreset:teloaAgentPresetId}}},
   create:async(request:{sessionId:string})=>{exists=true;return {sessionId:request.sessionId,agentPreset:teloaAgentPresetId}},
   prompt:async(request:{requestId:string})=>{
    const turn=turns++
    append('turn/start',{turn},{surfaceOp:'none'})
    append('user/message',{source:{kind:'user',rpcId:request.requestId},content:[],id:'ask-'+turn,role:'user'},{surfaceOp:'append'})
    append('assistant/message',{turn,message:{content:[{type:'text',text:answer}]}},{surfaceOp:'append'})
    append('turn/end',{turn,reason:{kind:'stop'}},{surfaceOp:'none'})
    return {accepted:true}
   },
   resolveAgent:async()=>({agent:{session,whenIdle:async()=>{idleWaits++}}}),
  },
 } as unknown as Context
 return {ctx,events,surface,appended,idleWaits:()=>idleWaits}
}
const archives=(appended:ReturnType<typeof harness>['appended'])=>appended.filter(row=>row.type==='user/message'&&row.data.source.kind===groupRoutingArchiveSource)

test('同群同日复用的路由会话：每次发问前把此前各轮换成一条归档说明，模型视图只剩本条输入，原生历史保留可读回',async()=>{
 const f=harness(),signal=()=>AbortSignal.timeout(5000)
 const first=await askGroupRouting(f.ctx,owner,ask('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),signal(),day)
 assert.equal(first.kind,'ok')
 assert.equal(archives(f.appended).length,0,'空视图不追加归档')
 const priorNodes=[...f.surface.nodes]
 assert.equal(priorNodes.length,3,'系统提示之后是首轮输入与回答')
 const second=await askGroupRouting(f.ctx,owner,ask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),signal(),day)
 assert.equal(second.kind,'ok','归档后仍按本轮原生回执读回结论')
 const archive=archives(f.appended)
 assert.equal(archive.length,1)
 assert.deepEqual(archive[0]!.options.surfaceOp,{op:'replace',startSeq:priorNodes[1],endSeq:priorNodes.at(-1)},'系统提示之后的此前各轮整段替换')
 assert.deepEqual(archive[0]!.options.sourceEventSeqs,priorNodes.slice(1))
 assert.match(JSON.stringify(archive[0]!.data.content),/Route only the next input/)
 const view=f.surface.nodes.map(seq=>f.events[seq]!)
 assert.deepEqual(view.map(event=>event.type),['system/message','user/message','user/message','assistant/message'],'模型视图：系统提示、归档说明、本轮输入、本轮回答')
 assert.equal(view[1]!.data.source.kind,groupRoutingArchiveSource)
 assert.ok(f.events.some(event=>event.seq===priorNodes[1]&&event.type==='user/message'),'原生历史事件仍在')
 assert.ok(f.idleWaits()>=1,'替换前等待会话空闲')
})

test('视图里只剩归档说明时不重复追加；没有原生会话视图的替身直接跳过',async()=>{
 const f=harness(),signal=()=>AbortSignal.timeout(5000)
 await askGroupRouting(f.ctx,owner,ask('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),signal(),day)
 await askGroupRouting(f.ctx,owner,ask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),signal(),day)
 // 模拟上一轮回答被移出视图后只剩系统提示与归档说明。
 f.surface.nodes.splice(2)
 const before=archives(f.appended).length
 await askGroupRouting(f.ctx,owner,ask('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),signal(),day)
 assert.equal(archives(f.appended).length,before,'不在仅有的归档说明上再叠一条')
 const bare=harness()
 ;(bare.ctx as any).sessionController.resolveAgent=async()=>({agent:{session:{id:'stub',snapshotEvents:()=>bare.events}}})
 assert.equal((await askGroupRouting(bare.ctx,owner,ask('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),signal(),day)).kind,'ok')
})
