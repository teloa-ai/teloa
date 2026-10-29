import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {employeeKnowledgeInput} from '../src/employee-knowledge.ts'
const roleId='11111111-1111-4111-8111-111111111111'

test('员工知识正式RPC同时进入宿主入口白名单与分发链',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const allowlist=source.split('\n').find(row=>row.startsWith('const endpointSet=new Set('))
 assert.ok(allowlist?.includes('...employeeKnowledgeEndpoints'))
 assert.match(source,/if\(\(employeeKnowledgeEndpoints as readonly string\[\]\)\.includes\(endpoint\)\)return employeeKnowledgeHandler\(endpoint,payload\)/)
 assert.match(source,/if\(!endpointSet\.has\(endpoint\)\)/)
})

test('员工知识RPC默认列表保持兼容，导出严格列表只接受requireReady字面true',()=>{
 assert.deepEqual(employeeKnowledgeInput('list',{roleId}),{roleId})
 assert.deepEqual(employeeKnowledgeInput('list',{roleId,requireReady:true}),{roleId,requireReady:true})
 for(const requireReady of [false,null,undefined,0,1,'true',{},[]])assert.throws(()=>employeeKnowledgeInput('list',{roleId,requireReady}),{code:'teloa/invalid-input'})
 assert.throws(()=>employeeKnowledgeInput('read',{roleId,resourceId:roleId,requireReady:true}),{code:'teloa/invalid-input'})
 assert.throws(()=>employeeKnowledgeInput('list',{roleId,ownerId:'other'}),{code:'teloa/invalid-input'})
})
