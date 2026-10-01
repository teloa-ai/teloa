import test from 'node:test'
import assert from 'node:assert/strict'
import {isPendingRequestEndpoint} from '../src/pending-requests.ts'

test('市场原文件上传使用固定导入回执，不复制正文到通用待恢复目录；GitHub小请求保持原分类',()=>{
 assert.equal(isPendingRequestEndpoint('market-content/import'),false)
 assert.equal(isPendingRequestEndpoint('market-content/import-github'),true)
 assert.equal(isPendingRequestEndpoint('market-content/import-github-skill'),true)
 assert.equal(isPendingRequestEndpoint('groups/attachments/upload'),false)
 assert.equal(isPendingRequestEndpoint('groups/attachments/withdraw'),true)
})
