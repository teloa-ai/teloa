import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {baseline,bundle,composeEntries} from './composition.mjs'

const directory=fileURLToPath(new URL('../',import.meta.url))
const rootRequire=createRequire(new URL('../../../package.json',import.meta.url))
const dshRequire=createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'))
const webDirectory=dirname(dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const browserRow=composeEntries([bundle(webDirectory).patches]).find(row=>row.id==='ui-sidebar-browser')
assert.ok(browserRow,'固定官方 Web 组合必须存在可覆盖的浏览器入口')
const webBaseline=[...baseline,{insert:[browserRow]}]

test('安装浏览器组合不初始化浏览器，显式启用行后只提供官方 Playwright',()=>{
  const {patches}=bundle(directory)
  const rows=composeEntries([...webBaseline,patches])
  const provider=rows.find(row=>row.id==='teloa-browser-playwright')
  assert.equal(provider?.disabled,true)
  assert.equal(rows.find(row=>row.id==='teloa-browser-use')?.disabled,true,'安装不能占用其它浏览器提供方的注册器')
  const enabled=composeEntries([...webBaseline,patches,[{id:'teloa-browser-use',disabled:false},{id:'teloa-browser-playwright',disabled:false}]])
  assert.equal(enabled.find(row=>row.id==='teloa-browser-playwright')?.name,'@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
  assert.equal(enabled.find(row=>row.id==='teloa-browser-playwright')?.disabled,false)
  assert.equal(enabled.find(row=>row.id==='teloa-browser-use')?.disabled,false)
  assert.deepEqual(provider.config,{mode:'launch',headless:true})
  assert.equal(rows.filter(row=>row.name==='@deepseek-ai/dsh-browser-use').length,1)
  assert.equal(rows.find(row=>row.id==='ui-sidebar-browser')?.name,'@deepseek-ai/dsh-client-ui-sidebar-browser')
  assert.equal(rows.find(row=>row.id==='ui-sidebar-browser')?.disabled,false,'启用组合恢复官方开始菜单浏览器入口，不自动启用助手驱动')
})

test('浏览器启用不授予 Full access、不改变现有审批与工具呈现',()=>{
  const {patches}=bundle(directory)
  const before=composeEntries(webBaseline),after=composeEntries([...webBaseline,patches])
  for(const row of before)assert.deepEqual(after.find(value=>value.id===row.id),row.id==='ui-sidebar-browser'?{...row,disabled:false}:row)
  assert.equal(after.length-before.length,2)
})

test('浏览器组合拥有固定官方运行依赖，不能被误当作已安装裸 provider',()=>{
  const {manifest}=bundle(directory)
  assert.equal(manifest.name,'@teloa/native-browser')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-browser-use'],'0.2.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'],'0.2.1-rc.2')
})
