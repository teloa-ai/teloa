import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'

// 本轮只渲染最新来源组件，避免为一个状态断言重建整个工作台。
registerHooks({
 resolve(specifier,context,next){
  if(specifier.endsWith('.module.css')||specifier.endsWith('.webp'))return {url:new URL(specifier,context.parentURL).href,shortCircuit:true}
  if(specifier.startsWith('.')&&specifier.endsWith('.js'))for(const extension of ['.ts','.tsx']){const url=new URL(specifier.slice(0,-3)+extension,context.parentURL);if(existsSync(fileURLToPath(url)))return {url:url.href,shortCircuit:true}}
  return next(specifier,context)
 },
 load(url,context,next){
  if(url.endsWith('.module.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}
  if(url.endsWith('.webp'))return {format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}
  if(url.endsWith('.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText}
  return next(url,context)
 },
})
const {TwinProfile}=await import('../src/client/TwinProfile.js')
const {I18nProvider}=await import('../src/client/i18n/provider.js')
const {translateMessage}=await import('../src/client/i18n/messages.js')
const role={id:'twin',name:'我的分身',kind:'twin',storage:'persistent',state:'active',version:1,scopes:['general'],skills:[],knowledge:[],memories:[],history:[],draft:{body:'LEGACY_SINGLE_DRAFT_MUST_NOT_SHOW',version:1,editorId:'self',updatedAt:'2026-10-21T00:00:00.000Z'}}
const expected={
 'zh-CN':'代拟稿服务尚未就绪，暂时无法读取已保存的稿件。',
 'zh-TW':'代擬稿服務尚未就緒，目前無法讀取已儲存的稿件。',
 en:'The draft service is not ready. Saved drafts cannot be read yet.',
}
test('持久分身无可信稿件端口时呈现服务未就绪，不宣称空目录或展示旧单稿编辑',()=>{
 for(const [locale,message]of Object.entries(expected)){
  const snapshot={locale,dshLocale:locale.startsWith('zh')?'zh':'en',revision:1},runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot}
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(TwinProfile as never,{profileName:'Max',role,update:()=>{},save:()=>false,conversations:null,samples:null} as never)))
  assert.ok(html.includes(message),locale+' 应说明服务未就绪')
  assert.ok(!html.includes(translateMessage(locale,'team.twin.draft.empty')),locale+' 不能宣称没有稿件')
  assert.ok(!html.includes('LEGACY_SINGLE_DRAFT_MUST_NOT_SHOW'))
  assert.ok(!html.includes(translateMessage(locale,'team.twin.draft.edit')))
  assert.ok(!html.includes('<textarea'),'持久身份未接端口时不能出现旧单稿输入')
  assert.ok(!html.includes('>'+translateMessage(locale,'twinDraft.save')+'</button>'))
 }
})
