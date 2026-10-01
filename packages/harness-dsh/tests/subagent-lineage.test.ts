import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveSessionLineage,type LineageSession} from '../src/subagent-lineage.ts'

function registry(sessions:LineageSession[]){return {agents:{get:(id:string)=>{const session=sessions.find(row=>row.id===id);return session?{session}:undefined}}}}
test('三层谱系按近到远返回祖先，声明深度与遍历次数独立',()=>{
 const root:LineageSession={id:'root',header:{}},one:LineageSession={id:'one',header:{origin:'subagent',parentSession:'root',delegationDepth:1}},two:LineageSession={id:'two',header:{origin:'subagent',parentSession:'one',delegationDepth:2}},child:LineageSession={id:'child',header:{origin:'subagent',parentSession:'two',delegationDepth:7}}
 const ctx=registry([root,one,two,child])
 assert.deepEqual(resolveSessionLineage(ctx,child),{root,ancestors:['two','one','root'],depth:7})
 assert.deepEqual(resolveSessionLineage(ctx,root),{root,ancestors:[],depth:0})
 assert.equal(resolveSessionLineage(ctx,child).root,root)
})
test('谱系缺父标识、父级离线、成环和超过 32 层时均抛错，32 层仍可核对',()=>{
 assert.throws(()=>resolveSessionLineage(registry([]),{id:'missing',header:{origin:'subagent'}}),/invalid subagent lineage/)
 assert.throws(()=>resolveSessionLineage(registry([]),{id:'offline',header:{origin:'subagent',parentSession:'private-parent'}}),/subagent parent unavailable/)
 const cycle:LineageSession={id:'cycle',header:{origin:'subagent',parentSession:'cycle'}}
 assert.throws(()=>resolveSessionLineage(registry([cycle]),cycle),/invalid subagent lineage/)
 const sessions:LineageSession[]=[{id:'0',header:{}}]
 for(let i=1;i<=33;i++)sessions.push({id:String(i),header:{origin:'subagent',parentSession:String(i-1)}})
 assert.equal(resolveSessionLineage(registry(sessions),sessions[32]!).ancestors.length,32)
 assert.throws(()=>resolveSessionLineage(registry(sessions),sessions[33]!),/invalid subagent lineage/)
})
