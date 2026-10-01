import test from 'node:test'
import assert from 'node:assert/strict'
import { createArtifact, changeArtifact, artifactMarkdown, type ArtifactSource } from '../src/client/artifact-preview.ts'
import { nativeImagePreviewControl } from '../src/client/artifact-native.ts'
const now='2026-09-11T06:00:00Z'
const labels=(key:string,params:Readonly<Record<string,string|number>>={})=>(key+' '+Object.values(params).join(' '))
const source:ArtifactSource={ref:{kind:'session',id:'s1'},title:'原生会话',scope:'general',version:'b1',author:'本人',private:true,evidence:[]}
const message={sessionId:'s1',messageId:'m1',seq:8,role:'user' as const,at:now,text:'查看附件',interrupted:false,omittedBlocks:0,images:[{blockIndex:1,attachment:{attachmentId:'sha256:abc',mediaType:'image/png' as const,bytes:325,width:128,height:96,name:'图.png'}}]}
const input=()=>({id:'a1',source,title:'图片工作稿',sections:[{id:'p1',title:'结论',text:'已核对'}],note:'选取原消息',now,messages:[structuredClone(message)]})
test('选取的原生消息与图片身份固定在产物版本，修订及导出不丢来源',()=>{
  const command=input(),a=createArtifact(command)
  assert.deepEqual(Reflect.get(a.versions[0]!,'messages'),[message])
  command.messages[0]!.images[0]!.attachment.name='不应覆盖原版.png'
  const next=changeArtifact(a,{type:'revise',expectedVersion:1,sectionId:'p1',text:'进一步核对',note:'补充结论',now},source)
  assert.deepEqual(Reflect.get(next.versions[1]!,'messages'),[message])
  const md=artifactMarkdown(next,1,labels)
  assert.match(md,/m1/);assert.match(md,/sha256:abc/);assert.match(md,/图.png/)
  assert.doesNotMatch(md,/不应覆盖原版|blob:|data:image/)
})
test('会话附件不能跟随另一来源保存，也不能把同一消息重复计入',()=>{
  assert.throws(()=>createArtifact({...input(),source:{...source,ref:{kind:'session',id:'s2'}}}),/来源|会话/)
  assert.throws(()=>createArtifact({...input(),messages:[message,message]}),/重复/)
})

test('图片只有成功解码后才提供放大和收起操作',()=>{
  assert.equal(nativeImagePreviewControl(false,false),null)
  assert.deepEqual(nativeImagePreviewControl(true,false),{label:'放大图片预览',expanded:true})
  assert.deepEqual(nativeImagePreviewControl(true,true),{label:'收起图片预览',expanded:false})
})
