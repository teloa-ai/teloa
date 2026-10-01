import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {artifactListFetchKey} from '../src/client/artifact-source.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const task=(id:string,storage:'persistent'|'local')=>({id,storage} as unknown as PreviewTask)

// 实机缺陷：任务里保存工作成果后刷新，服务端 artifacts/task/list 仍返回 1 条，
// 面板「当前工作产物」却是空的，关掉重开也不回填。
// 顺序是关键：state.detail 这颗种子随刷新同步恢复，任务台账是异步装载的，
// 首屏判不出这份任务是持久任务，拉取被跳过；此后来源身份没再变过，拉取也就再没被触发。
test('刷新后先有选中成果来源、再有任务台账时，拉取键必须发生变化', () => {
  const target={source:{kind:'task',id:'t1'}} as const
  assert.equal(artifactListFetchKey(target,[]),'','台账没到位不该拿本地草稿当持久任务去拉服务端')
  const ready=artifactListFetchKey(target,[task('t1','persistent')])
  assert.notEqual(ready,'','台账装载完必须给出拉取键，否则刷新后成果目录永远空着')
  assert.notEqual(ready,artifactListFetchKey(target,[]),'键必须随台账就绪而变，拉取 effect 才会补跑')
})

test('本机任务与无来源不产生拉取键，会话来源立刻可拉', () => {
  assert.equal(artifactListFetchKey({source:{kind:'task',id:'t1'}},[task('t1','local')]),'')
  assert.equal(artifactListFetchKey(null,[task('t1','persistent')]),'')
  assert.equal(artifactListFetchKey({source:{kind:'session',id:'s1'}},[]),'session s1')
  assert.equal(artifactListFetchKey({source:{kind:'run',id:'r1'}},[]),'','执行、业务等来源没有服务端成果目录可拉')
})

test('拉取键同时承载来源种类与身份，够 effect 独立发起请求', () => {
  assert.equal(artifactListFetchKey({source:{kind:'task',id:'t1'}},[task('t1','persistent')]),'task t1')
  assert.notEqual(
    artifactListFetchKey({source:{kind:'task',id:'t1'}},[task('t1','persistent')]),
    artifactListFetchKey({source:{kind:'session',id:'t1'}},[]),
    '同名不同种来源必须是两份键',
  )
})

test('成果拉取 effect 以拉取键为依赖，不再只盯来源身份', async () => {
  const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
  const start=source.indexOf('const artifactFetchKey=')
  assert.notEqual(start,-1,'WorkbenchFrame 必须先算出拉取键')
  const wiring=source.slice(start,source.indexOf('\n',source.indexOf('artifactApi.list',start)))
  assert.match(wiring,/\[artifactFetchKey,artifactApi\]/,'依赖里少了拉取键，台账晚到就再也不会补拉')
})
