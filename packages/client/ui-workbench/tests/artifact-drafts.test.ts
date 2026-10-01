import test from 'node:test'
import assert from 'node:assert/strict'
import { createArtifact,changeArtifact,type ArtifactSource } from '../src/client/artifact-preview.ts'
import { artifactDraftKey,clearArtifactRevision,recoverArtifactRevision,type ArtifactDraft } from '../src/client/artifact-drafts.ts'
const now='2026-09-11T05:10:00Z'
const source:ArtifactSource={ref:{kind:'session',id:'s1'},title:'研究',scope:'general',version:'b1',author:'本人',evidence:[],private:true}
const old=createArtifact({id:'a1',source,title:'工作稿',sections:[{id:'a',title:'A',text:'原 A'},{id:'b',title:'B',text:'原 B'}],note:'初稿',now})
const artifact=changeArtifact(old,{type:'revise',expectedVersion:1,sectionId:'b',text:'新 B',note:'先保存 B',now},source)
const draft:ArtifactDraft={title:'工作稿',body:'未保存 A',note:'修改 A',feedback:'未提交反馈',feedbackId:'old-feedback',stamp:'old-source'}
test('保存修订只清理修订字段，同版本未提交反馈继续保留',()=>{
  const key=artifactDraftKey('a1',1,'a'),other=artifactDraftKey('a1',1,'b'),state={[key]:draft,[other]:{...draft,body:'未保存 B'}}
  const next=clearArtifactRevision(state,artifact,1,'a')
  assert.equal(next[key]!.feedback,'未提交反馈');assert.equal(next[key]!.body,'原 A');assert.equal(next[key]!.note,'');assert.equal(next[key]!.feedbackId,'')
  assert.deepEqual(next[other],state[other]);assert.equal(state[key]!.body,'未保存 A')
})
test('旧基线草稿明确接到最新版，保留旧版反馈且不跨版关联反馈 ID',()=>{
  const key=artifactDraftKey('a1',1,'a'),nextKey=artifactDraftKey('a1',2,'a')
  const next=recoverArtifactRevision({[key]:draft},artifact,1,'a',source)
  assert.equal(next[nextKey]!.body,'未保存 A');assert.match(next[nextKey]!.note,/v1/)
  assert.equal(next[nextKey]!.feedbackId,'');assert.equal(next[nextKey]!.feedback,'');assert.equal(next[key]!.feedback,'未提交反馈')
  assert.equal(next[key]!.body,'原 A');assert.equal(artifact.versions[1]!.sections[1]!.text,'新 B')
})
test('最新版已有草稿时拒绝覆盖，处理后才能迁移；其他来源不能接续',()=>{
  const key=artifactDraftKey('a1',1,'a'),nextKey=artifactDraftKey('a1',2,'a'),state={[key]:draft,[nextKey]:{...draft,body:'另一份新版修改'}}
  assert.throws(()=>recoverArtifactRevision(state,artifact,1,'a',source),/已有/)
  assert.equal(state[nextKey]!.body,'另一份新版修改')
  assert.throws(()=>recoverArtifactRevision({[key]:draft},artifact,1,'a',{...source,ref:{kind:'session',id:'other'}}),/来源/)
})
