import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupRoutingOutput,groupRoutingOutputSchema,groupRoutingRespondMax,groupRoutedTaskRequestId,groupRelayStopRequestId,groupRoutingSessionId,isGroupRoutingDecision,isGroupRoutingDecisionView,groupRoutingListInput} from '../src/group-routing.ts'

const A='aaaaaaaa-1111-4111-8111-111111111111'
const B='bbbbbbbb-1111-4111-8111-111111111111'
const C='cccccccc-1111-4111-8111-111111111111'
const ok=JSON.stringify({schema:groupRoutingOutputSchema,respond:[A],reactions:[{roleId:B,emoji:'👍'}]})
const invalid={code:'teloa/invalid-input'}

test('合法输出被原样解析', () => {
 assert.deepEqual(groupRoutingOutput(ok,[A,B]), {schema:groupRoutingOutputSchema,respond:[A],reactions:[{roleId:B,emoji:'👍'}]})
})

test('围栏只剥一层', () => {
 assert.deepEqual(groupRoutingOutput('```json\n'+ok+'\n```',[A,B]).respond, [A])
 assert.deepEqual(groupRoutingOutput('```\n'+ok+'\n```',[A,B]).respond, [A])
})

test('候选集之外的 roleId 一律拒', () => {
 assert.throws(()=>groupRoutingOutput(ok,[B]), invalid)
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:[C],reactions:[]}),[A,B]), invalid)
})

test('多一个键、schema 不符、非法 emoji、重复项、超上限一律拒', () => {
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:[],reactions:[],extra:1}),[A]), invalid)
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:'teloa.group-routing-output/v2',respond:[],reactions:[]}),[A]), invalid)
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:[],reactions:[{roleId:A,emoji:'🐛'}]}),[A]), invalid)
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:[A,A],reactions:[]}),[A]), invalid)
 // 超上限必须是「互不相同且都在候选集里」的 max+1 条，否则撞的是去重或候选集那两条判据，钉不住长度上限。
 const many=Array.from({length:groupRoutingRespondMax+1},(_item,index)=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`)
 assert.throws(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:many,reactions:[]}),many), invalid)
 assert.doesNotThrow(()=>groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:many.slice(0,groupRoutingRespondMax),reactions:[]}),many))
})

test('不是 JSON、是数组、是 null 一律拒', () => {
 assert.throws(()=>groupRoutingOutput('我觉得应该让张三回',[A]), invalid)
 assert.throws(()=>groupRoutingOutput('[]',[A]), invalid)
 assert.throws(()=>groupRoutingOutput('null',[A]), invalid)
})

test('五个派生函数稳定、互不相撞、形状是 uuid，停下带轮次分量', () => {
 const uuidShape=/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/
 const t1=groupRoutedTaskRequestId('o','g','m',A)
 assert.equal(t1, groupRoutedTaskRequestId('o','g','m',A))
 assert.notEqual(t1, groupRoutedTaskRequestId('o','g','m',B))
 assert.notEqual(t1, groupRelayStopRequestId('o','g','m',1))
 assert.match(t1, uuidShape)
 // H2：轮次分量必须改变身份，否则第二次触顶时静默无提示
 assert.notEqual(groupRelayStopRequestId('o','g','r',1), groupRelayStopRequestId('o','g','r',2))
 assert.match(groupRelayStopRequestId('o','g','r',2), uuidShape)
 // H6：会话按天派生，同一天同群复用
 assert.equal(groupRoutingSessionId('o','g','2026-09-21'), groupRoutingSessionId('o','g','2026-09-21'))
 assert.notEqual(groupRoutingSessionId('o','g','2026-09-21'), groupRoutingSessionId('o','g','2026-09-22'))
 assert.ok(groupRoutingSessionId('o','g','2026-09-21').startsWith('group-routing-'))
})

test('决策守卫认 8 键、投影守卫认 4 键，列表入参白名单恰 2 键', () => {
 const decision={kind:'routed' as const,respond:[A],reactions:[{roleId:A,emoji:'👍' as const}],hops:0,candidateIds:[A,B],truncatedCandidates:false,stopMessageId:null,at:'2026-09-21T00:00:00.000Z'}
 assert.equal(isGroupRoutingDecision(decision), true)
 assert.equal(isGroupRoutingDecision({...decision,kind:'relay-stopped' as const,hops:6,stopMessageId:C}), true)
 assert.equal(isGroupRoutingDecision({...decision,extra:'forged'}), false)
 assert.equal(isGroupRoutingDecision({...decision,kind:'relayed'}), false)
 assert.equal(isGroupRoutingDecision({...decision,respond:[A,A]}), false)
 assert.equal(isGroupRoutingDecision({...decision,reactions:[{roleId:A,emoji:'🐛'}]}), false)
 assert.equal(isGroupRoutingDecision({...decision,hops:-1}), false)
 const view={messageId:C,kind:'routed' as const,respond:[A],hops:1}
 assert.equal(isGroupRoutingDecisionView(view), true)
 assert.equal(isGroupRoutingDecisionView({...view,candidateIds:[A]}), false)
 assert.equal(isGroupRoutingDecisionView({...view,kind:'relayed'}), false)
 assert.deepEqual(groupRoutingListInput({groupId:A,messageIds:[B,C]}), {groupId:A,messageIds:[B,C]})
 assert.throws(()=>groupRoutingListInput({groupId:A,messageIds:[B],extra:1}), invalid)
 assert.throws(()=>groupRoutingListInput({groupId:A,messageIds:[]}), invalid)
 assert.throws(()=>groupRoutingListInput({groupId:A,messageIds:[B,B]}), invalid)
})
