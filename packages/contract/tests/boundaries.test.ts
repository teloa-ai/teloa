import test from 'node:test'
import assert from 'node:assert/strict'
import { isCapabilitySnapshot, isConversation } from '../src/index.ts'
const conversation={id:'work-1',ownerId:'local:owner',title:'整理资料',scopeIds:['general'],version:1,status:'ready',sessionId:'native-1',requestedSessionId:'native-1',createdAt:'2026-09-10T00:00:00Z'}
test('合法公开绑定可读，损坏的预约身份不能被当作可恢复请求',()=>{
  assert.equal(isConversation(conversation),true)
  assert.equal(isConversation({...conversation,status:'pending',requestId:{value:'fake'}}),false)
  assert.equal(isConversation({...conversation,scopeIds:['general','soc']}),false)
  assert.equal(isConversation({...conversation,version:2}),false)
})
test('能力结果必须提供实际目录与明确状态，不把缺失目录视为零能力',()=>{
  const value={schema:'teloa.capabilities/v1',conversation,observedAt:'2026-09-10T00:00:00Z',skills:[],knowledge:{status:'not-connected'},connections:{status:'not-connected'},writes:{status:'not-implemented'}}
  assert.equal(isCapabilitySnapshot(value),true)
  assert.equal(isCapabilitySnapshot({...value,skills:undefined}),false)
  assert.equal(isCapabilitySnapshot({...value,skills:[{name:'skill',description:'资料整理',source:'custom',provider:'fs',modelInvocable:'true',userInvocable:true}]}),false)
  assert.equal(isCapabilitySnapshot({...value,writes:{status:'authorized'}}),false)
  assert.equal(isCapabilitySnapshot({...value,connections:{status:'observed',tools:[{name:'mcp__teloa_reference__list_references',description:'列出资料'}]}}),true)
  assert.equal(isCapabilitySnapshot({...value,connections:{status:'observed'}}),false)
  assert.equal(isCapabilitySnapshot({...value,connections:{status:'observed',tools:[{name:'shell',description:'非 MCP 工具'}]}}),false)
})
