import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

/** 只取目录组件导出的纯函数：与宿主 industry-roles 的「必需知识未启用则拒绝创建岗位」保持同一口径。 */
function load(){
 const source=readFileSync(new URL('../src/client/SavedIndustryDirectory.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const stub=new Proxy({},{get:()=>()=>undefined})
 const exports:Record<string,any>={}
 new Function('require','exports',js)(()=>stub,exports)
 return exports.missingRoleKnowledge as (load:unknown,roleItemId:string,rows:unknown[])=>Array<{instanceId:string;title:string}>
}
const missingRoleKnowledge=load()
const id=(n:number)=>`${n}2345678-1234-4234-8234-123456789012`
const [loadId,role,required,optional,other]=[1,2,3,4,5].map(id) as [string,string,string,string,string]
const item=(instanceId:string,kind:string,title:string,isRequired:boolean)=>({localId:title,instanceId,kind,title,version:'1.0.0',required:isRequired,status:'pending-adapter'})
const record={id:loadId,items:[item(role,'role','分析岗',true),item(required,'knowledge','处置手册',true),item(optional,'knowledge','参考词表',false),item(other,'knowledge','别的知识',true)],
 relations:[{kind:'role-knowledge',from:role,to:required},{kind:'role-knowledge',from:role,to:optional},{kind:'role-knowledge',from:other,to:role}]}
const knowledge=(itemInstanceId:string,state:string)=>({loadId,itemInstanceId,state})

test('必需知识未启用时列为缺失；可选知识与反向关系不计入',()=>{
 assert.deepEqual(missingRoleKnowledge(record,role,[]).map(row=>row.title),['处置手册'])
 assert.deepEqual(missingRoleKnowledge(record,role,[knowledge(required,'pending')]).map(row=>row.title),['处置手册'])
 assert.deepEqual(missingRoleKnowledge(record,role,[knowledge(required,'failed')]).map(row=>row.title),['处置手册'])
})

test('必需知识已启用后不再缺失',()=>{
 assert.deepEqual(missingRoleKnowledge(record,role,[knowledge(required,'active')]),[])
})

test('升级沿用的知识按原实例判断',()=>{
 const carried={...record,items:record.items.map(row=>row.instanceId===required?{...row,carriedFrom:other}:row)}
 assert.deepEqual(missingRoleKnowledge(carried,role,[{loadId:id(9),itemInstanceId:other,state:'active'}]),[])
})
