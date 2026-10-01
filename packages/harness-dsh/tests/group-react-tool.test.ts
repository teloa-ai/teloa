import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import {groupReactToolName,reactGroupOnlyReason,reactPostReason,reactTopicReason,reactUnknownReason,registerGroupReactTool,type GroupReactRunContext} from '../src/group-react-tool.ts'
import {groupAttachToolName} from '../src/group-attach-tool.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'
import {roleDailyDigestToolNames} from '../src/role-daily-log.ts'
import type {GroupReactionEmoji} from '@teloa/contract'

type Tool={name:string;description:string;execute:(args:unknown,exec:unknown)=>Promise<unknown>}
type PreHandler=(exec:{name:string;arguments?:unknown;agent?:{session:unknown};signal:AbortSignal},next:()=>Promise<{kind:string}>)=>Promise<{kind:string;reason?:string}>

const root={id:'run-session',header:{},snapshotEvents:()=>[]}
const child={id:'sub-1',header:{origin:'subagent',parentSession:'missing-parent'},snapshotEvents:()=>[]}
const groupId='11111111-1111-4111-8111-111111111111'
const rootId='22222222-2222-4222-8222-222222222222'
const roleId='33333333-3333-4333-8333-333333333333'
const runId='44444444-4444-4444-8444-444444444444'
const messageId='55555555-5555-4555-8555-555555555555'
const otherId='66666666-6666-4666-8666-666666666666'

const inGroup=(over:Partial<GroupReactRunContext>={}):GroupReactRunContext=>({canPost:true,groupId,rootId,roleId,runId,...over})

function harness(over:{context?:()=>Promise<GroupReactRunContext|undefined>;inTopic?:()=>Promise<boolean>;react?:()=>Promise<void>}={}){
 const tools:Tool[]=[],pre:PreHandler[]=[]
 const calls:{context:string[];inTopic:[GroupReactRunContext,string][];react:[GroupReactRunContext,string,GroupReactionEmoji][]}={context:[],inTopic:[],react:[]}
 const ctx={
  agents:{get:()=>undefined},
  tools:{register:(tool:Tool)=>{tools.push(tool)}},
  on:(event:string,handler:unknown)=>{
   if(event==='tools/pre-execute')pre.push(handler as PreHandler)
   return ()=>{}
  },
 } as unknown as Context
 registerGroupReactTool(ctx,{
  context:async sessionId=>{calls.context.push(sessionId);return over.context?await over.context():inGroup()},
  inTopic:async(context,target)=>{calls.inTopic.push([context,target]);return over.inTopic?await over.inTopic():true},
  react:async(context,target,emoji)=>{calls.react.push([context,target,emoji]);if(over.react)await over.react()},
 })
 const tool=tools.find(item=>item.name===groupReactToolName)!
 const gate=async(name:string,args:unknown,session:unknown=root,signal=new AbortController().signal)=>{
  let reached=false
  const decision=await pre[0]!({name,arguments:args,...(session?{agent:{session}}:{}),signal},async()=>{reached=true;return {kind:'allow'}})
  return {decision,reached}
 }
 const exec={agent:{session:root},signal:new AbortController().signal}
 return {ctx,tool,gate,calls,exec}
}

test('非群运行：pre-execute 拒，理由逐字',async()=>{
 const {gate,calls}=harness({context:async()=>undefined})
 const {decision,reached}=await gate(groupReactToolName,{messageId,emoji:'👍'})
 assert.deepEqual(decision,{kind:'deny',reason:'这个工具只能在群任务的运行里使用。'})
 assert.equal(reached,false)
 assert.equal(calls.react.length,0)
})

test('谱系断链：拒，用 unknown 那条理由',async()=>{
 const {gate,calls}=harness()
 const {decision}=await gate(groupReactToolName,{messageId,emoji:'👍'},child)
 assert.deepEqual(decision,{kind:'deny',reason:'无法核对当前运行的群内发言授权。'})
 // 断链在读上下文之前就判掉：端口一次都没被问到。
 assert.equal(calls.context.length,0)
 assert.equal(calls.react.length,0)
})

test('没有群内发言授权：拒，理由逐字',async()=>{
 const {gate,calls}=harness({context:async()=>inGroup({canPost:false})})
 const {decision}=await gate(groupReactToolName,{messageId,emoji:'👍'})
 assert.deepEqual(decision,{kind:'deny',reason:'本员工没有当前群内发言授权，不能在群里加表情。'})
 assert.equal(calls.inTopic.length,0)
 assert.equal(calls.react.length,0)
})

test('跨话题的 messageId：pre-execute 就拒，理由逐字（M5：闸在 authorize 里）',async()=>{
 const {gate,calls}=harness({inTopic:async()=>false})
 const {decision,reached}=await gate(groupReactToolName,{messageId:otherId,emoji:'👍'})
 assert.deepEqual(decision,{kind:'deny',reason:'只能给本话题里的消息加表情。'})
 assert.equal(reached,false)
 assert.deepEqual(calls.inTopic[0]?.[1],otherId)
 assert.equal(calls.react.length,0)
})

test('读不出上下文或本话题判据：一律 unknown 那条理由，且不透传上游文本',async()=>{
 const contextFailed=harness({context:async()=>{throw new Error('数据库连接 db://secret 失败')}})
 const first=await contextFailed.gate(groupReactToolName,{messageId,emoji:'👍'})
 assert.deepEqual(first.decision,{kind:'deny',reason:reactUnknownReason})
 assert.equal(/secret|db:\/\//.test(first.decision.reason!),false)
 const topicFailed=harness({inTopic:async()=>{throw new Error('relation teloa_group_messages does not exist')}})
 const second=await topicFailed.gate(groupReactToolName,{messageId,emoji:'👍'})
 assert.deepEqual(second.decision,{kind:'deny',reason:reactUnknownReason})
 assert.equal(topicFailed.calls.react.length,0)
})

test('非法 emoji：拒，且从未打到服务端',async()=>{
 const {tool,gate,calls,exec}=harness()
 await assert.rejects(tool.execute({messageId,emoji:'🐛'},exec),{code:'teloa/invalid-input'})
 assert.equal(calls.react.length,0)
 const {decision,reached}=await gate(groupReactToolName,{messageId,emoji:'🐛'})
 assert.equal(decision.kind,'deny')
 assert.equal(reached,false)
 assert.equal(calls.react.length,0)
})

test('未知键、非 uuid 的 messageId 同样在服务端之前就拒',async()=>{
 const {tool,calls,exec}=harness()
 await assert.rejects(tool.execute({messageId,emoji:'👍',groupId},exec),{code:'teloa/invalid-input'})
 await assert.rejects(tool.execute({messageId:'not-a-uuid',emoji:'👍'},exec),{code:'teloa/invalid-input'})
 // 缺必填键由上游 defineTool 的参数表先判掉；本闸只需保证它同样到不了服务端。
 await assert.rejects(tool.execute({emoji:'👍'},exec))
 assert.equal(calls.react.length,0)
})

test('正常：写库一次，run_id 是本次运行，react 返回 void',async()=>{
 const {tool,calls,exec}=harness()
 await tool.execute({messageId,emoji:'✅'},exec)
 assert.equal(calls.react.length,1)
 assert.equal(calls.react[0]![0].runId,runId)
 assert.equal(calls.react[0]![0].roleId,roleId)
 assert.equal(calls.react[0]![0].groupId,groupId)
 assert.equal(calls.react[0]![1],messageId)
 assert.equal(calls.react[0]![2],'✅')
})

test('本闸只管自己这个工具，其它工具原样交给后面的闸',async()=>{
 const {gate,calls}=harness({context:async()=>undefined})
 const {decision,reached}=await gate('read',{})
 assert.equal(decision.kind,'allow')
 assert.equal(reached,true)
 assert.equal(calls.context.length,0)
})

test('四条固定理由都不含会话 id、工具参数或上游异常文本',()=>{
 for(const reason of [reactGroupOnlyReason,reactPostReason,reactTopicReason,reactUnknownReason]){
  assert.ok(!/session|sessionId|[0-9a-f]{8}-/.test(reason))
  assert.ok(!/teloa_group_react|messageId|emoji/.test(reason))
 }
})

test('工具描述把十二个固定表情逐字列给模型',()=>{
 const {tool}=harness()
 for(const emoji of ['👍','👎','✅','❌','👀','🎉','❤️','🙏','🤔','🚀','⚠️','📌'])assert.ok(tool.description.includes(emoji),`描述里缺 ${emoji}`)
})

test('自授权集加入这一名之后，四条装配期断言仍全部通过',()=>{
 const ctx={tools:{guard:()=>()=>{}},on:()=>()=>{}} as unknown as Context
 const readPolicy=async()=>null
 assert.doesNotThrow(()=>registerTaskToolGuard(ctx,readPolicy,[roleMemoryProposalToolName,...roleDailyDigestToolNames,groupAttachToolName,groupReactToolName]))
 // 这一名不是 MCP 资源工具、编排类、委派工具或外发类：混进任一类都会在装配期抛。
 assert.doesNotThrow(()=>registerTaskToolGuard(ctx,readPolicy,[groupReactToolName]))
})

// 装配面只能按源码守卫：`apply()` 在本包的桩宿主上跑不完（先例 tests/group-attachments.test.ts:7）。
const wiring=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),selfAuthorizedSource=await readFile(new URL('../src/self-authorized-tools.ts',import.meta.url),'utf8')

test('装配：自授权集在贴回工具之后追加本工具，工具名只以常量进入装配',()=>{
 assert.equal(selfAuthorizedSource.includes('groupAttachToolName,groupReactToolName]'),true)
 assert.equal(wiring.includes('[...selfAuthorizedToolNames],async(sessionId,signal)=>{'),true)
 assert.equal(wiring.includes(`'${groupReactToolName}'`),false);assert.equal(selfAuthorizedSource.includes(`'${groupReactToolName}'`),false)
 assert.equal(wiring.includes('registerGroupReactTool(ctx,{'),true)
})

test('装配：三个端口各自接线，requestId 由确定性派生算出而不是随机取',()=>{
 assert.match(wiring,/rootId:run\.groupContext\.source\.rootId,roleId:run\.groupContext\.roleId,runId:run\.id/)
 assert.match(wiring,/\.inTopic\(db,owner,context\.groupId,context\.rootId,messageId\)/)
 assert.equal(wiring.includes('requestId:groupRoutedReactionRequestId(owner,messageId,context.roleId,emoji)'),true)
 // 表情工具不得经 randomUUID 造请求身份：那样每次重放都会新写一行。
 assert.equal(/requestId:randomUUID\(\)[^\n]*applyRole/.test(wiring),false)
})

test('装配：群 RPC 的提供方换成组合对象，三条新端点各接自己的服务',()=>{
 assert.match(wiring,/reactions:\(actor,input\)=>reactions\.list\(actor,input\),toggleReaction:\(actor,input\)=>reactions\.toggle\(actor,input\),routing:\(actor,input\)=>routing\.list\(actor,input\)/)
 // 既有十个仍全部落在 CollaborationService 上。
 assert.match(wiring,/const collaboration=new CollaborationService\(pool,identity\)/)
 for(const method of ['list','get','create','change','messages','resources','resource','saveResource','withdrawResource'])assert.ok(wiring.includes(`${method}:(actor,input)=>collaboration.${method}(actor,input)`),`缺 collaboration.${method} 的接线`)
 // `send` 多包一层「发完过一次路由」（T9 的触发点），写入本身仍然只由 CollaborationService 做。
 assert.match(wiring,/send:async\(actor,input\)=>\{\n\s+const message=await collaboration\.send\(actor,input\)/)
})
