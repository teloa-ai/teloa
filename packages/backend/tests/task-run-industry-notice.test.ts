import test from 'node:test'
import assert from 'node:assert/strict'
import {industryContextNotice,isIndustryContextNotice,legacyIndustryContextNotices} from '../src/work/task-run-industry-context.ts'

test('行业执行说明：新执行写入新说明，历史快照的旧说明仍可读取，其他文本一律拒绝',()=>{
 assert.match(industryContextNotice,/已安装并启用的 Skill 会随本次执行加载/)
 assert.equal(isIndustryContextNotice(industryContextNotice),true)
 for(const legacy of legacyIndustryContextNotices)assert.equal(isIndustryContextNotice(legacy),true)
 for(const forged of ['','Skill 已授权',industryContextNotice+' ',undefined,null,1])assert.equal(isIndustryContextNotice(forged),false)
})
