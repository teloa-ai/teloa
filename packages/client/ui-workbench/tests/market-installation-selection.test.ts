import assert from 'node:assert/strict'
import test from 'node:test'
import {marketSkillInstallationSelection} from '../src/client/market-installation-selection.ts'

test('Skill目录导航标识不会成为真实安装详情ID',()=>{
  assert.equal(marketSkillInstallationSelection('skill:directory'),null)
  assert.equal(marketSkillInstallationSelection('skill:installation-123'),'installation-123')
  assert.equal(marketSkillInstallationSelection(null),null)
})
