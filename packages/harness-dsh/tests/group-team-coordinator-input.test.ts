import test from 'node:test'
import assert from 'node:assert/strict'
import {groupRoutingInput,type GroupRoutingAsk} from '../src/group-routing.ts'

const lead='11111111-1111-4111-8111-111111111111'
const candidate={roleId:lead,roleVersion:1,name:'协调者',duty:'分工与汇总',triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
const ask:GroupRoutingAsk={groupId:'group',groupName:'团队',messageId:'message',rootId:'message',trigger:{authorKind:'self',authorId:'self',authorName:'本人',text:'请协调团队分工并汇总。',createdAt:'2026-10-16T00:00:00.000Z',mentions:[]},topic:[],candidates:[candidate],hops:0}
test('群协调者只在当前可执行候选内进入模型输入，普通旧群输入不变',()=>{
 assert.deepEqual(groupRoutingInput(ask).group,{id:'group',name:'团队'})
 assert.deepEqual(groupRoutingInput({...ask,coordinatorRoleId:lead}).group,{id:'group',name:'团队',coordinatorRoleId:lead})
 assert.deepEqual(groupRoutingInput({...ask,coordinatorRoleId:'not-eligible'}).group,{id:'group',name:'团队'})
 assert.deepEqual(groupRoutingInput({...ask,candidates:[],coordinatorRoleId:lead}).group,{id:'group',name:'团队'})
})
