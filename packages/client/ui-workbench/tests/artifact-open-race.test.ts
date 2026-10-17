import assert from 'node:assert/strict'
import test from 'node:test'
import type {GroupMessage,MessageReference} from '@teloa/contract'
import {groupHasSharedArtifactReference,groupSharedResults} from '../src/client/group-result-index.ts'

const reference=(version:number):MessageReference=>({kind:'artifact',id:'original-report',version})
const message=(id:string,groupId:string,version:number,rootId:string|null=null):GroupMessage=>({id,groupId,rootId,authorId:'self',text:'原始引用',references:[reference(version)],mentions:[],createdAt:'2026-10-12T00:00:00Z'})
// 加载取消、关闭和换群的真实 React 生命周期在 group-fixed-preview.browser.test.ts 中覆盖。
test('群预览只接受同群真实固定引用；来源相同但未共享的最新版本仍拒绝',()=>{
 const rows=[message('shared','one',2),message('private','two',3)]
 assert.equal(groupHasSharedArtifactReference('one',rows,reference(2)),true)
 assert.equal(groupHasSharedArtifactReference('one',rows,reference(3)),false)
 assert.equal(groupHasSharedArtifactReference('one',rows,{...reference(2),id:'private-report'}),false)
 assert.equal(groupHasSharedArtifactReference('one',rows,{kind:'group-resource',id:'original-report',version:2}),false)
})
test('主目录与话题引用均可预览，重复引用仍只产生同一固定版本行',()=>{
 const rows=[message('root','one',1),message('reply','one',2,'root'),message('repeat','one',2)]
 assert.equal(groupHasSharedArtifactReference('one',rows,reference(1)),true)
 assert.equal(groupHasSharedArtifactReference('one',rows,reference(2)),true)
 assert.deepEqual(groupSharedResults('one',rows).map(row=>[row.reference.version,row.historical]),[[2,false],[1,true]])
})
test('切群或消息引用失效后，旧群和旧话题的目标不能再消费白名单',()=>{
 const rows=[message('shared','one',2)]
 assert.equal(groupHasSharedArtifactReference('two',rows,reference(2)),false)
 assert.equal(groupHasSharedArtifactReference('one',[],reference(2)),false)
})
