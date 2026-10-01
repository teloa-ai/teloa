import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {baseline,bundle,composeEntries} from './composition.mjs'

const directory=fileURLToPath(new URL('../',import.meta.url))

test('安装浏览器组合不初始化浏览器，显式启用行后只提供官方 Playwright',()=>{
  const {patches}=bundle(directory)
  const rows=composeEntries([baseline,patches])
  const provider=rows.find(row=>row.id==='teloa-browser-playwright')
  assert.equal(provider?.disabled,true)
  assert.equal(rows.find(row=>row.id==='teloa-browser-use')?.disabled,true,'安装不能占用其它浏览器提供方的注册器')
  const enabled=composeEntries([baseline,patches,[{id:'teloa-browser-use',disabled:false},{id:'teloa-browser-playwright',disabled:false}]])
  assert.equal(enabled.find(row=>row.id==='teloa-browser-playwright')?.name,'@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
  assert.equal(enabled.find(row=>row.id==='teloa-browser-playwright')?.disabled,false)
  assert.equal(enabled.find(row=>row.id==='teloa-browser-use')?.disabled,false)
  assert.deepEqual(provider.config,{mode:'launch',headless:true})
  assert.equal(rows.filter(row=>row.name==='@deepseek-ai/dsh-browser-use').length,1)
})

test('浏览器启用不授予 Full access、不改变现有审批与工具呈现',()=>{
  const {patches}=bundle(directory)
  const before=composeEntries([baseline]),after=composeEntries([baseline,patches])
  for(const row of before)assert.deepEqual(after.find(value=>value.id===row.id),row)
  assert.equal(after.length-before.length,2)
})

test('浏览器组合拥有固定官方运行依赖，不能被误当作已安装裸 provider',()=>{
  const {manifest}=bundle(directory)
  assert.equal(manifest.name,'@teloa/native-browser')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-browser-use'],'0.1.7-rc.1')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'],'0.1.7-rc.1')
})
