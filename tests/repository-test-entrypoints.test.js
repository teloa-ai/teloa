import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'

const root=new URL('../',import.meta.url)
const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'))
const filesOf=command=>[...command.matchAll(/"(tests\/[^"\n]+\.test\.js)"/g)].map(match=>match[1])

test('公开工程测试使用无遗漏、无重复的明确文件清单',async()=>{
  const repo=manifest.scripts['test:repo']
  for(const command of [repo]){
    assert.ok(command.startsWith('node --test '))
    assert.doesNotMatch(command,/\*/,'入口不能使用会混入另一组的通配符')
  }
  const selected=[...filesOf(repo)]
  const expected=(await readdir(new URL('tests/',root))).filter(file=>file.endsWith('.test.js')).map(file=>'tests/'+file)
  assert.equal(new Set(selected).size,selected.length,'每份根测试只能归入一组')
  assert.deepEqual(selected.sort(),expected.sort(),'新增根测试必须显式选择正式工程或私有原型组')
})

test('正式测试入口保留版本、组合安全、容器与数据准备守卫',()=>{
  const repo=new Set(filesOf(manifest.scripts['test:repo']))
  for(const file of ['DSH版本声明','DSH组合安全钉','Dockerfile复制源','container-config','container-proxy','正式数据准备边界']){
    assert.ok(repo.has('tests/'+file+'.test.js'),file)
  }

})

test('公开 CI 执行正式工程测试',async()=>{
  const workflow=await readFile(new URL('.github/workflows/ci.yml',root),'utf8')
  assert.match(workflow,/run: pnpm test:repo/)
  assert.doesNotMatch(workflow,/run: pnpm test:prototype/)
  assert.ok(workflow.indexOf('run: pnpm setup:dsh')<workflow.indexOf('run: pnpm test:repo'),'组合测试前必须准备官方 profile')
})
