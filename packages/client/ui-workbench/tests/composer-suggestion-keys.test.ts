import assert from 'node:assert/strict'
import test from 'node:test'
import {routeSuggestionKey} from '../src/client/composer-suggestion-keys.ts'
import {composerSuggestionMessages} from '../src/client/i18n/locales/composer-suggestion.ts'

test('可见时 Tab 采纳、Escape 丢弃，其余键交给输入框',()=>{
 assert.equal(routeSuggestionKey({key:'Tab',visible:true}),'accept')
 assert.equal(routeSuggestionKey({key:'Escape',visible:true}),'dismiss')
 for(const key of ['a','Enter','Backspace',' ','1','ArrowDown'])assert.equal(routeSuggestionKey({key,visible:true}),'pass')
})

test('不可见时不抢任何键（避免 Tab 在别处被吞）',()=>{
 for(const key of ['Tab','Escape','a'])assert.equal(routeSuggestionKey({key,visible:false}),'pass')
})

test('输入法合成中或带修饰键的 Tab 不采纳',()=>{
 assert.equal(routeSuggestionKey({key:'Tab',visible:true,composing:true}),'pass')
 assert.equal(routeSuggestionKey({key:'Tab',visible:true,modifier:true}),'pass')
})

test('无障碍文案走词条表，三种定稿语言都带 {text} 占位',()=>{
 for(const locale of ['zh-CN','zh-Hant','en'] as const){
  assert.ok(composerSuggestionMessages[locale]['composerSuggestion.aria'].includes('{text}'),locale)
 }
})

