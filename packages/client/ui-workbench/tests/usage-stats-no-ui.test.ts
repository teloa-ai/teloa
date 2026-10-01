import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks} from 'node:module'

// 2026-09-25 用户裁定：使用统计默认参与并上报，应用内不提供设置页、只读说明页或开关。
// 这条守卫锁住「界面里没有任何使用统计入口」：设置导航、客户端 API、词条、RPC 白名单一律不得再出现。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const client=fileURLToPath(new URL('../src/client/',import.meta.url))
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)])
const sources=walk(client).filter(path=>/\.(ts|tsx|css)$/.test(path))

test('客户端源码没有使用统计设置页、API 与 RPC 端点引用',()=>{
 for(const path of sources){
  const text=readFileSync(path,'utf8')
  assert.doesNotMatch(text,/usage-stats\//,path+' 不得调用 usage-stats/* 端点')
  assert.doesNotMatch(text,/UsageStatsSettings|createUsageStatsApi|teloa-usage-stats/,path+' 不得保留设置页或 API')
 }
 assert.ok(!existsSync(join(client,'UsageStatsSettingsPage.tsx')))
 assert.ok(!existsSync(join(client,'usage-stats-api.ts')))
 assert.ok(!existsSync(join(client,'i18n/locales/usage-stats.ts')))
})

test('词表没有 usageStats.* 词条（含「开启 / 关闭统计」类文案）',async()=>{
 const {MESSAGE_KEYS}=await import('../src/client/i18n/messages.ts')
 const keys=(MESSAGE_KEYS as readonly string[]).filter(key=>key.startsWith('usageStats.'))
 assert.deepEqual(keys,[])
})
