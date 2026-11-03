import assert from 'node:assert/strict'
import test from 'node:test'
import {normalizeSuggestion,readSuggestionEnabled,shouldShowSuggestion,writeSuggestionEnabled} from '../src/client/composer-suggestion.ts'

test('只有空且未聚焦、开关开着、本条未丢弃时才显示',()=>{
 const base={enabled:true,draft:'',focused:false,dismissedForAnswer:false,text:'继续，请把清单发我。'}
 assert.equal(shouldShowSuggestion(base),'show')
 // 关键行为：有内容/聚焦/关开关/已丢弃，一律不显示
 assert.equal(shouldShowSuggestion({...base,draft:'我自己输入'}),'hidden-busy')
 assert.equal(shouldShowSuggestion({...base,focused:true}),'hidden-busy')
 assert.equal(shouldShowSuggestion({...base,enabled:false}),'hidden-disabled')
 assert.equal(shouldShowSuggestion({...base,dismissedForAnswer:true}),'hidden-dismissed')
 assert.equal(shouldShowSuggestion({...base,text:null}),'hidden-empty')
})

test('偏好默认开；只有明确写过 false 才当关闭',()=>{
 assert.equal(readSuggestionEnabled(undefined),true)
 const store=new Map<string,string>()
 const storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v)}}
 assert.equal(readSuggestionEnabled(storage),true)
 writeSuggestionEnabled(storage,false)
 assert.equal(readSuggestionEnabled(storage),false)
 writeSuggestionEnabled(storage,true)
 assert.equal(readSuggestionEnabled(storage),true)
 // 坏值按默认开处理，不因为存储脏数据把功能关掉
 store.set('teloa.composer-suggestion.enabled','garbage')
 assert.equal(readSuggestionEnabled(storage),true)
})

test('候选按 Codex 口径：整段可接受、换行压成单段、超长截断、NONE 不显示',()=>{
 assert.equal(normalizeSuggestion('  要，请继续。 '),'要，请继续。')
 assert.equal(normalizeSuggestion('NONE'),null)
 // 多句是允许的（Codex 的建议本来就是完整一段）
 assert.equal(normalizeSuggestion('第一句。第二句。'),'第一句。第二句。')
 // 换行压成空格，保持输入框内单段排版
 assert.equal(normalizeSuggestion('多行\n第二行'),'多行 第二行')
 // 超长按上限截断
 assert.ok(normalizeSuggestion('x'.repeat(400))!.length<=200)
 assert.equal(normalizeSuggestion(undefined),null)
})
