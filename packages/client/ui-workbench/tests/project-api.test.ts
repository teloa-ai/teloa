import test from 'node:test'
import assert from 'node:assert/strict'
import {createProjectApi} from '../src/client/project-api.ts'
const fields={scope:'general',title:'Launch',goal:'Ship',dueDate:null,state:'planning' as const,links:[],references:[]}
const row={...fields,id:'10000000-0000-4000-8000-000000000001',ownerId:'self',version:1,createdAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z'}
test('创建超时与页面重建复用请求身份，不重复创建',async()=>{
 let saved:string|null=null;const calls:Array<Record<string,unknown>>=[],journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}}
 const failing=createProjectApi(async(_endpoint,input)=>{calls.push(input as Record<string,unknown>);throw Error('timeout')},journal)
 await assert.rejects(failing.create(fields));assert.ok(saved)
 const next=createProjectApi(async(_endpoint,input)=>{calls.push(input as Record<string,unknown>);return row},journal)
 assert.deepEqual(next.pendingFields(),fields)
 await assert.rejects(next.create({...fields,title:'Another'}))
 assert.equal((await next.recover()).id,row.id);assert.equal(calls[0]?.requestId,calls[1]?.requestId);assert.equal(saved,null)
})
test('目录拒绝其他业务、重复身份和损坏响应',async()=>{
 for(const result of [[{...row,scope:'SOC'}],[row,row],{}])await assert.rejects(createProjectApi(async()=>result).list('general'))
 await assert.rejects(createProjectApi(async()=>({project:{...row,id:'bad'},items:[],summary:{totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0}})).get(row.id))
})
test('项目资料元信息只匹配当前业务、有效资料与相同来源版本',async()=>{
 const sourceVersion='a'.repeat(64),base={id:row.id,ownerId:'self',title:'同名资料',sourceId:'local-file',sourceVersion,scopeIds:['general'],version:1,status:'active',createdAt:row.createdAt,updatedAt:row.updatedAt}
 const api=createProjectApi(async endpoint=>endpoint==='resources/list'?{drafts:[],resources:[base,{...base,id:'20000000-0000-4000-8000-000000000001',scopeIds:['SOC']},{...base,id:'30000000-0000-4000-8000-000000000001',status:'withdrawn'}]}:[{id:'local-file',title:'原始资料.md',source:'local',version:sourceVersion,bytes:10}])
 assert.deepEqual(await api.materialMetadata('general'),{[row.id]:{sourceTitle:'原始资料.md',updatedAt:row.updatedAt}})
 const stale=createProjectApi(async endpoint=>endpoint==='resources/list'?{drafts:[],resources:[base]}:[{id:'local-file',title:'后来替换的内容',source:'local',version:'b'.repeat(64),bytes:10}])
 assert.deepEqual(await stale.materialMetadata('general'),{[row.id]:{updatedAt:row.updatedAt}},'不把同一来源的新版本标题冒充当前资料的来源')
})
test('编辑校验身份、版本和字段，候选类型不能偷换',async()=>{
 for(const value of [{...row,version:1},{...row,version:2,title:'different'},{...row,version:2,id:'20000000-0000-4000-8000-000000000001'}])await assert.rejects(createProjectApi(async()=>value).edit(row.id,1,fields))
 assert.equal((await createProjectApi(async()=>({...row,version:2})).edit(row.id,1,fields)).version,2)
 await assert.rejects(createProjectApi(async()=>[{kind:'role',id:row.id,title:'Role',state:'active',version:1,available:true,origin:'direct',attention:null}]).candidates('general','task',''))
})
test('创建与编辑透传 references，编辑其他字段保存后引用不丢失',async()=>{
 const references=[{kind:'task' as const,id:'30000000-0000-4000-8000-000000000001',scope:'SOC'}],calls:Array<Record<string,unknown>>=[]
 const api=createProjectApi(async(_endpoint,input)=>{calls.push(input as Record<string,unknown>);return {...row,version:2,title:'Renamed',references}})
 assert.deepEqual((await api.edit(row.id,1,{...fields,title:'Renamed',references})).references,references)
 assert.deepEqual((calls[0]?.fields as {references:unknown}).references,references)
 let saved:string|null=null;const journal={read:()=>saved,write:(value:string)=>{saved=value},clear:()=>{saved=null}}
 await assert.rejects(createProjectApi(async()=>{throw Error('timeout')},journal).create({...fields,references}))
 assert.deepEqual(createProjectApi(async()=>row,journal).pendingFields()?.references,references)
})
test('总览回包行数超过 limit、scope/state 不一致或格式损坏抛错，入参恰好四键',async()=>{
 const calls:Array<Record<string,unknown>>=[],page=(rows:unknown[],nextCursor:string|null=null)=>({rows,nextCursor})
 const api=createProjectApi(async(_endpoint,input)=>{calls.push(input as Record<string,unknown>);return page([row])})
 assert.equal((await api.overview({scope:null,state:null,cursor:null,limit:10})).rows.length,1)
 assert.deepEqual(Object.keys(calls[0]!).sort(),['cursor','limit','scope','state'])
 await assert.rejects(createProjectApi(async()=>page([row,{...row,id:'20000000-0000-4000-8000-000000000001'}])).overview({scope:null,state:null,cursor:null,limit:1}))
 await assert.rejects(createProjectApi(async()=>page([{...row,scope:'SOC'}])).overview({scope:'general',state:null,cursor:null,limit:10}))
 await assert.rejects(createProjectApi(async()=>page([row])).overview({scope:null,state:'archived',cursor:null,limit:10}))
 assert.equal((await createProjectApi(async()=>page([row,{...row,id:'20000000-0000-4000-8000-000000000001',state:'review'}])).overview({scope:null,state:'current',cursor:null,limit:10})).rows.length,2,'current 放行各非归档状态')
 await assert.rejects(createProjectApi(async()=>page([{...row,state:'archived'}])).overview({scope:null,state:'current',cursor:null,limit:10}),'current 回包含归档行即不一致')
 await assert.rejects(createProjectApi(async()=>({rows:[row]})).overview({scope:null,state:null,cursor:null,limit:10}))
 await assert.rejects(createProjectApi(async()=>({project:row,items:[],summary:{totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0}})).get(row.id),'get 缺 references 抛错')
 const edits:Array<Record<string,unknown>>=[];await createProjectApi(async(_e,input)=>{edits.push(input as Record<string,unknown>);return {...row,version:2}}).edit(row.id,1,fields)
 assert.equal(Object.keys(edits[0]!.fields as object).length,7,'编辑提交恰好七键')
})
