import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {baseline,bundle,composeEntries} from '../../native-browser/tests/composition.mjs'

const directory=fileURLToPath(new URL('../',import.meta.url))

test('安装电脑组合不初始化原生驱动，显式启用行后只提供官方 Cua',()=>{
  const {patches}=bundle(directory)
  const rows=composeEntries([baseline,patches])
  assert.equal(rows.find(row=>row.id==='teloa-computer-cua')?.disabled,true)
  assert.equal(rows.find(row=>row.id==='teloa-computer-use')?.disabled,true,'安装不能占用其它电脑提供方的注册器')
  const enabled=composeEntries([baseline,patches,[{id:'teloa-computer-use',disabled:false},{id:'teloa-computer-cua',disabled:false}]])
  assert.equal(enabled.find(row=>row.id==='teloa-computer-cua')?.name,'@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')
  assert.equal(enabled.find(row=>row.id==='teloa-computer-cua')?.disabled,false)
  assert.equal(enabled.find(row=>row.id==='teloa-computer-use')?.disabled,false)
  assert.equal(rows.filter(row=>row.name==='@deepseek-ai/dsh-computer-use').length,1)
})

test('电脑组合不修改沙箱、审批或现有岗位授权入口',()=>{
  const {patches}=bundle(directory)
  const before=composeEntries([baseline]),after=composeEntries([baseline,patches])
  for(const row of before)assert.deepEqual(after.find(value=>value.id===row.id),row)
  assert.equal(after.length-before.length,2)
})

test('电脑组合声明固定官方服务及原生 provider，由上游持有驱动依赖',()=>{
  const {manifest}=bundle(directory)
  assert.equal(manifest.name,'@teloa/native-computer')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-computer-use'],'0.1.7-rc.1')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'],'0.1.7-rc.1')
})
