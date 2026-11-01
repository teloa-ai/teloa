import {readArtifactInputSourceMarker} from '@teloa/contract'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createArtifact,type Artifact} from '../src/client/artifact-preview.ts'
import {artifactModificationPreparation} from '../src/client/artifact-modification-preparation.ts'

const file={schema:'teloa.file-snapshot/v1' as const,sessionId:'source',id:'a'.repeat(64),path:'outputs/demo.mp4',sha256:'b'.repeat(64),bytes:8,capturedAt:'2026-10-28T00:00:00Z',contentBase64:'AAAAHGZ0eXA='}
function saved():Artifact{return {...createArtifact({id:'11111111-1111-4111-8111-111111111111',title:'一份多格式成果',source:{ref:{kind:'session',id:'source'},title:'本人工作',scope:'general',version:'1',author:'本人',evidence:[],private:true},sections:[{id:'body',title:'说明',text:'原文不自动覆盖'}],files:[file],note:'本人确认',now:'2026-10-28T00:00:00Z'}),storage:'persistent'}}
test('修改准备绑定真实成果版本和选定文件；不把视频转为Markdown或继承旧执行权限',()=>{
 for(const locale of ['zh-CN','zh-Hant','en']){const artifact=saved(),before=JSON.stringify(artifact),input='把开头缩短到两秒。\n保留原有画面比例。',row=artifactModificationPreparation(artifact,1,input,file,locale)
  assert.equal(row.scope,'general');assert.equal(row.artifactId,artifact.id);assert.equal(row.version,1);assert.ok(row.goal.includes(input));assert.ok(row.goal.includes(file.path));assert.ok(row.goal.includes(file.sha256));assert.ok(!row.goal.includes(file.contentBase64));assert.equal(JSON.stringify(artifact),before)
 }
})
test('旧版、预览、错文件身份/摘要/路径与空要求在准备之前拒绝',()=>{
 const artifact=saved(),{storage,...preview}=artifact
 for(const item of [{artifact:preview,version:1,file},{artifact,version:2,file},{artifact:{...artifact,versions:[...artifact.versions,{...artifact.versions[0]!,number:2}]},version:1,file},...['id','sha256','path'].map(key=>({artifact,version:1,file:{...file,[key]:'wrong'}}))])assert.throws(()=>artifactModificationPreparation(item.artifact,item.version,'修改这份文件',item.file,'zh-CN'))
 assert.throws(()=>artifactModificationPreparation(artifact,1,' ',file,'zh-CN'))
 assert.throws(()=>artifactModificationPreparation(artifact,1,'字'.repeat(4001),file,'zh-CN'))
})
test('整份成果同样固定版本；无文件成果不要求伪造附件或段落',()=>{
 const artifact=saved();artifact.versions[0]!.files=[];artifact.versions[0]!.sections=[]
 const row=artifactModificationPreparation(artifact,1,'只调整排版。',undefined,'zh-CN');assert.equal(row.artifactId,artifact.id);assert.equal(row.version,1);assert.ok(row.goal.includes('只调整排版。'));assert.ok(row.goal.includes('整份成果'))
})

test('修改输入携带共享的整行固定来源，交给最终发送守卫核对',()=>{
 const artifact=saved(),row=artifactModificationPreparation(artifact,1,'只调整排版。',undefined,'zh-CN')
 assert.deepEqual(row.goal.split('\n').map(readArtifactInputSourceMarker).filter(Boolean),[{artifactId:artifact.id,version:1}])
})
