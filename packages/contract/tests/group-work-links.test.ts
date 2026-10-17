import test from 'node:test'
import assert from 'node:assert/strict'
import * as links from '../src/group-work-links.ts'

const groupId='10000000-0000-4000-8000-000000000001',projectId='20000000-0000-4000-8000-000000000001'
test('同一群可关联不同业务的多个原对象，关系不包含授权或会话副本',()=>{
 const result=links.groupWorkLinksChangeInput({requestId:projectId,groupId,expectedGroupVersion:1,expectedVersion:0,links:[{kind:'project',scope:'general',id:projectId},{kind:'business',scope:'SOC',type:'incident',id:'INC-207'},{kind:'business',scope:'SOC',type:'incident',id:'INC-301'}]})
 assert.equal(result.links.length,3)
 assert.deepEqual(result.links.find(item=>item.kind==='business'),{kind:'business',scope:'SOC',type:'incident',id:'INC-207'})
 for(const patch of [{canRead:true},{sessionId:'other-session'},{ownerId:'another-owner'}])assert.throws(()=>links.groupWorkLinksChangeInput({...result,...patch}),{code:'teloa/invalid-input'})
})
test('关系重复、无效对象身份与并发版本不允许进入存储',()=>{
 const base={requestId:projectId,groupId,expectedGroupVersion:1,expectedVersion:0,links:[{kind:'project',scope:'general',id:projectId}]}
 for(const patch of [{links:[...base.links,...base.links]},{expectedVersion:-1},{expectedGroupVersion:0},{links:[{kind:'task',scope:'general',id:'INC-207'}]},{links:[{kind:'business',scope:'general',type:'incident',id:'INC-207'}]}])assert.throws(()=>links.groupWorkLinksChangeInput({...base,...patch}),{code:'teloa/invalid-input'})
})
test('不可访问的关联只保留身份占位，不能带回他人标题、版本或状态',()=>{
 const base={groupId,groupVersion:1,version:1,items:[{kind:'project',scope:'general',id:projectId,available:false,title:null,state:null,objectVersion:null}]}
 assert.deepEqual(links.readGroupWorkLinks(base),base)
 assert.throws(()=>links.readGroupWorkLinks({...base,items:[{...base.items[0],title:'private project'}]}),{code:'teloa/invalid-input'})
})

test('项目侧原关联是独立只读投影，不能混入群侧保存身份',()=>{
 const project={kind:'project',scope:'SOC',id:projectId,available:true,title:'跨业务项目',state:'planning',objectVersion:2}
 const detail={groupId,groupVersion:1,version:0,items:[],projectLinks:[project]}
 assert.deepEqual(links.readGroupWorkLinks(detail),detail)
 for(const projectLinks of [[{...project,kind:'task'}],[project,project],[{...project,available:false}],[{...project,canRead:true}]])assert.throws(()=>links.readGroupWorkLinks({...detail,projectLinks}),{code:'teloa/invalid-input'})
 assert.throws(()=>links.groupWorkLinksChangeInput({requestId:projectId,groupId,expectedGroupVersion:1,expectedVersion:0,links:[],projectLinks:[project]}),{code:'teloa/invalid-input'})
})
