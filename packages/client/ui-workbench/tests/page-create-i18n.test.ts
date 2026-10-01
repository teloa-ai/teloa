import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {PAGE_CREATE_MESSAGE_ROWS} from '../src/client/i18n/locales/page-create.ts'
import {pageCreateEntities} from '@teloa/contract'
import {createNextKey,createPlaceholderKey} from '../src/client/page-create-presentation.ts'

registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('页内新建词表每行十一列，全部语言经正式总词表读取且没有键名回落',()=>{
 const keys=new Set<string>()
 for(const row of PAGE_CREATE_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(!keys.has(row[0]),'重复键：'+row[0]);keys.add(row[0])
  for(const [index,locale] of locales.entries()){
   assert.ok(row[index+1]?.trim(),locale+':'+row[0])
   const params={step:'TEST_STEP'}
   const result=translateMessage(locale,row[0],params)
   assert.equal(result,row[index+1]!.replace('{step}','TEST_STEP'),locale+':'+row[0])
   assert.notEqual(result,row[0])
  }
 }
})

test('组件直接键和各实体动态键全在这份词表，不依赖默认中文或裸端点',()=>{
 const keys=new Set(PAGE_CREATE_MESSAGE_ROWS.map(row=>row[0] as string))
 const source=readFileSync(new URL('../src/client/CreateEntry.tsx',import.meta.url),'utf8')
 for(const match of source.matchAll(/'((?:create\.)[^']+)'/g))assert.ok(keys.has(match[1]!),'未登记组件键：'+match[1])
 for(const entity of pageCreateEntities){assert.ok(keys.has(createPlaceholderKey(entity)));assert.ok(keys.has(createNextKey(entity)))}
 assert.doesNotMatch(source,/step:\s*(?:currentPreview|preview)\.next\.endpoint/)
})
