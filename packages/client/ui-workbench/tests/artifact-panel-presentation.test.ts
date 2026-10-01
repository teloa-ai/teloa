import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {createElement} from 'react'
import {ArtifactPanelMoreActions,artifactPanelArtifacts,artifactPanelMoreActions,artifactPanelStart,artifactPanelViews} from '../src/client/artifact-panel-presentation.ts'

const source=await readFile(new URL('../src/client/ArtifactPanel.tsx',import.meta.url),'utf8')

test('成果目录为空时才进入独立创建模式',()=>{
 assert.deepEqual(artifactPanelStart([]),{mode:'create',selected:null})
 assert.deepEqual(artifactPanelStart([{id:'older',primary:false,updatedAt:'2026-09-11T00:00:00Z'},{id:'latest',primary:false,updatedAt:'2026-09-12T00:00:00Z'}]),{mode:'read',selected:'latest'})
 assert.deepEqual(artifactPanelStart([{id:'latest',primary:false,updatedAt:'2026-09-12T00:00:00Z'},{id:'main',primary:true,updatedAt:'2026-09-10T00:00:00Z'}]),{mode:'read',selected:'main'})
 assert.deepEqual(artifactPanelStart([{id:'main',primary:true,updatedAt:'2026-09-10T00:00:00Z'}],'fixed'),{mode:'read',selected:'main'})
})

test('明确指定且仍可访问的成果优先，并默认进入预览',()=>{
 const rows=[{id:'main',primary:true,updatedAt:'2026-09-12T00:00:00Z'},{id:'fixed',primary:false,updatedAt:'2026-09-11T00:00:00Z'}]
 assert.deepEqual(artifactPanelStart(rows,'fixed'),{mode:'read',selected:'fixed'})
 assert.deepEqual(artifactPanelViews(),['preview','files','versions'])
 assert.match(source,/useState<ArtifactPanelView>\('preview'\)/)
})

test('指定成果不存在时不回退打开另一份成果',()=>{
 const rows=[{id:'main',primary:true,updatedAt:'2026-09-12T00:00:00Z'}]
 assert.deepEqual(artifactPanelStart(rows,'missing',true),{mode:'missing',selected:null})
 assert.deepEqual(artifactPanelStart([],'missing',true),{mode:'missing',selected:null})
})

test('指定成果版本不存在时不回退打开最新版本',()=>{
 const rows=[{id:'fixed',primary:true,updatedAt:'2026-09-12T00:00:00Z',versions:[1,2]}]
 assert.deepEqual(artifactPanelStart(rows,'fixed',true,3),{mode:'missing',selected:null})
})

test('关闭成果不渲染 dialog，面板不再自行读取文件；切换宿主在绘制前收起原对话框',()=>{
 assert.match(source,/if \(!open \|\| !target\)\s+return null/)
 assert.doesNotMatch(source,/artifactFileApi\.read\(/)
 assert.match(source,/useLayoutEffect\(\(\) => \{\s+if \(!open \|\| !target\)/)
 assert.match(source,/\[targetKey, open\]/)
 assert.doesNotMatch(source,/setDrafts\(\{\}\)|setFileDrafts\(\{\}\)/)
})

test('更多操作按成果持久化和原任务终态组合分流',()=>{
 assert.deepEqual(artifactPanelMoreActions('persistent',true),{
  showLinkAndReview:false,showFollow:false,showRevision:false,capabilityBoundary:'locked',
 })
 assert.deepEqual(artifactPanelMoreActions('persistent',false),{
  showLinkAndReview:false,showFollow:false,showRevision:true,capabilityBoundary:'active',
 })
 assert.deepEqual(artifactPanelMoreActions(undefined,true),{
  showLinkAndReview:true,showFollow:true,showRevision:false,capabilityBoundary:null,
 })
 assert.deepEqual(artifactPanelMoreActions(undefined,false),{
  showLinkAndReview:true,showFollow:false,showRevision:true,capabilityBoundary:null,
 })
})

test('正式工作成果与界面示例在目录和关联候选中完全隔离',()=>{
 const artifacts=[{id:'saved-a',storage:'persistent' as const},{id:'example-a'},{id:'saved-b',storage:'persistent' as const}]
 assert.deepEqual(artifactPanelArtifacts(artifacts,true).map(item=>item.id),['saved-a','saved-b'])
 assert.deepEqual(artifactPanelArtifacts(artifacts,false).map(item=>item.id),['example-a'])
 assert.match(source,/artifactPanelArtifacts\(state\.artifacts,persistentSource\)/)
})

test('更多操作按组合渲染真实表单、按钮和能力边界',()=>{
 const render=(storage:'persistent'|undefined,locked:boolean)=>renderToStaticMarkup(createElement(ArtifactPanelMoreActions,{actions:artifactPanelMoreActions(storage,locked),activeBoundary:'ACTIVE',lockedBoundary:'LOCKED',link:createElement('form',{'aria-label':'link'}),review:createElement('button',{type:'button'},'review'),follow:createElement('form',{'aria-label':'follow'}),revision:createElement('form',{'aria-label':'revision'}),exportAction:createElement('button',{type:'button'},'export')}))
 const persistentLocked=render('persistent',true),persistentActive=render('persistent',false),previewLocked=render(undefined,true),previewActive=render(undefined,false)
 assert.match(persistentLocked,/LOCKED/)
 assert.doesNotMatch(persistentLocked,/aria-label="(?:link|follow|revision)"|>review</)
 assert.match(persistentActive,/ACTIVE/)
 assert.match(persistentActive,/aria-label="revision"/)
 assert.doesNotMatch(persistentActive,/aria-label="(?:link|follow)"|>review</)
 assert.match(previewLocked,/aria-label="link"/)
 assert.match(previewLocked,/aria-label="follow"/)
 assert.match(previewLocked,/>review</)
 assert.doesNotMatch(previewLocked,/aria-label="revision"|ACTIVE|LOCKED/)
 assert.match(previewActive,/aria-label="link"/)
 assert.match(previewActive,/>review</)
 assert.match(previewActive,/aria-label="revision"/)
 assert.doesNotMatch(previewActive,/aria-label="follow"|ACTIVE|LOCKED/)
})

test('既有成果使用三段信息架构，低频操作按需展开',()=>{
 assert.match(source,/aria-label=\{t\("artifact\.panel\.text\.044"\)\}/)
 assert.match(source,/onClick=\{\(\) => setView\('preview'\)\}>\{t\("artifact\.panel\.text\.045"\)\}<\/button>/)
 assert.match(source,/onClick=\{\(\) => setView\('files'\)\}>\{t\("artifact\.panel\.text\.046"\)\}<\/button>/)
 assert.match(source,/onClick=\{\(\) => setView\('versions'\)\}>\{t\("artifact\.panel\.text\.047"\)\}<\/button>/)
 assert.match(source,/<summary>\{t\("artifact\.panel\.text\.082"\)\}<\/summary>/)
 assert.doesNotMatch(source,/<button[^>]*>\{t\("artifact\.panel\.text\.027"\)\}<\/button>/)
})
