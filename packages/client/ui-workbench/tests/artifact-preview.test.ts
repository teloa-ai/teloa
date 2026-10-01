import test from 'node:test'
import assert from 'node:assert/strict'
import { createArtifact, changeArtifact, artifactMarkdown, sourceKey, type ArtifactSource } from '../src/client/artifact-preview.ts'
const now='2026-09-11T05:00:00Z'
const source:ArtifactSource={ref:{kind:'session',id:'session-1'},title:'资料研究',scope:'general',version:'binding-1',author:'本人',evidence:['公开资料 A · v1'],private:true}
const make=()=>createArtifact({id:'a1',source,title:'资料稿',sections:[{id:'p1',title:'结论',text:'原结论'},{id:'p2',title:'依据',text:'原依据'}],note:'本人整理',now})
const english=(key:string,params:Readonly<Record<string,string|number>>={})=>({
 'artifact.export.status.preview':'In-page draft · Personal work output; not published or approved.',
 'artifact.export.version':'Version: {version} · {author} · {at}',
 'artifact.export.source.heading':'Source and evidence',
 'artifact.export.source.identity':'{title} · {kind} · {id} · source version {version}',
 'artifact.export.source.meta':'Scope: {scope} · Original author: {author}',
 'artifact.export.source.private':'This source is a personal session and is not shared automatically.',
 'artifact.export.revision.heading':'Revision note',
}[key]??key).replace(/\{(\w+)\}/g,(_,name:string)=>String(params[name]??''))
const chinese=(key:string,params:Readonly<Record<string,string|number>>={})=>({
 'artifact.export.status.persistent':'已保存到本机 · 本人工作成果；未发布或批准。',
 'artifact.export.status.preview':'界面演示 · 本人工作成果；未发布或批准。',
 'artifact.export.version':'版本：{version} · {author} · {at}',
 'artifact.export.source.heading':'来源与依据',
 'artifact.export.source.identity':'{title} · {kind} · {id} · 来源版本 {version}',
 'artifact.export.source.meta':'范围：{scope} · 原作者：{author}',
 'artifact.export.source.private':'来源为本人会话，不自动共享。',
 'artifact.export.source.shared':'来源关联不代表共享授权。',
 'artifact.export.revision.heading':'修改说明',
 'artifact.export.feedback':'关联反馈：{id}',
}[key]??key).replace(/\{(\w+)\}/g,(_,name:string)=>String(params[name]??''))
test('真实成果导出不标为演示，示例仍明确区分',()=>{
 assert.match(artifactMarkdown(make(),1,chinese),/界面演示/)
 const saved={...make(),storage:'persistent' as const}
 assert.doesNotMatch(artifactMarkdown(saved,1,chinese),/界面演示/)
 assert.match(artifactMarkdown(saved,1,chinese),/已保存到本机/)
})
test('产物版本深拷贝来源，修订不覆盖旧段落、依据及作者',()=>{
  const original=make(),before=structuredClone(original)
  const next=changeArtifact(original,{type:'revise',expectedVersion:1,sectionId:'p1',text:'新结论',note:'纠正日期',now},source)
  assert.deepEqual(original,before);assert.equal(next.versions.length,2)
  assert.equal(next.versions[0]!.sections[0]!.text,'原结论');assert.equal(next.versions[1]!.sections[0]!.text,'新结论')
  assert.equal(next.versions[1]!.sections[1]!.text,'原依据')
  next.versions[1]!.source.evidence.push('新记录')
  assert.deepEqual(next.versions[0]!.source.evidence,['公开资料 A · v1']);assert.deepEqual(source.evidence,['公开资料 A · v1'])
})
test('反馈固定版本与段落，错误来源、旧基线或串段落不能修订',()=>{
  let a=changeArtifact(make(),{type:'feedback',id:'f1',version:1,sectionId:'p2',text:'补足依据',now},source)
  assert.throws(()=>changeArtifact(a,{type:'revise',expectedVersion:1,sectionId:'p1',feedbackId:'f1',text:'修订',note:'修改',now},source),/反馈/)
  a=changeArtifact(a,{type:'revise',expectedVersion:1,sectionId:'p2',feedbackId:'f1',text:'完整依据',note:'采纳反馈',now},source)
  assert.equal(a.versions[1]!.feedbackId,'f1');assert.equal(a.feedback[0]!.version,1)
  assert.throws(()=>changeArtifact(a,{type:'revise',expectedVersion:1,sectionId:'p2',text:'覆盖',note:'修改',now},source),/版本/)
  assert.throws(()=>changeArtifact(a,{type:'feedback',id:'f2',version:99,sectionId:'p2',text:'串版',now},source),/版本/)
  assert.throws(()=>changeArtifact(a,{type:'revise',expectedVersion:2,sectionId:'p2',text:'覆盖',note:'修改',now},{...source,ref:{kind:'session',id:'other'}}),/来源/)
})
test('旧版导出仅含该版正文与来源；来源身份包含业务和类型',()=>{
  const a=changeArtifact(make(),{type:'revise',expectedVersion:1,sectionId:'p1',text:'不应出现在旧版',note:'新版说明',now},source)
  const md=artifactMarkdown(a,1,chinese)
  assert.match(md,/原结论/);assert.match(md,/公开资料 A/);assert.match(md,/界面演示/);assert.doesNotMatch(md,/不应出现在旧版|新版说明/)
  assert.notEqual(sourceKey({kind:'object',id:'same',scope:'SOC',objectType:'alert'}),sourceKey({kind:'object',id:'same',scope:'AppSec',objectType:'alert'}))
  assert.notEqual(sourceKey({kind:'object',id:'same',scope:'SOC',objectType:'alert'}),sourceKey({kind:'object',id:'same',scope:'SOC',objectType:'asset'}))
})

test('成果 Markdown 按当前语言生成固定结构并保留动态正文与来源身份',()=>{
  const md=artifactMarkdown(make(),1,english)
  assert.match(md,/In-page draft · Personal work output; not published or approved\./)
  assert.match(md,/## Source and evidence/)
  assert.match(md,/Scope: general · Original author: 本人/)
  assert.match(md,/## 结论\n\n原结论/)
  assert.match(md,/资料研究 · session · session-1 · source version binding-1/)
})
