import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks} from 'node:module'

// `i18n-literal-keys.test.ts` 只查正向（用到的键必须有定义），所以删组件时留下的孤儿词条不会报错：
// abdec24 收掉协作群「界面演示」分支后，collaboration.* 里一次性多出 31 条无人引用的词条，
// 十一列翻译照样跟着维护。这条守卫查反向——词表里登记的每个受管命名空间的键都必须在
// src/client 里有引用。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {MESSAGE_KEYS}=await import('../src/client/i18n/messages.ts')

// 受守卫管辖的命名空间与各自的键数下限（下限用于在词表读取失败时让守卫显式失败，而不是静默通过）。
// 未列入的命名空间（capabilities.*、teamCapability.*、home.*、artifact.* 等）仍有疑似孤儿，留待后续扩面。
const NAMESPACES:readonly (readonly [string,number])[]=[
 ['collaboration.',100],
 ['task.',100],
 ['team.',200],
 ['knowledge.',100],
 ['market.',800],
 ['business.',300],
 ['attention.',20],
 ['continuous.',100],
 ['about.',10],
 ['navigation.',20],
 ['settings.',10],
 // Auto Dream 一期的两份新词表：键数少，下限只用来保证守卫确实读到了词表。
 ['autoDream.',0],
 ['dailyLog.',10],
 ['habitLog.',3],
 ['roleMemory.',2],
 ['group.',5],
 // 同事上网一期 功能验证 接线收尾：webAccess.* 实际 14 条（run.empty 与 deny.* 四条一期无消费面已删除，
 // 见 i18n/locales/web-access.ts 文件头）。守卫用严格大于（keys.length>least）判定，因此下限只能填
 // 实际数减一（13），不能直接填 14 本身，否则任何一条键都不许再删就会先在这条断言上假摔。
 ['webAccess.',13],
 // 技能代发按岗位授权（规格 2026-09-27 §5.1）：只管 roleGrant.skillHttp.* 这一小段，不扩到整个 roleGrant. 命名空间。
 ['roleGrant.skillHttp.',7],
 // IM 通道一期设置页：下限只保证守卫读到了词表。
 ['imChannels.',30],
]
// 已登记但暂无引用、由对应负责方显式豁免的键。每一条都要写明为什么界面拿不到它。
// 群附件一期 T12 修复轮 1（2026-09-21）：33 条词条里已有 29 条被群页真实引用，白名单收到这 4 条真孤儿。
const ORPHAN_KEY_ALLOWLIST:readonly string[]=[
 // 群资料引用的灰卡留二期：现在 group-resource 引用仍走既有的 collaboration.message.references 一行，
 // 没有按 kind 分流出灰卡，因此这条文案暂时没有渲染路径。
 'collaboration.reference.resourceWithdrawn',
 // 512 MiB 总量上限只有服务端判得了，回到客户端时只剩八个稳定错误码，客户端既不读 details 也不猜原因，
 // 这条文案没有可靠的触发点（localizeWorkError 映的是错误码，不是这个键）。
 'collaboration.attachment.groupFull',
 // 群内直接回应一期 T3 预登记的 13 条临时豁免到 T16 已经清零：12 条在 T12/T13/T14 接线后删除，
 // 最后一条 `group.routing.stopped` 由 T16 连同词条本身一并删除（界面没有消费面，词条留着就是
 // 第二个事实源）。本名单因此回到群附件一期留下的四条长期豁免，不再有本期的临时登记。
 // 下面两条由宿主在同事回帖正文前直接拼接（与 backend/task-run-group-context.ts 的同名常量逐字相同），
 // 客户端只当正文显示，不再本地化，因此 src/client 里不会出现引用。
 'collaboration.attachment.modelNoVision',
 'collaboration.attachment.partialFailed',
]

const clientRoot=fileURLToPath(new URL('../src/client/',import.meta.url))
// 只跳过词表本身（locales/ 与 regions/ 是十一列表格，messages.ts 是键登记表）。
// i18n/ 下的其余模块（errors.ts、market-count.ts、market-target.ts、dsh-sidebar.ts 等）会把
// 稳定 code 映射成键，是真实引用方，必须一起扫描，否则 error.* / capability.* 会被误判成孤儿。
const skipDirs=new Set(['locales','regions','.omc'])
const skipFiles=new Set(['messages.ts'])

function collectSourceFiles(dir:string,out:string[]=[]):string[]{
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(entry.isDirectory()){
   if(skipDirs.has(entry.name))continue
   collectSourceFiles(join(dir,entry.name),out)
  }else if((entry.name.endsWith('.ts')||entry.name.endsWith('.tsx'))&&!skipFiles.has(entry.name)){
   out.push(join(dir,entry.name))
  }
 }
 return out
}

test('词表里登记的受管命名空间键都必须在 src/client 里有引用',()=>{
 const sources=collectSourceFiles(clientRoot).map(file=>readFileSync(file,'utf8')).join('\n')
 // 运行时拼接的键（模板串 `x.y.${value}` 或 'x.y.'+value）只留下前缀，前缀命中即视为整组已引用，
 // 避免把 collaboration.agentGrant.status.* 、market.industry.resource.* 这类动态键误判成孤儿。
 const prefixes=[...sources.matchAll(/[`'"]([A-Za-z][A-Za-z0-9_.]*\.)(?:\$\{|['"]\s*\+)/g)].map(match=>match[1]!)
 const referenced=(key:string)=>
  sources.includes(`'${key}'`)||sources.includes(`"${key}"`)||sources.includes(`\`${key}\``)||prefixes.some(prefix=>key.startsWith(prefix))
 const allowlist=new Set(ORPHAN_KEY_ALLOWLIST)
 const orphans:string[]=[]
 for(const [namespace,least] of NAMESPACES){
  const keys=MESSAGE_KEYS.filter(key=>key.startsWith(namespace))
  assert.ok(keys.length>least,`${namespace}* 键数量异常（${keys.length}），守卫可能没读到词表`)
  orphans.push(...keys.filter(key=>!referenced(key)&&!allowlist.has(key)))
 }
 assert.deepEqual(orphans,[],`发现只在词表里存在、界面已无引用的键（共 ${orphans.length} 条）：\n${orphans.join('\n')}`)
})
