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

test('可信文件路径策略规范化保存、按操作分离，拒绝父级和未知字段',async()=>{
 const {readTaskToolArgumentRules,workspacePathAllowed,workspacePathSchema}=await import('@teloa/contract')
 const rules=readTaskToolArgumentRules([{name:'read',allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:['input.csv'],directories:['notes']}},{name:'write',allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:['output.md'],directories:[]}}])
 assert.deepEqual(readTaskToolArgumentRules(JSON.parse(JSON.stringify(rules))),rules)
 assert(workspacePathAllowed(rules[0]!, 'input.csv'));assert(workspacePathAllowed(rules[0]!,'notes/a.txt'))
 for(const path of ['notes-other/a.txt','output.md','../input.csv','notes/../input.csv'])assert.equal(workspacePathAllowed(rules[0]!,path),false)
 assert.equal(taskToolArgumentsAllowed(rules,'read',{file_path:'output.md'}),false)
 assert.equal(taskToolArgumentsAllowed(rules,'write',{file_path:'output.md',content:'new'}),true)
 assert.deepEqual(workspacePathSchema(rules,'write')?.enum,['output.md'])
 for(const workspacePaths of [{files:[],directories:[]},{files:['../input.csv'],directories:[]},{files:['/input.csv'],directories:[]},{files:['a//b'],directories:[]},{files:['a/.git/key'],directories:[]},{files:['a','a'],directories:[]},{files:['a'],directories:[],extra:true}])assert.throws(()=>readTaskToolArgumentRules([{name:'read',allowed:[],workspaceFiles:'default-workspace',workspacePaths}]))
 assert.throws(()=>readTaskToolArgumentRules([{name:'read',allowed:[],workspaceFiles:'default-workspace',unknownPolicy:{files:['input.csv']}}]))
})

test('细范围编辑schema为read/write/edit交集，代码及未知工具fail-closed',async()=>{
 const {readTaskToolArgumentRules,workspacePathSchema,workspacePathsUnsafeTool}=await import('@teloa/contract')
 const rules=readTaskToolArgumentRules(['read','write','edit'].map((name,i)=>({name,allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:[['both.txt','read.txt'],['both.txt','write.txt'],['both.txt','read.txt','write.txt']][i],directories:[]}})))
 assert.deepEqual(workspacePathSchema(rules,'edit')?.enum,['both.txt'])
 assert.equal(workspacePathSchema(rules,'unrelated'),undefined)
 for(const name of ['run_code','workflow','subagent_task','bash','mcp__custom__arbitrary_fs'])assert(workspacePathsUnsafeTool(name))
 const directory=workspacePathSchema([{name:'read',allowed:[],workspaceFiles:'default-workspace',workspacePaths:{files:[],directories:['notes[1]']}}],'read')!
 assert(new RegExp(directory.allOf![0]!.pattern).test('notes[1]/a.txt'));assert(!new RegExp(directory.allOf![0]!.pattern).test('notes1/a.txt'))
})
