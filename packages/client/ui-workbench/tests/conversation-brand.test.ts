import test from 'node:test'
import assert from 'node:assert/strict'
import { installConversationBrand } from '../src/client/conversation-brand.ts'

test('会话文案保持翻译身份、语言切换与其他 namespace',()=>{
  let active='zh'
  const calls:unknown[]=[]
  const native=(key:string,params?:unknown)=>{calls.push([key,params]);return active+':'+key}
  const locale={getSnapshot:()=>({active}),bind:(_namespace:string)=>native}
  const original=locale.bind,dispose=installConversationBrand(locale)
  const t=locale.bind('conversation')
  assert.equal(t('hero.headline'),'AI-Native Team Studio')
  assert.equal(t('hero.preview'),'社区版')
  assert.equal(locale.bind('conversation'),t)
  active='en'
  assert.equal(t('hero.headline'),'AI-Native Team Studio')
  assert.equal(t('hero.preview'),'Community')
  assert.equal(t('placeholder.hero',{name:'Ada'}),'en:placeholder.hero')
  assert.deepEqual(calls.at(-1),['placeholder.hero',{name:'Ada'}])
  assert.equal(locale.bind('settings'),native)
  dispose()
  assert.equal(locale.bind,original)
  assert.equal(t('hero.headline'),'en:hero.headline')
  assert.equal(t('hero.preview'),'en:hero.preview')
  dispose()
})

test('归一化图片的预览不宣称原始文件，保留文件名并可卸载恢复',()=>{
  let active='zh-CN'
  const native=(key:string,_params?:unknown)=>key
  const locale={getSnapshot:()=>({active}),bind:(_namespace:string)=>native}
  const dispose=installConversationBrand(locale),t=locale.bind('conversation')
  assert.equal(t('image.preview'),'图片预览')
  assert.equal(t('image.openOriginalLabel',{label:'动画验收.gif'}),'动画验收.gif，点击查看图片')
  assert.equal(t('image.closePreview'),'关闭图片预览')
  active='en'
  assert.equal(t('image.preview'),'Image preview')
  assert.equal(t('image.openOriginalLabel',{label:'sample.gif'}),'sample.gif, view image')
  assert.equal(t('image.unsupportedType'),'image.unsupportedType')
  dispose()
  assert.equal(t('image.preview'),'image.preview')
})

test('费用提示分别说明实际调用与参考价格来源，保留原生明细、语言切换和卸载',()=>{
 let active='zh-CN'
 const calls:unknown[]=[],native=(key:string,params?:unknown)=>{calls.push([key,params]);return active+':'+key},locale={getSnapshot:()=>({active}),bind:(_namespace:string)=>native}
 const original=locale.bind,dispose=installConversationBrand(locale),t=locale.bind('dsh-context')
 assert.equal(locale.bind('dsh-context'),t)
 assert.equal(t('stats.cost'),'参考费用')
 assert.match(t('stats.costTip'),/当前实际提供方和模型见上下文顶部.*没有价格目录时.*无法明确匹配时不估算.*服务账单/)
 assert.equal(t('stats.costPriceBy',{p:'deepseek',m:'deepseek-flash'}),'估算价格来源：models.dev · deepseek · deepseek-flash。实际调用提供方与模型见上下文顶部和请求轨迹。')
 assert.equal(t('stats.costHit'),'zh-CN:stats.costHit')
 assert.equal(t('stats.costTipDeepseek'),'zh-CN:stats.costTipDeepseek','保留上游峰谷价格规则')
 active='en'
 assert.equal(t('stats.cost'),'Estimated cost')
 assert.match(t('stats.costTip'),/actual provider has no price catalog.*ambiguous matches remain unpriced/)
 assert.match(t('stats.costPriceBy',{p:'openai',m:'model-a'}),/Reference price source: models.dev · openai · model-a.*actual provider and model/)
 assert.equal(locale.bind('settings'),native)
 dispose();assert.equal(locale.bind,original);assert.equal(t('stats.costTip'),'en:stats.costTip')
 assert.deepEqual(calls.at(-1),['stats.costTip',undefined])
})

test('任意模型的处理状态使用中性文案，保留计时、其他chat词条及卸载恢复',()=>{
 let active='zh-CN'
 const calls:unknown[]=[],native=(key:string,params?:unknown)=>{calls.push([key,params]);return active+':'+key},locale={getSnapshot:()=>({active}),bind:(_namespace:string)=>native}
 const original=locale.bind,dispose=installConversationBrand(locale),t=locale.bind('chat')
 assert.equal(locale.bind('chat'),t)
 assert.equal(t('chat.deepDiving'),'正在处理')
 assert.equal(t('chat.deepDivingFor',{duration:'12秒'}),'正在处理，用时 12秒 ···')
 assert.equal(t('chat.connectionError',{message:'原始错误'}),'zh-CN:chat.connectionError')
 assert.deepEqual(calls.at(-1),['chat.connectionError',{message:'原始错误'}])
 active='en'
 assert.equal(t('chat.deepDiving'),'Working')
 assert.equal(t('chat.deepDivingFor',{duration:'12s'}),'Working for 12s ···')
 assert.equal(locale.bind('settings'),native)
 dispose();assert.equal(locale.bind,original);assert.equal(t('chat.deepDivingFor',{duration:'13s'}),'en:chat.deepDivingFor')
 assert.deepEqual(calls.at(-1),['chat.deepDivingFor',{duration:'13s'}])
})
