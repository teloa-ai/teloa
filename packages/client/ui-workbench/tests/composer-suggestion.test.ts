import assert from 'node:assert/strict'
import test from 'node:test'
import {deriveSuggestionFromAnswer,normalizeSuggestion,readSuggestionEnabled,shouldShowSuggestion,writeSuggestionEnabled} from '../src/client/composer-suggestion.ts'

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
test('兜底来源只认助手明确提出的下一步，不猜业务内容',()=>{
 // 助手以"要不要…吗？"收尾 → 给一个可拒绝的肯定候选
 assert.equal(deriveSuggestionFromAnswer('清单已核对完。要不要我接着按前缀分组再出一版？'),'要，请继续。')
 // 助手要求提供材料 → 给"我把材料发给你"
 assert.equal(deriveSuggestionFromAnswer('请把清单原件发过来，我按六步跑完。'),'我把材料发给你。')
 // 助手问的是来源位置：不猜，返回 null（避免替用户编造事实）
 assert.equal(deriveSuggestionFromAnswer('这批清单从哪里取？'),null)
 // 普通陈述句收尾：不显示
 assert.equal(deriveSuggestionFromAnswer('本批核验已完成，结论可追溯。'),null)
 assert.equal(deriveSuggestionFromAnswer(''),null)
})
