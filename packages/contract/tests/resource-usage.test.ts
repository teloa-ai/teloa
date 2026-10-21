import test from 'node:test'
import assert from 'node:assert/strict'
import {isResourceUsagePage,type ResourceUsageTarget} from '../src/resource-usage.ts'

const resourceId='11111111-1111-4111-a111-111111111111',groupId='22222222-2222-4222-a222-222222222222'
const page={resourceId,version:1,items:[{sessionId:'source-session',title:'原会话',messageId:'source-message',at:'2026-10-21T12:00:00.000Z',version:1}],scanned:1,unavailable:0,nextCursor:null,related:[],relatedMore:false}
test('资料反向查询保留原消息身份，并接受明确区分的群关联',()=>{
 const target:ResourceUsageTarget={kind:'conversation',id:'source-session',messageId:'source-message'}
 assert.equal(target.messageId,page.items[0]!.messageId)
 assert.equal(isResourceUsagePage(page),true)
 assert.equal(isResourceUsagePage({...page,related:[{kind:'group',id:groupId,title:'业务协作群',scope:'general',messageId:'group-message',rootId:null,version:1,count:2}]}),true)
 for(const patch of [{id:'bad id'},{scope:'bad scope'},{messageId:''},{rootId:false},{version:0},{count:0},{count:1.5}])assert.equal(isResourceUsagePage({...page,related:[{kind:'group',id:groupId,title:'业务协作群',scope:'general',messageId:'group-message',rootId:null,version:1,count:2,...patch}]}),false)
})
test('原会话与关联工作保持原类别语义；错误消息身份不能当完整回包',()=>{
 for(const kind of ['task','project','employee'])assert.equal(isResourceUsagePage({...page,related:[{kind,id:groupId,title:'原关联'}]}),true)
 assert.equal(isResourceUsagePage({...page,items:[{...page.items[0],messageId:''}]}),false)
 assert.equal(isResourceUsagePage({...page,related:[{kind:'conversation',id:groupId,title:'不可冒充关联工作'}]}),false)
})
