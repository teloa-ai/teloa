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
  assert.equal(t('hero.preview'),'Free')
  assert.equal(locale.bind('conversation'),t)
  active='en'
  assert.equal(t('hero.headline'),'AI-Native Team Studio')
  assert.equal(t('hero.preview'),'Free')
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
