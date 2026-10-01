import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectRoot } from '../scripts/核对DSH依赖.mjs'

const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'))

test('宿主、客户端与组合插件清单声明的兼容 DSH 版本与固定基线一致', () => {
  const baseline = read('config/dsh-baseline.json'), expected = baseline.tag.replace(/^dsh-v/, '')
  const versions = read('config/dsh-package-versions.json')
  assert.equal(expected, versions.versions['@deepseek-ai/dsh'])
  // 组合补丁包也随宿主版本走：它钉住遥测与沙箱，跟着旧 DSH 走会静默失配。
  for (const manifest of ['packages/harness-dsh/package.json', 'packages/client/ui-workbench/package.json', 'packages/bundle/package.json']) {
    assert.equal(read(manifest).engines?.dsh, expected, manifest)
  }
  // 两份基线文件各自记了一次上游 commit；不一致时无法判断锁定的到底是哪一版。
  assert.equal(baseline.commit, versions.sourceCommit, 'dsh-baseline.json.commit 必须与 dsh-package-versions.json.sourceCommit 一致')
})
