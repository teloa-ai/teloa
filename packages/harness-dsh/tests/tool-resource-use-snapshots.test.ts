import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createToolResourceUseSnapshots,resourceUseSnapshotSessionScope} from '../src/tool-resource-use-snapshots.ts'
import type {ToolResourceUseSnapshot} from '../src/tool-resource-provenance.ts'

const snapshot=(sessionId='parent',rest:Partial<ToolResourceUseSnapshot>={}):ToolResourceUseSnapshot=>({schema:'teloa.resource-use-snapshot/v1',sessionId,parentCallSeq:4,startSeq:5,parentCallId:'outer',use:{schema:'teloa.resource-use/v1',kind:'mcp',providerId:'server',name:'Search',toolName:'mcp_search',state:'used',callId:'nested',rootCallId:'outer'},...rest})
test('fork 继承目录不授权；仅本会话持久化的直系子身份进入快照读范围',()=>{
 const child=(childId:unknown)=>({type:'subagent/catalog',data:{childId}})
 assert.deepEqual(resourceUseSnapshotSessionScope('parent',[child('ancestor-child'),{type:'session/end-seed',data:{inherited:true}},child('owned-child'),child('owned-child'),child('../foreign')]),['parent','owned-child'])
 assert.deepEqual(resourceUseSnapshotSessionScope('parent',[child('child'),{type:'session/end-seed',data:{inherited:false}}]),['parent','child'])
})
async function fixture(t:TestContext){
 const owned=await realpath(await mkdtemp(join(tmpdir(),'teloa-resource-use-'))),root=join(owned,'resource-use'),calls:string[]=[]
 t.after(()=>rm(owned,{recursive:true,force:true}))
 const store=createToolResourceUseSnapshots({root,authorize:async sessionId=>{calls.push(sessionId);if(sessionId!=='parent')throw Error('denied');return ['parent','child']}})
 return {owned,root,calls,store}
}

test('实际来源元数据原子持久化并在重建后保留，父读取仅包含授权父子',async t=>{
 const f=await fixture(t)
 await f.store.record(snapshot());await f.store.record(snapshot('child'));await f.store.record(snapshot('foreign'))
 const fresh=createToolResourceUseSnapshots({root:f.root,authorize:async()=>['parent','child']})
 assert.deepEqual((await fresh.list({sessionId:'parent'})).map(row=>row.sessionId),['child','parent'])
 const names=await readdir(join(f.root,'parent'));assert.equal(names.length,1);assert.match(names[0]!,/^[a-f0-9]{64}\.json$/)
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'parent',names[0]!),'utf8')),snapshot())
 await assert.rejects(f.store.list({sessionId:'foreign'}),/denied/);assert.deepEqual(f.calls,['foreign'])
})

test('并发相同身份幂等，冲突元数据拒绝且不改写原快照',async t=>{
 const f=await fixture(t),row=snapshot();await Promise.all(Array.from({length:8},()=>f.store.record(row)))
 assert.equal((await readdir(join(f.root,'parent'))).length,1)
 await assert.rejects(f.store.record({...row,use:{...row.use,name:'Other'}}),/conflict|冲突/)
 assert.deepEqual(await f.store.list({sessionId:'parent'}),[row])
})

test('拒绝路径穿越、身份不一致、工具args与未声明secret，非法输入不创建目录',async t=>{
 const f=await fixture(t)
 for(const row of [snapshot('../escape'),snapshot('parent/path'),{...snapshot(),parentCallSeq:5,startSeq:4},{...snapshot(),parentCallId:'other'},{...snapshot(),args:{password:'secret'}},{...snapshot(),use:{...snapshot().use,token:'secret'}}])await assert.rejects(f.store.record(row as ToolResourceUseSnapshot),/invalid|无效/)
 await assert.rejects(f.store.list({sessionId:'../parent'}),/invalid|无效/);assert.deepEqual(f.calls,[])
 await assert.rejects(readdir(f.root),{code:'ENOENT'})
})

test('根、会话目录和快照文件的symlink全部阻断，不读取或覆盖链接目标',async t=>{
 const f=await fixture(t),outside=join(f.owned,'outside');await mkdir(outside);await symlink(outside,f.root)
 await assert.rejects(f.store.record(snapshot()),/symlink|目录|corrupt/);await assert.rejects(f.store.list({sessionId:'parent'}),/symlink|目录|corrupt/)
 await rm(f.root);await mkdir(f.root);await symlink(outside,join(f.root,'parent'))
 await assert.rejects(f.store.record(snapshot()),/symlink|目录|corrupt/);await assert.rejects(f.store.list({sessionId:'parent'}),/symlink|目录|corrupt/)
 await rm(join(f.root,'parent'));await f.store.record(snapshot())
 const file=join(f.root,'parent',(await readdir(join(f.root,'parent')))[0]!),target=join(outside,'target.json');await writeFile(target,'private');await rm(file);await symlink(target,file)
 await assert.rejects(f.store.list({sessionId:'parent'}),/symlink|文件|corrupt/);await assert.rejects(f.store.record(snapshot()),/symlink|文件|corrupt/);assert.equal(await readFile(target,'utf8'),'private')
})

test('有界读取拒绝过大文件、内容身份不匹配和损坏JSON',async t=>{
 const f=await fixture(t);await f.store.record(snapshot());const file=join(f.root,'parent',(await readdir(join(f.root,'parent')))[0]!)
 await writeFile(file,' '.repeat(65537));await assert.rejects(f.store.list({sessionId:'parent'}),/limit|过大|corrupt/)
 await writeFile(file,JSON.stringify(snapshot('child')));await assert.rejects(f.store.list({sessionId:'parent'}),/identity|身份|corrupt/)
 await writeFile(file,'{');await assert.rejects(f.store.list({sessionId:'parent'}),/JSON|corrupt/)
})

test('只保留契约规定的实际搜索查询和来源，拒绝任意执行参数与无限制数据',async t=>{
 const f=await fixture(t),row=snapshot(),search={...row,use:{...row.use,kind:'web' as const,queries:['actual query'],sources:[{url:'https://example.com',title:'Source',snippet:'Actual snippet'}],truncated:false,answer:'Actual answer'}}
 await f.store.record(search);assert.deepEqual(await f.store.list({sessionId:'parent'}),[search])
 await assert.rejects(f.store.record({...row,startSeq:6,use:{...row.use,answer:'a'.repeat(65536)}}),/limit|过大|无效/)
})
