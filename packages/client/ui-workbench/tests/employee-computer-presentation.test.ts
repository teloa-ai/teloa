import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// 直接验证源组件；CSS 与内置图片按资源处理，不替代组件、状态或本地化逻辑。
registerHooks({
 resolve(specifier,context,next){
  if(context.parentURL&&specifier.startsWith('.')&&specifier.endsWith('.js')){
   for(const suffix of ['.ts','.tsx']){
    const url=new URL(specifier.slice(0,-3)+suffix,context.parentURL)
    if(existsSync(url))return {url:url.href,shortCircuit:true}
   }
  }
  if(/\.(module\.css|png|webp|svg)$/.test(specifier))return {url:new URL(specifier,context.parentURL).href,shortCircuit:true}
  return next(specifier,context)
 },
 load(url,context,next){
  if(url.endsWith('.module.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}
  if(/\.(png|webp|svg)$/.test(url))return {format:'module',shortCircuit:true,source:`export default ${JSON.stringify(url)}`}
  if(url.endsWith('.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText}
  return next(url,context)
 },
})
const {EmployeeDevices}=await import('../src/client/EmployeeDevices.tsx')
const {EmployeeComputerPage}=await import('../src/client/EmployeeComputerPage.tsx')
const {I18nProvider}=await import('../src/client/i18n/provider.tsx')
const {employeeCopy}=await import('../src/client/employee-copy.ts')
const role={id:'employee-1',name:'小研',kind:'employee',storage:'persistent',avatarKey:'security-analyst',scopes:['SOC'],state:'active',duty:'核对证据'}
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1cAAAAASUVORK5CYII='
const render=(computer?:unknown,locale='zh-CN')=>{
 const snapshot={locale,dshLocale:'zh',revision:1},runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:string)=>key}
 return renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(EmployeeDevices,{role,computer} as never)))
}
const renderPage=(computer?:unknown)=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'location')
 Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/?employeeComputer=employee-1'}})
 try{
  const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:string)=>key}
  return renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(EmployeeComputerPage,{role,computer,loading:false,scopes:{SOC:'安全运营'},retry:()=>{},back:()=>{},talk:async()=>true,openEmployee:()=>{}} as never)))
 }finally{if(previous)Object.defineProperty(globalThis,'location',previous);else Reflect.deleteProperty(globalThis,'location')}
}

test('未接入员工使用紧凑图标，保留原独立页面入口及准确状态',()=>{
 const html=render()
 assert.match(html,/data-device-state="not-integrated"/)
 assert.match(html,/data-teloa-toolbar-icon/)
 assert.match(html,/aria-label="小研的云电脑 · 未接入"/)
 assert.match(html,/title="工作邮箱 · 未接入"/)
 assert.doesNotMatch(html,/class="thumbnail"|<img/)
 assert.match(html,/href="\?employeeComputer=employee-1" target="_blank" rel="noopener"/)
 assert.doesNotMatch(html,/data-device-state="connected"|data:image/)
})
test('仅当前员工的显式设备状态用于图标提示，员工 active 不是设备在线',()=>{
 const html=render({employeeId:'employee-1',state:'connected',preview:{dataUrl:image}})
 assert.match(html,/data-device-state="connected"/)
 assert.match(html,/已连接/)
 assert.match(html,/title="小研的云电脑 · 已连接"/)
 assert.doesNotMatch(html,/<img|data:image/)
 const other=render({employeeId:'another-employee',state:'connected',preview:{dataUrl:image}})
 assert.match(other,/data-device-state="not-integrated"/)
 assert.doesNotMatch(other,/data:image|已连接/)
})
test('连接中、已断开与暂不可用分别展示；断开后不把旧截图当作当前桌面',()=>{
 for(const [state,label] of [['connecting','连接中'],['disconnected','已断开'],['unavailable','暂不可用']] as const){
  const html=render({employeeId:'employee-1',state,preview:{dataUrl:image}})
  assert.match(html,new RegExp(`data-device-state="${state}"`))
  assert.ok(html.includes(label))
  assert.doesNotMatch(html,/src="data:image/)
 }
})
test('紧凑入口不加载预览图；可信状态保留在名称和悬停提示',()=>{
 for(const dataUrl of [undefined,'https://external.example/screen.png','data:image/svg+xml;base64,PHN2Zz4=']){
  const html=render({employeeId:'employee-1',state:'connected',preview:{dataUrl}})
  assert.match(html,/已连接/)
  assert.match(html,/title="小研的云电脑 · 已连接"/)
  assert.doesNotMatch(html,/src="(?:https:|data:image)/)
 }
})
test('图标状态提示与能力页签准确使用三语，不补译其他语言',()=>{
 for(const [locale,label] of [['zh-CN','能力'],['zh-TW','能力'],['zh-HK','能力'],['en','Capabilities']] as const)assert.equal(employeeCopy(locale,'capabilities'),label)
 assert.match(render({employeeId:'employee-1',state:'connected'},'zh-TW'),/已連接/)
 assert.match(render({employeeId:'employee-1',state:'disconnected'},'en'),/Disconnected/)
 assert.match(render(undefined,'en'),/Work email · Not connected/)
})
test('独立电脑页复用相同连接状态和截图；展示回执不授予接管能力',()=>{
 const html=renderPage({employeeId:'employee-1',state:'connected',preview:{dataUrl:image}})
 assert.match(html,/data-device-state="connected"/)
 assert.match(html,/src="data:image\/png;base64,/)
 assert.equal((html.match(/src="data:image/g)??[]).length,1,'完整电脑工作区只呈现一次真实画面，不在侧栏重复缩略预览')
 assert.match(html,/当前仅查看设备，接管功能尚未接入/)
 assert.match(html,/<button[^>]*disabled=""[^>]*>申请接管<\/button>/)
 assert.doesNotMatch(html,/未连接设备，暂无控制权信息|云电脑服务尚未接入/)
})
test('独立电脑页准确区分断开与未接入，并保留无画面的明确说明',()=>{
 assert.match(renderPage(),/云电脑服务尚未接入/)
 const html=renderPage({employeeId:'employee-1',state:'disconnected',preview:{dataUrl:image}})
 assert.match(html,/设备已断开，当前没有可查看的桌面画面/)
 assert.doesNotMatch(html,/src="data:image/)
})
