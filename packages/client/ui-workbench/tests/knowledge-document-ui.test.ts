import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

test('知识文档采用 GitHub 式 Markdown 编辑预览与不可变版本记录',async()=>{
 const [document,editor,documentCss,editorCss]=await Promise.all([
  readFile(new URL('../src/client/KnowledgeDocument.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/KnowledgeMarkdownEditor.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/KnowledgeDocument.module.css',import.meta.url),'utf8'),
  readFile(new URL('../src/client/KnowledgeMarkdownEditor.module.css',import.meta.url),'utf8'),
 ])
 assert.match(editor,/t\("knowledge\.ui\.068"\)/)
 assert.match(editor,/t\("knowledge\.ui\.069"\)/)
 assert.match(editor,/t\("knowledge\.ui\.070"\)/)
 assert.match(editor,/t\("knowledge\.ui\.071"\)/)
 assert.match(editor,/t\("knowledge\.ui\.073"\)/)
 assert.match(document,/t\("knowledge\.ui\.035"\)/)
 assert.match(document,/t\("knowledge\.ui\.025"\)/)
 assert.match(document,/t\("knowledge\.ui\.021"\)/)
 assert.match(document,/inspectorOpen \? t\("knowledge\.ui\.018"\) : t\("knowledge\.ui\.019"\)/)
 assert.match(document,/t\("knowledge\.ui\.022"\)/)
 assert.match(document,/inspectorOpen\s*&&\s*<aside/)
 assert.match(document,/source\.title/)
 assert.match(document,/t\("knowledge\.ui\.015"\)/)
 assert.match(document,/t\("knowledge\.ui\.044"\)/)
 assert.match(document,/t\("knowledge\.ui\.050"\)/)
 assert.match(document,/t\("knowledge\.ui\.048"\)/)
 assert.match(document,/expectedKnowledgeVersion/)
 assert.match(document,/expectedResourceVersion/)
 assert.match(document,/api\.reviseKnowledgeResource/)
 assert.match(document,/api\.restoreKnowledgeResource/)
 assert.match(document,/t\("knowledge\.ui\.046"\)/)
 assert.match(document,/t\("knowledge\.ui\.047"\)/)
 assert.match(document,/t\('knowledge\.versionAria'/)
 assert.match(document,/t\("knowledge\.ui\.057"\)/)
 assert.match(document,/t\("knowledge\.ui\.045"\)/)
 const header=document.slice(document.indexOf('if (!knowledge)'),document.indexOf('{source && resource.sourceVersion'))
 assert.doesNotMatch(header,/className=\{css\.metadata\}/,'版本、来源和治理信息只在右上角更多菜单展开后显示')
 assert.match(document,/inspectorOpen\s*&&\s*<aside[\s\S]*className=\{css\.versionList\}/,'版本历史仍保留在右上角更多菜单打开的信息面板中')
 assert.match(editor,/t\("knowledge\.ui\.072"\)/)
 assert.match(editor,/t\('knowledge\.characterCount',\{count:value\.length\.toLocaleString\(locale\)\}\)/)
 assert.doesNotMatch(editor,/value\.length\.toLocaleString\(locale\)\}\{t\("knowledge\.ui\.078"\)\}/)
 assert.doesNotMatch(documentCss,/font-size:(?:8|9|10|11)px/)
 assert.doesNotMatch(editorCss,/font-size:(?:8|9|10|11)px/)
 assert.match(editorCss,/@media\(max-width:760px\)\{[\s\S]*\.toolbar\{[^}]*flex-wrap:wrap/)
 assert.doesNotMatch(editorCss,/@media\(max-width:760px\)\{[\s\S]*\.toolbar\{[^}]*overflow:auto/)
 assert.match(documentCss,/@media\(max-width:980px\)/)
 assert.doesNotMatch(documentCss,/@media\(max-width:1180px\)[^{]*\{[^}]*\.history\{order:-1/)
})
