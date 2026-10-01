import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks} from 'node:module'

// 919bede 删除旧模拟安装维护页时把 market-installation-generated.ts / market-installation-residual.ts
// 一并删掉了，但界面仍以字面量调用 t('market.industry.saved.*') 等词条，运行时整屏回落成裸键。
// 这条守卫扫描 src/client 全部字面 t() 调用与 MessageKey 字面量数组，确保每一条都在合并词表里登记，
// 避免同类删词表却漏改引用的回归再次发生。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {MESSAGE_KEYS}=await import('../src/client/i18n/messages.ts')

// 尚未接线、留给对应负责方显式豁免的字面键。初始为空，未来确需临时豁免时在此追加并写明原因。
const LITERAL_KEY_ALLOWLIST:readonly string[]=[]

const clientRoot=fileURLToPath(new URL('../src/client/',import.meta.url))
const skipDirs=new Set(['i18n','.omc'])

function collectSourceFiles(dir:string,out:string[]=[]):string[]{
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(entry.isDirectory()){
   if(skipDirs.has(entry.name))continue
   collectSourceFiles(join(dir,entry.name),out)
  }else if(entry.name.endsWith('.ts')||entry.name.endsWith('.tsx')){
   out.push(join(dir,entry.name))
  }
 }
 return out
}

test('src/client 里所有字面 t() 键与 MessageKey 字面量数组都必须在合并词表中有定义',()=>{
 const definedKeys=new Set<string>(MESSAGE_KEYS)
 const allowlist=new Set(LITERAL_KEY_ALLOWLIST)
 const callPattern=/\bt\(\s*(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g
 const arrayPattern=/(?:readonly\s+)?MessageKey\[\]\s*=\s*\[([^\]]*)\]/g
 const literalInArray=/(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g
 const missing:string[]=[]
 for(const file of collectSourceFiles(clientRoot)){
  const source=readFileSync(file,'utf8')
  const relative=file.slice(clientRoot.length)
  for(const match of source.matchAll(callPattern)){
   const key=match[2]!
   // `t('prefix.'+variable)` 是运行时拼接的动态键，字面量只是前缀，不当作完整键处理。
   const afterQuote=source.slice(match.index+match[0].length).trimStart()
   if(afterQuote.startsWith('+'))continue
   if(!definedKeys.has(key)&&!allowlist.has(key))missing.push(`${relative} -> t('${key}')`)
  }
  for(const arrayMatch of source.matchAll(arrayPattern)){
   for(const literalMatch of arrayMatch[1]!.matchAll(literalInArray)){
    const key=literalMatch[2]!
    if(!definedKeys.has(key)&&!allowlist.has(key))missing.push(`${relative} -> MessageKey[] '${key}'`)
   }
  }
 }
 assert.deepEqual(missing,[],`发现字面键缺少词表定义（共 ${missing.length} 条）：\n${missing.join('\n')}`)
})
