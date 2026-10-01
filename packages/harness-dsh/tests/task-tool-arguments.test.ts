import test from 'node:test'
import assert from 'node:assert/strict'
import {taskToolArgumentsAllowed} from '../src/task-tool-arguments.ts'
test('工具参数授权按完整键和值匹配，不受键顺序影响',()=>{
 const rules=[{name:'read_reference',allowed:[{id:'one',version:'v1'},{id:'two',version:'v2'}]}]
 assert.equal(taskToolArgumentsAllowed(rules,'read_reference',{version:'v1',id:'one'}),true)
 for(const args of [{id:'one',version:'v2'},{id:'two',version:'v1'},{id:'one'},{id:'one',version:'v1',path:'/other'},null,[],{id:{value:'one'},version:'v1'}])assert.equal(taskToolArgumentsAllowed(rules,'read_reference',args),false)
 assert.equal(taskToolArgumentsAllowed(rules,'write_reference',{id:'one',version:'v1'}),false)
})
test('损坏、重复和空授权不放行，标量类型严格一致',()=>{
 for(const rules of [null,[],[{name:'read',allowed:[]}],[{name:'read',allowed:[{id:NaN}]}],[{name:'read',allowed:[{}],extra:true}],[{name:'read',allowed:[{}]},{name:'read',allowed:[{}]}]])assert.equal(taskToolArgumentsAllowed(rules,'read',{}),false)
 const rules=[{name:'read',allowed:[{id:1,flag:false,empty:null}]}]
 assert.equal(taskToolArgumentsAllowed(rules,'read',{empty:null,flag:false,id:1}),true)
 assert.equal(taskToolArgumentsAllowed(rules,'read',{empty:null,flag:false,id:'1'}),false)
})
