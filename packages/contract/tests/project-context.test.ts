import test from 'node:test'
import assert from 'node:assert/strict'
import {projectContextMutation,readProjectContext} from '../src/project-context.ts'
const id='0f878d9e-dd07-4d6a-9814-e3f084df5d98'
const base={projectId:id,requestId:id,expectedVersion:0}
test('项目上下文写口拒绝隐式身份、来源、无效版本与空正文',()=>{
 const valid={...base,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'桌面范围',markdown:'只做桌面'}}
 assert.deepEqual(projectContextMutation(valid),valid)
 for(const bad of [{...valid,owner:'other'},{...valid,expectedVersion:-1},{...valid,change:{...valid.change,source:'user'}},{...valid,change:{...valid.change,markdown:' '}},{...valid,change:{...valid.change,topic:'x\u0000'}}])assert.throws(()=>projectContextMutation(bad))
})
test('关闭自动接入阶段的响应不允许假使用记录或缺少正文状态',()=>{
 assert.deepEqual(readProjectContext({projectId:id,version:0,brief:'',entries:[],shares:[]}),{projectId:id,version:0,brief:'',entries:[],shares:[]})
 assert.throws(()=>readProjectContext({projectId:id,version:0,brief:'',entries:[],shares:[],used:true}))
 assert.throws(()=>readProjectContext({projectId:id,version:0,brief:'',entries:[{id}],shares:[]}))
})
