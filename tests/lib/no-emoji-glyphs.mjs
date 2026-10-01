// 无 emoji 符号守卫（宿主与后端用）：思路同 packages/client/ui-workbench/tests/no-emoji-glyphs.test.ts，
// 用 TypeScript AST 只看字符串字面量与模板片段（确认卡、报错、提示都从这里拼出来），注释天然不在其中。
// 拦截：全部 Extended_Pictographic，以及易被画成彩色 emoji 的箭头 U+2190–21FF、杂项与装饰符号 U+2600–27BF、U+2B00–2BFF、
// 变体选择符 U+FE0F、键帽 U+20E3。菜单路径写「设置 > 模型」，评分写「N 星」。
// 豁免只有两处：
// - ©：属 Extended_Pictographic，但默认文字呈现，只有后接 U+FE0F 才会变 emoji，而 U+FE0F 本身已被拦截。
// - 群聊表情回应（packages/contract/src/group-reactions.ts 的 groupReactionEmojis）：用户裁定保留真 emoji，
//   它们是协议值（存库、比对、回显成表情按钮），不是装饰文字。只放行「整个字面量恰好是其中一枚」的写法。
import {readFile,readdir,stat} from 'node:fs/promises'
import {join,relative} from 'node:path'
import ts from 'typescript'
import {groupReactionEmojis} from '../../packages/contract/src/group-reactions.ts'

const EXEMPT_CHARS=new Set(['©'])
const EXEMPT_LITERALS=new Set(groupReactionEmojis)
const PICTOGRAPHIC=/[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/gu
const describe=char=>char+' U+'+char.codePointAt(0).toString(16).toUpperCase()

/** 一段源码里字符串与模板字面量中的违规字符，返回「行号 字符 U+码位」。 */
export function glyphHits(file,source){
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
  const out=[]
  const visit=node=>{
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)||ts.isJsxText(node)){
      const text=ts.isJsxText(node)?node.getText(sf):node.text
      if(!EXEMPT_LITERALS.has(text))for(const [char] of text.matchAll(PICTOGRAPHIC))if(!EXEMPT_CHARS.has(char))out.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1+' '+describe(char))
    }
    ts.forEachChild(node,visit)
  }
  visit(sf)
  return out
}

/** 扫一个源码目录（.ts/.tsx/.mts/.mjs/.js，不含 .d.ts）。 */
export async function directoryGlyphHits(dir){
  const found=[]
  const walk=async current=>{
    for(const name of (await readdir(current)).sort()){
      const path=join(current,name)
      if((await stat(path)).isDirectory())await walk(path)
      else if(/\.(tsx?|mts|mjs|js)$/.test(name)&&!name.endsWith('.d.ts'))for(const hit of glyphHits(path,await readFile(path,'utf8')))found.push(relative(dir,path)+':'+hit)
    }
  }
  await walk(dir)
  return found
}
