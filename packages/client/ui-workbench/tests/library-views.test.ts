import assert from 'node:assert/strict'
import test from 'node:test'
import {createKnowledgeEditJournal} from '../src/client/knowledge-edit-journal.ts'
import type {ResourceApi} from '../src/client/resource-api.ts'
import {libraryRows,readLibraryPreferences,visitLibraryResource,toggleLibraryFavorite,libraryPreferenceKey} from '../src/client/library-views.ts'
const owner='self',stamp='2026-10-09T00:00:00Z'
const resource=(id:string,sourceId=id,status='active')=>({id,ownerId:owner,title:id,sourceId,sourceVersion:'a'.repeat(64),scopeIds:['general'],version:1,status,createdAt:stamp,updatedAt:stamp}) as any
const local=resource('local','local_material_11111111-1111-4111-8111-111111111111'), page=resource('policy'), withdrawn=resource('old','old','withdrawn')
const directory={drafts:[],resources:[page,local,withdrawn]}
test('访问视图区分本地与知识页，搜索包含标题，撤回保持事实',()=>{
 assert.deepEqual(libraryRows(directory,[],{view:'local',query:'',preferences:{recent:[],favorites:[]}}).map(row=>row.id),['local'])
 assert.deepEqual(libraryRows(directory,[],{view:'mine',query:'pol',preferences:{recent:[],favorites:[]}}).map(row=>row.id),['policy'])
 assert.equal(libraryRows(directory,[],{view:'mine',query:'',preferences:{recent:[],favorites:[]}}).find(row=>row.id==='old')?.status,'withdrawn')
})
test('最近仅显式访问写入，去重排序；收藏取消；目录交集排除已移除资料',()=>{
 let prefs=visitLibraryResource({recent:[],favorites:[]},'local',1)
 prefs=visitLibraryResource(prefs,'policy',2);prefs=visitLibraryResource(prefs,'local',3)
 prefs=toggleLibraryFavorite(prefs,'policy');prefs=toggleLibraryFavorite(prefs,'removed')
 assert.deepEqual(libraryRows(directory,[],{view:'recent',query:'',preferences:prefs}).map(row=>row.id),['local','policy'])
 assert.deepEqual(libraryRows(directory,[],{view:'star',query:'',preferences:prefs}).map(row=>row.id),['policy'])
 assert.deepEqual(toggleLibraryFavorite(prefs,'policy').favorites,['removed'])
})
test('偏好损坏安全回退、去重、限制长度，键区分本人空间',()=>{
 assert.deepEqual(readLibraryPreferences('{oops'),{recent:[],favorites:[]})
 assert.deepEqual(readLibraryPreferences(JSON.stringify({recent:[{id:'ok',at:1},{id:'ok',at:2},{id:'bad',at:-1},{id:'overflow',at:Number.MAX_SAFE_INTEGER}],favorites:['a','a',42]})),{recent:[{id:'ok',at:2}],favorites:['a']})
 assert.notEqual(libraryPreferenceKey('a','space'),libraryPreferenceKey('b','space'))
 assert.notEqual(libraryPreferenceKey('a','space'),libraryPreferenceKey('a','another'))
})


test('独立知识行来自真实来源与页面，无投影仍可浏览文件夹，已有投影不重复',()=>{
 const id='11111111-1111-4111-8111-111111111111',source:any={id:'knowledge_'+id,title:'本人原知识',version:'a'.repeat(64),bytes:1,source:'knowledge:'+id+'@1',knowledge:{knowledgeId:id,knowledgeVersion:1,workspaceId:'default',category:'reference',topics:[],scopeIds:['general']}},tree:any={space:{workspaceId:'default'},nodes:[{id:'root',title:'知识库',type:'space'},{id:'page',type:'page',knowledgeId:id,title:source.title,path:['root','page']}]},options={view:'mine' as const,query:'',preferences:{recent:[],favorites:[]},tree}
 const rows=libraryRows({drafts:[],resources:[]},[source],options)
 assert.deepEqual(rows.map(row=>[row.kind,row.id,row.status]),[['knowledge',id,'saved']])
 assert.equal(libraryRows({drafts:[],resources:[]},[source],{...options,view:'space',knowledgeIds:new Set([id])}).length,1)
 assert.equal(libraryRows({drafts:[],resources:[]},[source],{...options,view:'local'}).length,0)
 assert.equal(libraryRows({drafts:[],resources:[resource('projection',source.id)]},[source],options).filter(row=>row.kind==='knowledge').length,0)
})

test('知识编辑草稿按API、宿主存储、本人和原对象隔离，存储失败保留当前内存新稿',()=>{
 const api={} as ResourceApi,id='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333',base={knowledgeId:id,ownerId:'self',sourceId,sourceType:'paste' as const,version:1,contentHash:'a'.repeat(64),bytes:1,createdAt:'2026-10-21T00:00:00Z'},memory=new Map<string,string>()
 let quota=false
 const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw Error('QuotaExceededError');memory.set(key,value)},removeItem:(key:string)=>{memory.delete(key)}}
 const journal=createKnowledgeEditJournal(api,'self',id,storage),draft={base,markdown:'新稿',requestId}
 journal.write(draft)
 assert.deepEqual(createKnowledgeEditJournal({} as ResourceApi,'self',id,storage).read(),draft,'新API只能从同宿主持久值恢复')
 assert.equal(createKnowledgeEditJournal(api,'other',id,storage).read(),undefined)
 assert.equal(createKnowledgeEditJournal(api,'self',sourceId,storage).read(),undefined)
 assert.equal(createKnowledgeEditJournal(api,'self',id,{...storage,getItem:()=>null}).read(),undefined,'同API换宿主存储也不能读回旧内存稿')
 quota=true;journal.write({...draft,markdown:'内存更新'})
 assert.equal(createKnowledgeEditJournal(api,'self',id,storage).read()?.markdown,'内存更新')
 assert.equal(journal.warning(),true)
 journal.clear(sourceId);assert.ok(journal.read(),'旧回执不能清新请求草稿')
 journal.clear(requestId);assert.equal(journal.read(),undefined)
})
