import assert from 'node:assert/strict'
import test from 'node:test'
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
