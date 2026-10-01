import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {previewProducedFileNatively} from '../src/client/produced-file-preview.ts'
import {artifactPanelTarget} from '../src/client/workbench-detail-target.ts'

const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const store=await readFile(new URL('../src/client/store.ts',import.meta.url),'utf8')
const target=await readFile(new URL('../src/client/workbench-detail-target.ts',import.meta.url),'utf8')
const panel=await readFile(new URL('../src/client/ArtifactPanel.tsx',import.meta.url),'utf8')
const navigation=await readFile(new URL('../src/client/workbench-navigation-state.ts',import.meta.url),'utf8')

const port=(overrides:Partial<Parameters<typeof previewProducedFileNatively>[0]>={})=>{
 const opened:string[]=[]
 return {opened,port:{sessionAvailable:(id:string)=>id==='s1',workspaceCwd:()=>'/work/team',openResource:(address:string)=>{opened.push(address)},...overrides}}
}

test('当前会话内的产出文件转成原生资源地址打开',()=>{
 const {opened,port:value}=port()
 previewProducedFileNatively(value,'s1','/work/team/output/报告.md')
 assert.deepEqual(opened,['dsh-resource://file/session/s1/output/%E6%8A%A5%E5%91%8A.md'])
})

test('相对路径同样接受',()=>{
 const {opened,port:value}=port()
 previewProducedFileNatively(value,'s1','./output/a.py')
 assert.deepEqual(opened,['dsh-resource://file/session/s1/output/a.py'])
})

test('来源会话已释放时拒绝，且不打开任何资源',()=>{
 const {opened,port:value}=port({sessionAvailable:()=>false})
 assert.throws(()=>previewProducedFileNatively(value,'s1','output/a.py'),/来源工作会话/)
 assert.deepEqual(opened,[])
})

test('主会话和子会话同时保留时，预览按来源身份和各自工作目录打开',()=>{
 const {opened,port:value}=port({sessionAvailable:id=>id==='s1'||id==='s2',workspaceCwd:id=>id==='s2'?'/work/child':'/work/team'})
 previewProducedFileNatively(value,'s2','/work/child/output/report.pdf')
 previewProducedFileNatively(value,'s1','/work/team/output/report.pdf')
 assert.deepEqual(opened,['dsh-resource://file/session/s2/output/report.pdf','dsh-resource://file/session/s1/output/report.pdf'])
 assert.throws(()=>previewProducedFileNatively(value,'s2','/work/team/private.txt'),/可预览范围/)
})

test('Office 文件仍以原始路径交给原生资源识别，不改后缀或切换来源会话',()=>{
 const {opened,port:value}=port({sessionAvailable:id=>id==='child',workspaceCwd:()=>'/work/child'})
 for(const name of ['report.docx','slides.pptx','budget.xlsx'])previewProducedFileNatively(value,'child',`/work/child/output/${name}`)
 assert.deepEqual(opened,['report.docx','slides.pptx','budget.xlsx'].map(name=>`dsh-resource://file/session/child/output/${name}`))
})

test('越出工作区或不是可预览路径时拒绝',()=>{
 const {opened,port:value}=port()
 for(const path of ['/other/a.py','../a.py','/work/team/out/../../a.py','output/'])assert.throws(()=>previewProducedFileNatively(value,'s1',path),/可预览范围/)
 assert.deepEqual(opened,[])
})

test('工作区目录未知时拒绝绝对路径，不猜测根目录',()=>{
 const {opened,port:value}=port({workspaceCwd:()=>undefined})
 assert.throws(()=>previewProducedFileNatively(value,'s1','/work/team/a.py'),/可预览范围/)
 assert.deepEqual(opened,[])
})

test('拒绝与失败都带既有错误码，界面才翻得出文案',()=>{
 const code=(work:()=>void)=>{try{work();return ''}catch(cause){return (cause as {code?:string}).code??''}}
 assert.equal(code(()=>previewProducedFileNatively(port({sessionAvailable:()=>false}).port,'s1','output/a.py')),'teloa/forbidden')
 assert.equal(code(()=>previewProducedFileNatively(port().port,'s1','/other/a.py')),'teloa/invalid-input')
 assert.equal(code(()=>previewProducedFileNatively(port({openResource:()=>{throw Error('无人认领该地址')}}).port,'s1','output/a.py')),'teloa/dependency-unavailable')
})

test('Teloa 自建的 produced-file 详情分支已完全移除',()=>{
 for(const source of [frame,store,target,panel,navigation])assert.doesNotMatch(source,/produced-file/)
 assert.doesNotMatch(store,/previewProducedFile/)
 assert.doesNotMatch(panel,/filePath/)
 assert.match(frame,/const artifactOpen=detailTarget\?\.kind==='artifact'/)
})

test('成果面板目标只剩成果来源，不再带文件路径与请求序号',()=>{
 assert.deepEqual(artifactPanelTarget({kind:'artifact',source:{kind:'session',id:'s1'}}),{source:{kind:'session',id:'s1'}})
 assert.deepEqual(artifactPanelTarget({kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t1'}),null)
})
