import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {applyMarkdownCommand,parseMarkdown} from '../src/client/knowledge-markdown-core.ts'

test('Markdown 预览解析 GitHub 常用块结构且正文不通过 HTML 注入',()=>{
 const blocks=parseMarkdown('# 标题\n\n> 引用\n\n- 一\n- 二\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a=1\n```\n\n<script>alert(1)</script>')
 assert.deepEqual(blocks.map(block=>block.kind),['heading','quote','list','table','code','paragraph'])
 const last=blocks.at(-1)
 assert.equal(last?.kind,'paragraph')
 assert.equal(last?.kind==='paragraph'?last.text:undefined,'<script>alert(1)</script>')
})

test('Markdown 工具栏围绕选区生成粗体和链接语法',()=>{
 assert.deepEqual(applyMarkdownCommand('hello',0,5,'bold','Text'),{value:'**hello**',selectionStart:2,selectionEnd:7})
 assert.deepEqual(applyMarkdownCommand('文档',0,2,'link','Link text'),{value:'[文档](https://)',selectionStart:5,selectionEnd:13})
})

test('Markdown 工具栏按行生成有序列表',()=>{
 assert.deepEqual(applyMarkdownCommand('第一项\n第二项',0,7,'ordered-list','List item'),{value:'1. 第一项\n2. 第二项',selectionStart:0,selectionEnd:13})
})

test('Markdown 工具栏空选区使用当前界面语言的占位文字',()=>{
 assert.deepEqual(applyMarkdownCommand('',0,0,'link','Link text'),{value:'[Link text](https://)',selectionStart:12,selectionEnd:20})
 assert.deepEqual(applyMarkdownCommand('',0,0,'heading','Heading'),{value:'## Heading',selectionStart:0,selectionEnd:10})
})

test('safeHref 不放行协议相对地址，站内单斜杠路径照常可点',async()=>{
 const source=await readFile(new URL('../src/client/knowledge-markdown.tsx',import.meta.url),'utf8')
 const match=source.match(/const safeHref=(.+)\n/)
 assert.ok(match)
 const safeHref=new Function('href','return ('+match[1]!.replace(/^\(href:string\)=>/,'')+')') as (href:string)=>string
 // `//attacker.tld` 是协议相对地址，浏览器当外站加载：正文来自第三方时等于一条钓鱼链接。
 assert.equal(safeHref('//attacker.tld/phish'),'#')
 assert.equal(safeHref('///attacker.tld'),'#')
 // `/\attacker.tld`：WHATWG URL 解析器对特殊 scheme 把 `\` 等同 `/`，等价于协议相对地址，同样要挡。
 assert.equal(safeHref('/\\attacker.tld'),'#')
 assert.equal(safeHref('/\\\\attacker.tld'),'#')
 // WHATWG URL 解析器在解析前会把整串里的 tab/换行/回车直接删掉：`/\t/evil.com` 删完就是
 // `/\evil.com`，等价协议相对地址；单看"下一个字符是不是 / 或 \"这层判据挡不住，得先拦控制字符。
 assert.equal(safeHref('/\t/evil.com'),'#')
 assert.equal(safeHref('/\n/evil.com'),'#')
 assert.equal(safeHref('/\r/evil.com'),'#')
 assert.equal(safeHref('/knowledge/doc-1'),'/knowledge/doc-1')
 assert.equal(safeHref('https://example.com/a'),'https://example.com/a')
 assert.equal(safeHref('mailto:a@b.c'),'mailto:a@b.c')
 assert.equal(safeHref('#anchor'),'#anchor')
 assert.equal(safeHref('./sibling'),'./sibling')
 assert.equal(safeHref('javascript:alert(1)'),'#')
 assert.equal(safeHref('data:text/html,x'),'#')
})

test('知识正文预览不加载远程图片：第三方正文里的图片不该成为远程信标',async()=>{
 const editor=await readFile(new URL('../src/client/KnowledgeMarkdownEditor.tsx',import.meta.url),'utf8')
 assert.match(editor,/<MarkdownPreview markdown=\{value\} images=\{false\}\/>/)
})
