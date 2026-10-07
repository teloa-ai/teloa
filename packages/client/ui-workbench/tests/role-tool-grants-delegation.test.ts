import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleToolGrantApi} from '../src/client/role-tool-grant-api.ts'
import {isSubagentDelegationRule,roleToolGrantSelectionKey,selectedRoleToolGrantRules} from '../src/client/role-tool-grant-presentation.ts'

const roleId='11111111-1111-4111-8111-111111111111'
const delegation={maxDepth:2,maxPerRun:8}
const rule={name:'subagent_task',allowed:[],anyArguments:true as const}
const journal={read:()=>null,write:(_value:string)=>{},clear:()=>{}}

test('工作目录文件勾选逐字保存服务端作用域，不改成任意参数或添加 Bash',async()=>{
 const files=['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace' as const}))
 const api=createRoleToolGrantApi(async()=>({roleVersion:3,rules:files}),journal)
 assert.deepEqual((await api.candidates(roleId)).rules,files)
 assert.deepEqual(selectedRoleToolGrantRules(files,new Set(files.map(rule=>roleToolGrantSelectionKey(rule)))),files)
 assert.deepEqual(selectedRoleToolGrantRules(files,new Set()),[])
})

test('岗位工具候选仅在服务端同时给出整工具授权与限额时才接受任务拆分选项',async()=>{
 const api=createRoleToolGrantApi(async()=>({roleVersion:3,rules:[rule],delegation}),journal)
 const result=await api.candidates(roleId)
 assert.deepEqual(result,{roleVersion:3,rules:[rule],delegation})
 assert.equal(isSubagentDelegationRule(result.rules[0]!),true)
 for(const value of [
  {roleVersion:3,rules:[rule]},
  {roleVersion:3,rules:[],delegation},
  {roleVersion:3,rules:[{name:'subagent_task',allowed:[{id:'source',version:'a'}]}],delegation},
  {roleVersion:3,rules:[rule],delegation:{maxDepth:-1,maxPerRun:8}},
  {roleVersion:3,rules:[rule],delegation:{maxDepth:2,maxPerRun:0}},
 ])await assert.rejects(createRoleToolGrantApi(async()=>value,journal).candidates(roleId))
})

test('勾选任务拆分只回传服务端候选的 anyArguments 与空参数清单',()=>{
 const source={name:'mcp__teloa_reference__read_reference',allowed:[{id:'guide',version:'a'.repeat(64)}]}
 const selected=new Set([roleToolGrantSelectionKey(rule),roleToolGrantSelectionKey(source,source.allowed[0]!)])
 assert.deepEqual(selectedRoleToolGrantRules([source,rule],selected),[source,rule])
 assert.deepEqual(selectedRoleToolGrantRules([source,rule],new Set()),[])
})
