import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,readdir,stat} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

// 应用界面文字（i18n 词条、JSX 文本与属性、代码里拼给用户看的字符串、CSS content）不出现 emoji，
// 也不出现容易被渲染成彩色 emoji 的符号字符：箭头 U+2190–21FF、杂项符号与装饰符号 U+2600–27BF、U+2B00–2BFF、
// 变体选择符 U+FE0F、键帽 U+20E3，以及全部 Extended_Pictographic。部分浏览器（如 Opera）会把箭头、星形画成彩色 emoji；
// 图标一律用 lucide 单色 SVG（currentColor），菜单路径写「设置 > 模型」，前后值之间用 ArrowRight 图标并给读屏文字。
// 代码注释不算（只看字符串、模板与 JSX 文本节点；CSS 先去掉注释）。
// 豁免表（带理由，保持极小）：
// - ©：属 Extended_Pictographic，但默认文字呈现（Emoji_Presentation=No），只有后接 U+FE0F 才会变 emoji，而 U+FE0F 本身已被拦截。
const EXEMPT=new Set(['©'])
const PICTOGRAPHIC=/[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/gu
const src=fileURLToPath(new URL('../src/',import.meta.url))
const hits=(text:string)=>[...text.matchAll(PICTOGRAPHIC)].map(match=>match[0]).filter(char=>!EXEMPT.has(char))
const describe=(char:string)=>char+' U+'+char.codePointAt(0)!.toString(16).toUpperCase()

async function files(dir:string):Promise<string[]>{
 const out:string[]=[]
 for(const name of await readdir(dir)){
  const path=join(dir,name)
  if((await stat(path)).isDirectory())out.push(...await files(path))
  else out.push(path)
 }
 return out
}

/** 源码里会进入界面的文字：字符串字面量、模板片段、JSX 文本；注释天然不在其中。 */
function visibleText(file:string,source:string){
 const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
 const out:{line:number;text:string}[]=[]
 const visit=(node:ts.Node)=>{
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)||ts.isJsxText(node)){
   out.push({line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,text:ts.isJsxText(node)?node.getText(sf):node.text})
  }
  ts.forEachChild(node,visit)
 }
 visit(sf)
 return out
}

test('应用源码中的界面文字与 CSS 不含 emoji 或易成 emoji 的符号字符（注释不计）',async()=>{
 const found:string[]=[]
 for(const file of await files(src)){
  const name=relative(src,file)
  if(/\.(tsx?|mts)$/.test(file)&&!file.endsWith('.d.ts')){
   for(const {line,text} of visibleText(file,await readFile(file,'utf8')))for(const char of hits(text))found.push(name+':'+line+' '+describe(char))
  }else if(file.endsWith('.css')){
   for(const char of hits((await readFile(file,'utf8')).replace(/\/\*[\s\S]*?\*\//g,'')))found.push(name+' '+describe(char))
  }
 }
 assert.deepEqual(found,[])
})

test('守卫本身能拦住：字符串、JSX 文本里的箭头与星形会被找出，注释与 © 不会',()=>{
 const sample='// 设置 → 模型\nconst a=\'市场 → 扩展\'\nconst b=<p>评分 ★ 4.5 · © 2026</p>\n'
 assert.deepEqual(visibleText('sample.tsx',sample).flatMap(({line,text})=>hits(text).map(char=>line+' '+describe(char))),['2 → U+2192','3 ★ U+2605'])
})
