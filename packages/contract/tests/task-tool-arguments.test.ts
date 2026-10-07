import test from 'node:test'
import assert from 'node:assert/strict'
import {readTaskToolArgumentRules,taskToolArgumentsAllowed} from '../src/task-tool-arguments.ts'

test('anyArguments 只能是 true 且必须配空 allowed，其余形状一律拒绝',()=>{
 assert.deepEqual(readTaskToolArgumentRules([{name:'subagent_task',allowed:[],anyArguments:true}]),[{name:'subagent_task',allowed:[],anyArguments:true}])
 assert.throws(()=>readTaskToolArgumentRules([{name:'t',allowed:[],anyArguments:false}]))
 assert.throws(()=>readTaskToolArgumentRules([{name:'t',allowed:[{a:'1'}],anyArguments:true}]))
 assert.throws(()=>readTaskToolArgumentRules([{name:'t',allowed:[],anyArguments:1}]))
 assert.throws(()=>readTaskToolArgumentRules([{name:'t',allowed:[],other:true}]))
})
test('anyArguments 规则放行任意参数对象，包括 web_search 数组与嵌套 JSON；顶层仍必须是对象',()=>{
 const rules=[{name:'web_search',allowed:[],anyArguments:true}]
 assert.equal(taskToolArgumentsAllowed(rules,'web_search',{queries:['teloa 上网一期']}),true)
 assert.equal(taskToolArgumentsAllowed(rules,'web_search',{queries:['一'],options:{freshness:'day'}}),true)
 assert.equal(taskToolArgumentsAllowed(rules,'web_search',{}),true)
 for(const args of [null,[],['teloa'],1,'teloa'])assert.equal(taskToolArgumentsAllowed(rules,'web_search',args),false)
 assert.equal(taskToolArgumentsAllowed(rules,'other_tool',{}),false)
})
test('不带 anyArguments 的既有规则行为逐字不变（空 allowed 仍然谁都不放行）',()=>{
 assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[]}],'t',{}),false)
 assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[{id:'a'}]}],'t',{id:'a'}),true)
 assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[{id:'a'}]}],'t',{id:'b'}),false)
 assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[{id:'a'}]}],'t',{id:['a']}),false)
 assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[{id:'a'}]}],'t',{id:{value:'a'}}),false)
 for(const args of [null,[],['a'],1,'a'])assert.equal(taskToolArgumentsAllowed([{name:'t',allowed:[{id:'a'}]}],'t',args),false)
})
// 客户端读口（role-tool-grant-api.ts:18）与服务端记录核对（backend/work/role-tool-grants.ts:14）都用
// JSON.stringify 逐字串比，所以规范化必须幂等且键序固定，否则扩位会让这两处凭空不一致。
test('带 anyArguments 的规则经规范化后串比稳定，既有调用方无需改动',()=>{
 const once=readTaskToolArgumentRules([{name:'subagent_task',allowed:[],anyArguments:true},{name:'read_reference',allowed:[{version:'v1',id:'one'}]}])
 assert.equal(JSON.stringify(readTaskToolArgumentRules(once)),JSON.stringify(once))
 assert.equal(JSON.stringify(once),'[{"name":"subagent_task","allowed":[],"anyArguments":true},{"name":"read_reference","allowed":[{"id":"one","version":"v1"}]}]')
})

test('工作目录文件授权独立于任意参数授权，限定官方文件工具及参数',()=>{
 for(const name of ['read','write','edit']){
  const rule={name,allowed:[],workspaceFiles:'default-workspace' as const}
  assert.deepEqual(readTaskToolArgumentRules([rule]),[rule])
  const args=name==='read'?{file_path:'outputs/result.txt',offset:1,limit:20}:name==='write'?{file_path:'outputs/result.txt',content:'真实成果'}:{file_path:'outputs/result.txt',old_string:'真实',new_string:'更新',replace_all:false}
  assert.equal(taskToolArgumentsAllowed([rule],name,args),true)
  assert.equal(taskToolArgumentsAllowed([rule],name,{...args,sandbox_permissions:'danger-full-access',justification:'扩大范围'}),false)
  assert.equal(taskToolArgumentsAllowed([rule],name,{...args,file_path:'../outside.txt'}),false)
  assert.equal(taskToolArgumentsAllowed([rule],name,{...args,file_path:'.runtime/secret'}),false)
  assert.throws(()=>readTaskToolArgumentRules([{...rule,anyArguments:true}]))
  assert.throws(()=>readTaskToolArgumentRules([{...rule,allowed:[{file_path:'a'}]}]))
 }
 assert.throws(()=>readTaskToolArgumentRules([{name:'bash',allowed:[],workspaceFiles:'default-workspace'}]))
 assert.throws(()=>readTaskToolArgumentRules([{name:'read',allowed:[],workspaceFiles:'/forged'}]))
})
