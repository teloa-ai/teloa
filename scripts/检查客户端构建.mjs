import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectRoot } from './核对DSH依赖.mjs'

const dir=resolve(projectRoot,'packages/client/ui-workbench')
const manifest=JSON.parse(readFileSync(resolve(dir,'package.json'),'utf8'))
const code=readFileSync(resolve(dir,'lib/client.js'),'utf8')
const host=readFileSync(resolve(dir,'lib/index.js'),'utf8')
const requireCheck=(ok,message)=>{if(!ok)throw Error(message)}
requireCheck(manifest.dsh?.client?.platform==='web','dsh.client 必须为 web 对象。')
requireCheck(manifest.exports?.['./client']?.default==='./lib/client.js','客户端出口必须指向构建产物。')
requireCheck(code.includes('window.__ModuleLoader__.load('),'缺少 DSH 客户端模块包装。')
const externals=[...code.matchAll(/require\(["']([^"']+)["']\)/g)].map(match=>match[1])
const platformModules=new Set(['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives'])
requireCheck(externals.every(name=>platformModules.has(name)),'客户端出现宿主未提供的外部模块：'+externals.filter(name=>!platformModules.has(name)).join('、'))
for(const module of ['react','react/jsx-runtime','@deepseek-ai/dsh-client-store']) requireCheck(externals.includes(module),'平台模块没有保留外部引用：'+module)
requireCheck(/createElement\(["']style["']\)/.test(code),'CSS 未内联到客户端。')
requireCheck(code.includes('data:image/svg+xml;base64,'),'品牌资源未内联。')
requireCheck(!/export\s*\{[^}]*\bas\s+default\b/s.test(host),'Host 插件出现默认出口。')
// 仅允许已复核的焦点协调与自有菜单定位；不得搬移或隐藏原生节点。
const clientDir=resolve(dir,'src/client')
const observerSources=readdirSync(clientDir,{recursive:true}).filter(path=>/\.[tj]sx?$/.test(path)&&readFileSync(resolve(clientDir,path),'utf8').includes('MutationObserver')).sort()
const reviewedObservers=['ComposerPopover.tsx','settings-subdialog-focus.ts']
requireCheck(JSON.stringify(observerSources)===JSON.stringify(reviewedObservers),'MutationObserver 仅允许用于设置页焦点协调与自有输入菜单定位。')
requireCheck((code.match(/new MutationObserver\(/g)??[]).length===reviewedObservers.length,'产物中的观察器与已复核来源不一致。')
// 同包按需分块：只认 `client.<名>.js`，各自以 chunk 包装、自包含（不得同步 require 另一个 client*.js），外部引用只取平台模块；入口只经 require.async 取它。
const chunks=readdirSync(resolve(dir,'lib')).filter(name=>/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name))
for(const name of chunks){
 const chunk=readFileSync(resolve(dir,'lib',name),'utf8')
 requireCheck(chunk.startsWith('window.__ModuleLoader__.load({')&&chunk.includes('chunk: '+JSON.stringify(name)+','),'分块缺少 DSH 分块包装：'+name)
 const requests=[...chunk.matchAll(/require\(["']([^"']+)["']\)/g)].map(match=>match[1])
 requireCheck(requests.every(request=>platformModules.has(request)),'分块出现宿主未提供的外部模块：'+name+' '+requests.filter(request=>!platformModules.has(request)).join('、'))
 requireCheck(code.includes('require.async("./'+name+'")'),'入口没有按需引用分块：'+name)
}
requireCheck(chunks.includes('client.chart.js'),'缺少看板图表分块 client.chart.js。')
console.log('客户端构建检查通过：'+[...new Set(externals)].join('、')+' 外置；CSS 与品牌内联；DSH 模块包装及命名出口有效；分块 '+chunks.join('、')+' 自包含。')
